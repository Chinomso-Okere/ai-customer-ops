import type { EmergencyKind } from "@/domain/emergency-prefilter";
import { URGENCIES, type EscalationReason, type HandoffTicketStatus, type Urgency } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";
import { lockDemoSession } from "@/server/db/session-lock";
import { handoffTicketReference, type HandoffTicketEvent } from "@/server/demo-session/dashboard-state";
import { HandoffTicketNotFoundError, HandoffTicketStateError } from "@/server/demo-session/errors";

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
  /** For an Emergency: which kind. Gas/CO, once reported, sticks to the ticket. */
  emergencyKind?: EmergencyKind;
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
    await lockDemoSession(tx, sessionId);

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
                job_id = COALESCE(job_id, $5),
                emergency_kind = CASE WHEN $6::text = 'gas_or_co' THEN $6 ELSE COALESCE(emergency_kind, $6) END
          WHERE session_id = $1 AND id = $2`,
        [sessionId, existing.id, urgency, input.customerId ?? null, input.jobId ?? null, input.emergencyKind ?? null],
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
                                   escalation_reason, urgency, status, summary, recommended_next_step, created_at,
                                   emergency_kind)
       SELECT $1, $2, COALESCE(MAX(ticket_number), 0) + 1, $3, $4, $5, $6, 'Open', $7, $8, $9, $10
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
        input.emergencyKind ?? null,
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

/** Operator actions on a Handoff Ticket, and the status each moves it to. */
export type HandoffTicketAction = "acknowledge" | "resolve";

const TRANSITIONS: Record<HandoffTicketAction, { from: HandoffTicketStatus[]; to: HandoffTicketStatus; event: HandoffTicketEvent["kind"] }> = {
  acknowledge: { from: ["Open"], to: "Acknowledged", event: "acknowledged" },
  resolve: { from: ["Open", "Acknowledged"], to: "Resolved", event: "resolved" },
};

/**
 * An Operator acknowledges or resolves a Handoff Ticket (seed or chat-raised).
 * Repeating the same action is a no-op. Resolving frees the conversation's
 * slot for that Escalation Reason, so a later escalation opens a new ticket.
 * @throws HandoffTicketNotFoundError if the ticket isn't in this Demo Session
 * @throws HandoffTicketStateError e.g. acknowledging a Resolved ticket
 */
export async function changeHandoffTicketStatus(
  db: Database,
  input: { sessionId: string; ticketId: string; action: HandoffTicketAction; now: Date },
): Promise<HandoffTicketStatus> {
  const { sessionId, ticketId, now } = input;
  const transition = TRANSITIONS[input.action];
  if (!UUID.test(ticketId)) throw new HandoffTicketNotFoundError(ticketId);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ status: HandoffTicketStatus }>(
      "SELECT status FROM handoff_ticket WHERE session_id = $1 AND id = $2 FOR UPDATE",
      [sessionId, ticketId],
    );
    const current = rows[0]?.status;
    if (!current) throw new HandoffTicketNotFoundError(ticketId);
    if (current === transition.to) return current;
    if (!transition.from.includes(current)) {
      throw new HandoffTicketStateError(`Cannot ${input.action} a ${current} Handoff Ticket.`);
    }
    await tx.query("UPDATE handoff_ticket SET status = $3 WHERE session_id = $1 AND id = $2", [
      sessionId,
      ticketId,
      transition.to,
    ]);
    await addEvent(tx, sessionId, ticketId, transition.event, `${transition.to} by an Operator`, now);
    return transition.to;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function addEvent(
  tx: Database,
  sessionId: string,
  ticketId: string,
  kind: HandoffTicketEvent["kind"],
  text: string,
  now: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO handoff_ticket_event (session_id, ticket_id, kind, text, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, ticketId, kind, text, now],
  );
}
