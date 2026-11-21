import { ESCALATION_REASONS, URGENCIES, type Urgency } from "@/domain/vocabulary";
import { getVerification, verifiedJobId } from "@/server/verification";
import { DEFAULT_URGENCY, raiseHandoffTicket } from "../handoff-tickets";
import type { AgentTool } from "../types";

const QUOTE_LIMIT = 300;

/**
 * Escalation on the Agent's own judgment (#10): Complaints and Out of Policy
 * requests (Emergencies are normally caught by the pre-filter first). One open
 * ticket per reason per conversation; a repeat appends to it.
 */
export const createHandoffTicket: AgentTool = {
  name: "create_handoff_ticket",
  description:
    "Escalates to an Apex Operator by raising a Handoff Ticket. Call it when the Customer is angry or complaining (reason Complaint), or asks for something you may not grant: a refund, discount, compensation, or a price not on the Price List (reason Out of Policy). Call it again if they raise more about the same thing; it is added to the open ticket.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", enum: [...ESCALATION_REASONS], description: "Escalation Reason" },
      urgency: {
        type: "string",
        enum: [...URGENCIES],
        description:
          "Optional. Defaults to the reason's Urgency (Emergency Critical, Complaint High, Out of Policy Normal); you may raise it, never lower it.",
      },
      summary: { type: "string", description: "One or two sentences for the Operator: what happened and what the Customer wants." },
      recommendedNextStep: { type: "string", description: "What the Operator should do next." },
      jobReference: { type: "string", description: "The Job it concerns, if the Customer is verified for it." },
    },
    required: ["reason", "summary", "recommendedNextStep"],
    additionalProperties: false,
  },
  promptGuidance:
    "When you escalate, stop improvising on that topic: do not offer refunds, discounts, compensation or prices yourself. Tell the Customer a member of the Apex team will follow up and quote the ticketReference. The Customer may keep chatting about other things, but do not act on the escalated topic again; if they add to it, call create_handoff_ticket again with the same reason.",
  async run(input, ctx) {
    const reason = ESCALATION_REASONS.find((r) => r === input.reason);
    if (!reason) return { ok: false, error: `reason must be one of: ${ESCALATION_REASONS.join(", ")}.` };
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    const recommendedNextStep = typeof input.recommendedNextStep === "string" ? input.recommendedNextStep.trim() : "";
    if (!summary || !recommendedNextStep) return { ok: false, error: "summary and recommendedNextStep are required." };
    const urgency = parseUrgency(input.urgency);
    if (urgency === "invalid") return { ok: false, error: `urgency must be one of: ${URGENCIES.join(", ")}.` };
    if (urgency && isLessUrgent(urgency, DEFAULT_URGENCY[reason])) {
      return {
        ok: false,
        error: `Urgency cannot be lower than ${DEFAULT_URGENCY[reason]} for a ${reason} ticket. Omit urgency, or raise it.`,
      };
    }

    const { verifiedCustomerId } = await getVerification(ctx.db, ctx);
    const jobId =
      typeof input.jobReference === "string" && input.jobReference.trim()
        ? await verifiedJobId(ctx.db, ctx, input.jobReference)
        : null;

    const ticket = await raiseHandoffTicket(ctx.db, {
      sessionId: ctx.sessionId,
      conversationId: ctx.conversationId,
      reason,
      urgency,
      summary,
      recommendedNextStep,
      customerId: verifiedCustomerId,
      jobId,
      timelineEntry: `Customer: ${ctx.customerMessage.text.slice(0, QUOTE_LIMIT)}`,
      now: ctx.now,
    });

    if (ticket.isNew) {
      await ctx.enqueueSystemNote(
        `${reason} Handoff Ticket ${ticket.ticketReference} (${ticket.urgency}) is open for this conversation: an Apex team member will follow up. Do not act on or promise anything about the escalated topic yourself; quote ${ticket.ticketReference} if it comes up. Other topics can be handled as usual.`,
      );
    }

    return {
      ok: true,
      result: {
        ticketReference: ticket.ticketReference,
        escalationReason: reason,
        urgency: ticket.urgency,
        ticketAction: ticket.isNew ? "created" : "appended",
        guidance: `Tell the Customer a member of the Apex team will follow up, and quote ${ticket.ticketReference}. Do not act on this topic yourself.`,
      },
    };
  },
};

function parseUrgency(value: unknown): Urgency | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  return URGENCIES.find((u) => u === value) ?? "invalid";
}

function isLessUrgent(a: Urgency, b: Urgency): boolean {
  return URGENCIES.indexOf(a) > URGENCIES.indexOf(b);
}
