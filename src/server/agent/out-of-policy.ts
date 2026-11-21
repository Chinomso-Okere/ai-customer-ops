import type { Database } from "@/server/db/database";
import { describeWindow } from "@/server/scheduling/availability";
import type { ChangeableVisit } from "@/server/scheduling/visit-changes";
import { getVerification } from "@/server/verification";
import { raiseHandoffTicket, type RaisedHandoffTicket } from "./handoff-tickets";
import type { AgentTurnContext } from "./types";

const QUOTE_LIMIT = 300;

/**
 * Server-side Out of Policy Escalations (#14): raised by the domain tools
 * themselves, so they never depend on the model choosing to escalate. Same
 * de-duplication as any Handoff Ticket (one open Out of Policy ticket per
 * conversation; repeats append). `db` may be a transaction.
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

/** A reschedule or cancellation asked for within 24h of the Visit. */
export function raiseLateChangeTicket(
  db: Database,
  ctx: AgentTurnContext,
  visit: ChangeableVisit,
  change: "reschedule" | "cancellation",
  customerId: string | null,
): Promise<RaisedHandoffTicket> {
  return raise(db, ctx, {
    summary: `Customer asked for a ${change} of the ${visit.issueType} Visit for ${visit.jobReference} on ${describeWindow(visit)}, which is within 24 hours.`,
    recommendedNextStep: `Contact the Customer about the late ${change}; a late-change fee may apply.`,
    customerId,
    jobId: visit.jobId,
  });
}

/**
 * No Availability for the Issue Type within the 10-weekday horizon (for a
 * Booking or a reschedule): raises the capacity ticket and returns what
 * get_availability tells the model.
 */
export async function escalateCapacity(ctx: AgentTurnContext, issueType: string, postcode: string, searchedUntil: string) {
  const { verifiedCustomerId } = await getVerification(ctx.db, ctx);
  const ticket = await raise(ctx.db, ctx, {
    summary: `No ${issueType} Availability for ${postcode} in the next 10 weekdays (searched until ${searchedUntil}).`,
    recommendedNextStep: "Contact the Customer to arrange a Visit outside normal capacity or beyond the booking horizon.",
    customerId: verifiedCustomerId,
  });
  if (ticket.isNew) {
    await ctx.enqueueSystemNote(
      `Out of Policy Handoff Ticket ${ticket.ticketReference} is open for this conversation: no ${issueType} Availability in the next 10 weekdays, so an Apex team member will contact the Customer to arrange a Visit. Quote ${ticket.ticketReference}.`,
    );
  }
  return {
    outOfPolicy: true,
    reason: "capacity",
    ticketReference: ticket.ticketReference,
    guidance: outOfPolicyGuidance(
      ticket,
      `No ${issueType} Engineer is free in the next 10 weekdays.`,
      "Do not offer any date yourself. If you have the Customer's name and contact details, add them with create_handoff_ticket (reason Out of Policy) so the team can reach them.",
    ),
  };
}

/** What a tool tells the model after a server-side Out of Policy Escalation. */
export function outOfPolicyGuidance(
  ticket: RaisedHandoffTicket,
  why: string,
  instead = "Do not make the change yourself.",
): string {
  return `${why} This is Out of Policy, so it has been escalated: Handoff Ticket ${ticket.ticketReference}. Tell the Customer a member of the Apex team will contact them, and quote ${ticket.ticketReference}. ${instead}`;
}
