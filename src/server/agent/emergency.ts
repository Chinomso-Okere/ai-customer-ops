import type { EmergencyKind } from "@/domain/emergency-prefilter";
import { handoffTicketReference } from "@/server/demo-session/dashboard-state";
import type { AgentTool, AgentTurnContext, ToolOutcome } from "./types";

export interface OpenEmergency {
  ticketId: string;
  ticketReference: string;
  emergencyKind: EmergencyKind;
}

/** The conversation's open (not Resolved) Emergency Handoff Ticket, if any. */
export async function openEmergency(
  ctx: Pick<AgentTurnContext, "db" | "sessionId" | "conversationId">,
): Promise<OpenEmergency | undefined> {
  const { rows } = await ctx.db.query<{ id: string; ticket_number: number; emergency_kind: EmergencyKind | null }>(
    `SELECT id, ticket_number, emergency_kind FROM handoff_ticket
      WHERE session_id = $1 AND conversation_id = $2
        AND escalation_reason = 'Emergency' AND status <> 'Resolved'
      ORDER BY ticket_number DESC LIMIT 1`,
    [ctx.sessionId, ctx.conversationId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    ticketId: row.id,
    ticketReference: handoffTicketReference(row.ticket_number),
    // A pre-#13 Emergency ticket has no kind: fail safe, treat it as gas/CO.
    emergencyKind: row.emergency_kind ?? "gas_or_co",
  };
}

/**
 * The gas/CO booking block, enforced server-side: while the conversation's
 * gas/CO Emergency ticket is unresolved, nothing may be booked. Returns the
 * refusal for the model, or undefined when booking is allowed.
 */
export async function gasEmergencyBookingBlock(
  ctx: Pick<AgentTurnContext, "db" | "sessionId" | "conversationId">,
): Promise<ToolOutcome | undefined> {
  const emergency = await openEmergency(ctx);
  if (emergency?.emergencyKind !== "gas_or_co") return undefined;
  return {
    ok: false,
    error: `Refused: Emergency ticket ${emergency.ticketReference} (possible gas leak or carbon monoxide) is open, so nothing can be booked in this conversation until an Operator resolves it. Apex doesn't fix gas leaks. Tell the Customer to follow the safety advice: leave the property and call National Gas Emergency on 0800 111 999. Quote ${emergency.ticketReference}.`,
  };
}

/** Wraps a booking tool so it refuses during an unresolved gas/CO Emergency. */
export function blockedDuringGasEmergency(tool: AgentTool): AgentTool {
  return {
    ...tool,
    async run(input, ctx) {
      return (await gasEmergencyBookingBlock(ctx)) ?? tool.run(input, ctx);
    },
  };
}
