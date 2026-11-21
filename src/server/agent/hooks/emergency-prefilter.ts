import { detectEmergency, type EmergencyKind } from "@/domain/emergency-prefilter";
import { raiseHandoffTicket } from "../handoff-tickets";
import { SAFETY_SCRIPTS, safetyScriptText } from "../safety-scripts";
import type { PreModelHook } from "../types";

const LABELS: Record<EmergencyKind, string> = {
  gas_or_co: "Possible gas leak or carbon monoxide",
  flood_or_sparks: "Flooding or sparking",
};

const NEXT_STEPS: Record<EmergencyKind, string> = {
  gas_or_co:
    "Call the Customer now: confirm they have left the property and called National Gas Emergency (0800 111 999). Do not book a Visit until resolved.",
  flood_or_sparks:
    "Call the Customer now: confirm water/electricity is isolated and everyone is safe, then dispatch an Emergency Visit.",
};

const QUOTE_LIMIT = 300;

/**
 * The Emergency pre-filter (ADR-0002), on every Customer message before the
 * model: on a match, show the fixed Safety Script and raise (or append to) the
 * conversation's Critical Emergency Handoff Ticket. The model is not called.
 */
export const emergencyPrefilter: PreModelHook = async (ctx) => {
  const detected = detectEmergency(ctx.customerMessage.text);
  if (detected.match === "none") return undefined;

  const kind = detected.match;
  const script = SAFETY_SCRIPTS[kind];
  const quoted = ctx.customerMessage.text.slice(0, QUOTE_LIMIT);
  const ticket = await raiseHandoffTicket(ctx.db, {
    sessionId: ctx.sessionId,
    conversationId: ctx.conversationId,
    reason: "Emergency",
    urgency: "Critical",
    summary: `${LABELS[kind]} reported in chat. Customer said: "${quoted}"`,
    recommendedNextStep: NEXT_STEPS[kind],
    timelineEntry: `Customer: ${quoted}`,
    now: ctx.now,
  });

  await ctx.recordTrace({
    kind: "emergency_prefilter",
    input: { emergencyKind: kind, phrase: detected.phrase },
    result: JSON.stringify({
      safetyScriptShown: kind,
      ticketReference: ticket.ticketReference,
      urgency: ticket.urgency,
      ticketAction: ticket.isNew ? "created" : "appended",
    }),
  });
  if (ticket.isNew) {
    await ctx.enqueueSystemNote(
      `Emergency (${LABELS[kind]}): the Safety Script was shown and Critical Handoff Ticket ${ticket.ticketReference} is open for this conversation. If the Customer mentions it, quote ${ticket.ticketReference}.`,
    );
  }

  const notice = ticket.isNew
    ? `I've raised an urgent ticket with our team: ${ticket.ticketReference}. Someone will contact you as soon as possible.`
    : `Your urgent ticket ${ticket.ticketReference} is already with our team, and I've added this message to it.`;
  return {
    replies: [
      {
        kind: "safety_script",
        text: safetyScriptText(script),
        payload: { emergencyKind: kind, title: script.title, bullets: script.bullets },
      },
      {
        kind: "handoff_notice",
        text: notice,
        payload: { ticketReference: ticket.ticketReference, isNewTicket: ticket.isNew },
      },
    ],
    historyNote: `[Emergency pre-filter fired on "${detected.phrase}": ${kind} Safety Script shown; Critical Handoff Ticket ${ticket.ticketReference} ${ticket.isNew ? "created" : "updated"}.]`,
  };
};
