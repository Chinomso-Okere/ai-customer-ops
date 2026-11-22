import { normaliseUkPhone } from "@/domain/uk-phone";
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
    "Escalates to an Apex Operator by raising a Handoff Ticket. Call it when the Customer is angry or complaining (reason Complaint), or asks for something you may not grant: a refund, discount, compensation, or a price not on the Price List (reason Out of Policy). Call it again if they raise more about the same thing; it is added to the open ticket. For an Emergency, call it again with reason Emergency and customerName and customerPhone as soon as the Customer gives them: they are attached to the open Emergency ticket.",
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
      customerName: {
        type: ["string", "null"],
        description: "The Customer's name for the callback, if they gave it; otherwise null.",
      },
      customerPhone: {
        type: ["string", "null"],
        description:
          "The Customer's phone number for the callback, exactly as they typed it, if they gave it; otherwise null.",
      },
    },
    required: ["reason", "summary", "recommendedNextStep", "customerName", "customerPhone"],
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
    const contactName = typeof input.customerName === "string" && input.customerName.trim() ? input.customerName.trim() : null;
    const rawPhone = typeof input.customerPhone === "string" ? input.customerPhone.trim() : "";
    const contactPhone = rawPhone ? normaliseUkPhone(rawPhone) ?? null : null;
    if (rawPhone && !contactPhone) {
      return {
        ok: false,
        code: "invalid_phone",
        error: "That doesn't look like a UK phone number. Ask the Customer to check it and give it again; nothing was saved.",
      };
    }
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
      contactName,
      contactPhone,
      timelineEntry:
        contactName || contactPhone
          ? `Customer gave contact details: ${[contactName, contactPhone].filter(Boolean).join(", ")}`
          : `Customer: ${ctx.customerMessage.text.slice(0, QUOTE_LIMIT)}`,
      now: ctx.now,
    });

    if (ticket.isNew) {
      await ctx.enqueueSystemNote(
        `${reason} Handoff Ticket ${ticket.ticketReference} (${ticket.urgency}) is open for this conversation: an Apex team member will follow up. Do not act on or promise anything about the escalated topic yourself; quote ${ticket.ticketReference} if it comes up. Other topics can be handled as usual.`,
      );
    }

    // An Emergency callback needs both a name and a number.
    const contactStillNeeded = reason === "Emergency" && !(ticket.contactName && ticket.contactPhone);
    return {
      ok: true,
      result: {
        ticketReference: ticket.ticketReference,
        escalationReason: reason,
        urgency: ticket.urgency,
        ticketAction: ticket.isNew ? "created" : "appended",
        contactStillNeeded,
        guidance: contactStillNeeded
          ? `Ask the Customer for their name and a phone number so the Apex team can call them back, then call create_handoff_ticket again with reason Emergency and those details. Quote ${ticket.ticketReference}. Do not promise a callback until you have a number.`
          : `Tell the Customer a member of the Apex team will follow up, and quote ${ticket.ticketReference}. Do not act on this topic yourself.`,
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
