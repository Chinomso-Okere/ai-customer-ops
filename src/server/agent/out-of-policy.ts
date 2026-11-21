import type { Database } from "@/server/db/database";
import { describeWindow } from "@/server/scheduling/availability";
import type { ChangeableVisit } from "@/server/scheduling/visit-changes";
import { raiseHandoffTicket, type RaisedHandoffTicket } from "./handoff-tickets";
import type { AgentTurnContext } from "./types";

const QUOTE_LIMIT = 300;

/**
 * Server-side Out of Policy Escalations (#14): raised by the domain tools
 * themselves, so they never depend on the model choosing to escalate. Same
 * de-duplication as any Handoff Ticket (one open Out of Policy ticket per
 * conversation; repeats append).
 */
function raise(
  db: Database,
  ctx: AgentTurnContext,
  ticket: { summary: string; recommendedNextStep: string; customerId?: string | null; jobId?: string | null },
): Promise<RaisedHandoffTicket> {
  return raiseHandoffTicket(db, {
    sessionId: ctx.sessionId,
    conversationId: ctx.conversationId,
    reason: "Out of Policy",
    ...ticket,
    timelineEntry: `Customer: ${ctx.customerMessage.text.slice(0, QUOTE_LIMIT)}`,
    now: ctx.now,
  });
}

/** A reschedule or cancellation asked for within 24h of the Visit. Pass `tx` when inside a transaction. */
export function raiseLateChangeTicket(
  db: Database,
  ctx: AgentTurnContext,
  visit: ChangeableVisit,
  change: "reschedule" | "cancellation",
  customerId: string | null,
): Promise<RaisedHandoffTicket> {
  const when = describeWindow(visit);
  return raise(db, ctx, {
    summary: `Customer asked for a ${change} of the ${visit.issueType} Visit for ${visit.jobReference} on ${when}, which is within 24 hours.`,
    recommendedNextStep: `Contact the Customer about the late ${change}; a late-change fee may apply.`,
    customerId,
    jobId: visit.jobId,
  });
}

/** No Availability for the Issue Type within the 10-weekday horizon. */
export function raiseCapacityTicket(
  db: Database,
  ctx: AgentTurnContext,
  details: { issueType: string; postcode: string; customerId?: string | null; searchedUntil: string },
): Promise<RaisedHandoffTicket> {
  return raise(db, ctx, {
    summary: `No ${details.issueType} Availability for ${details.postcode} in the next 10 weekdays (searched until ${details.searchedUntil}).`,
    recommendedNextStep: "Contact the Customer to arrange a Visit outside normal capacity or beyond the booking horizon.",
    customerId: details.customerId ?? null,
  });
}

/** What a tool tells the model after a server-side Out of Policy Escalation. */
export function outOfPolicyGuidance(ticket: RaisedHandoffTicket, why: string): string {
  return `${why} This is Out of Policy, so it has been escalated: Handoff Ticket ${ticket.ticketReference}. Tell the Customer a member of the Apex team will contact them, and quote ${ticket.ticketReference}. Do not make the change yourself.`;
}
