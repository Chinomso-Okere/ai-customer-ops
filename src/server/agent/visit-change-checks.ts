import { describeWindow } from "@/server/scheduling/availability";
import { changeNotice, findVisit, type ChangeableVisit } from "@/server/scheduling/visit-changes";
import { getVerification, isVerifiedForJob } from "@/server/verification";
import { outOfPolicyGuidance, raiseLateChangeTicket } from "./out-of-policy";
import { TOOL_ERRORS, type AgentTurnContext, type ToolOutcome } from "./types";

export type VisitChange = "reschedule" | "cancellation";

/**
 * The checks shared by propose_reschedule and propose_cancellation: the
 * conversation is verified for the Visit's Job, the Visit hasn't started, and
 * it is more than 24h away. Within 24h the request is escalated server-side
 * (Out of Policy) and `refused` carries that outcome for the tool to return.
 */
export async function visitChangeableInChat(
  ctx: AgentTurnContext,
  visitId: unknown,
  change: VisitChange,
): Promise<{ visit: ChangeableVisit; refused?: undefined } | { refused: ToolOutcome }> {
  const state = await getVerification(ctx.db, ctx);
  if (!state.verifiedCustomerId) {
    return { refused: TOOL_ERRORS.notVerified };
  }
  const visit = typeof visitId === "string" ? await findVisit(ctx.db, ctx.sessionId, visitId.trim()) : undefined;
  if (!visit || !(await isVerifiedForJob(ctx.db, ctx, visit.jobReference))) {
    return {
      refused: {
        ok: false,
        error: "No such upcoming Visit for the verified Customer. Call get_job_details and use a visitId from upcomingVisits.",
      },
    };
  }
  const notice = changeNotice(visit, ctx.now);
  if (notice === "started") {
    return {
      refused: { ok: false, error: `The Visit on ${describeWindow(visit)} has already started or taken place; it can't be changed.` },
    };
  }
  if (notice === "late") {
    const ticketReference = await escalateLateChange(ctx.db, ctx, visit, change);
    if (ticketReference.isNew) {
      await ctx.enqueueSystemNote(
        `Out of Policy Handoff Ticket ${ticketReference.ticketReference} is open for this conversation: an Apex team member will contact the Customer about the late ${change}. Do not change that Visit yourself; quote ${ticketReference.ticketReference} if it comes up.`,
      );
    }
    return { refused: ticketReference.outcome };
  }
  return { visit };
}

/**
 * Raises (or appends to) the Out of Policy ticket for a change within 24h of
 * the Visit, and returns the tool outcome that reports it. `db` may be a
 * transaction (from confirm_action, when the 24h mark passed after proposing).
 */
export async function escalateLateChange(
  db: AgentTurnContext["db"],
  ctx: AgentTurnContext,
  visit: ChangeableVisit,
  change: VisitChange,
): Promise<{ ticketReference: string; isNew: boolean; outcome: ToolOutcome }> {
  const { verifiedCustomerId } = await getVerification(db, ctx);
  const ticket = await raiseLateChangeTicket(db, ctx, visit, change, verifiedCustomerId);
  const why = `The Visit on ${describeWindow(visit)} starts within 24 hours, so the ${change} can't be made in chat (a late-change fee may apply).`;
  return {
    ticketReference: ticket.ticketReference,
    isNew: ticket.isNew,
    outcome: {
      ok: true,
      result: {
        changed: false,
        outOfPolicy: true,
        reason: `${change} within 24 hours of the Visit`,
        jobReference: visit.jobReference,
        ticketReference: ticket.ticketReference,
        guidance: outOfPolicyGuidance(ticket, why),
      },
    },
  };
}
