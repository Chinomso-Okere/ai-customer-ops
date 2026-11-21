import { URGENCIES, type EscalationReason, type Urgency } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";
import { handoffTicketReference } from "@/server/demo-session/dashboard-state";

/** Escalation Reason → default (and minimum) Urgency. */
export const DEFAULT_URGENCY: Readonly<Record<EscalationReason, Urgency>> = {
  Emergency: "Critical",
  Complaint: "High",
  "Out of Policy": "Normal",
};

export interface RaiseHandoffTicketInput {
  sessionId: string;
  conversationId: string;
  reason: EscalationReason;
  /** Defaults to the reason's Urgency; never ends up below it or below the open ticket's. */
  urgency?: Urgency;
  summary: string;
  recommendedNextStep: string;
  /** The Customer, if known so far (e.g. after Verification). */
  customerId?: string | null;
  jobId?: string | null;
  /** What this escalation adds to the ticket's timeline, e.g. the Customer's words. */
  timelineEntry: string;
  now: Date;
}

export interface RaisedHandoffTicket {
  ticketId: string;
  /** e.g. "APX-H-0003": quote it to the Customer. */
  ticketReference: string;
  urgency: Urgency;
  /** False when an open ticket for this reason already existed and was appended to. */
  isNew: boolean;
}

/**
 * Raises a Handoff Ticket, de-duplicated: at most one open (not Resolved)
 * ticket per Escalation Reason per conversation. A repeat appends to that
 * ticket's timeline (raising its Urgency if asked, never lowering it) instead
 * of creating another.
 */
export async function raiseHandoffTicket(
  db: Database,
  input: RaiseHandoffTicketInput,
): Promise<RaisedHandoffTicket> {
  const { sessionId, conversationId, reason, now } = input;
  return db.transaction(async (tx) => {
    // Serialises ticket numbering (and the open-ticket check) within the Demo Session.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);

    const open = await tx.query<{ id: string; ticket_number: number; urgency: Urgency }>(
      `SELECT id, ticket_number, urgency FROM handoff_ticket
        WHERE session_id = $1 AND conversation_id = $2 AND escalation_reason = $3
          AND status <> 'Resolved'`,
      [sessionId, conversationId, reason],
    );
    const existing = open.rows[0];
    const urgency = mostUrgent(DEFAULT_URGENCY[reason], input.urgency, existing?.urgency);

    if (existing) {
      await tx.query(
        `UPDATE handoff_ticket
            SET urgency = $3,
                customer_id = COALESCE(customer_id, $4),
                job_id = COALESCE(job_id, $5)
          WHERE session_id = $1 AND id = $2`,
        [sessionId, existing.id, urgency, input.customerId ?? null, input.jobId ?? null],
      );
      await addEvent(tx, sessionId, existing.id, "appended", input.timelineEntry, now);
      return {
        ticketId: existing.id,
        ticketReference: handoffTicketReference(existing.ticket_number),
        urgency,
        isNew: false,
      };
    }

    const created = await tx.query<{ id: string; ticket_number: number }>(
      `INSERT INTO handoff_ticket (session_id, conversation_id, ticket_number, customer_id, job_id,
                                   escalation_reason, urgency, status, summary, recommended_next_step, created_at)
       SELECT $1, $2, COALESCE(MAX(ticket_number), 0) + 1, $3, $4, $5, $6, 'Open', $7, $8, $9
         FROM handoff_ticket WHERE session_id = $1
       RETURNING id, ticket_number`,
      [
        sessionId,
        conversationId,
        input.customerId ?? null,
        input.jobId ?? null,
        reason,
        urgency,
        input.summary,
        input.recommendedNextStep,
        now,
      ],
    );
    const ticket = created.rows[0]!;
    await addEvent(tx, sessionId, ticket.id, "created", input.timelineEntry, now);
    return {
      ticketId: ticket.id,
      ticketReference: handoffTicketReference(ticket.ticket_number),
      urgency,
      isNew: true,
    };
  });
}

function mostUrgent(...urgencies: Array<Urgency | undefined>): Urgency {
  const ranks = urgencies.filter((u): u is Urgency => !!u).map((u) => URGENCIES.indexOf(u));
  return URGENCIES[Math.min(...ranks)]!;
}

async function addEvent(
  tx: Database,
  sessionId: string,
  ticketId: string,
  kind: "created" | "appended",
  text: string,
  now: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO handoff_ticket_event (session_id, ticket_id, kind, text, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, ticketId, kind, text, now],
  );
}
