import { detectEmergency, type EmergencyKind } from "@/domain/emergency-prefilter";
import { getVerification } from "@/server/verification";
import { openEmergency } from "../emergency";
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

/** Every Emergency ticket needs a callback number, whether or not the postcode is in the Coverage Area. */
const contactNote = (ref: string) =>
  `Ask the Customer for their name and a phone number so the Apex team can call them back (wherever they are: safety comes before coverage), and as soon as they give them call create_handoff_ticket with reason Emergency, customerName and customerPhone to attach them to ${ref}. Promise a callback only once you have a number.`;

/** The mid-conversation system message telling the model what the open Emergency means for it. */
const EMERGENCY_NOTES: Record<EmergencyKind, (ticketReference: string) => string> = {
  gas_or_co: (ref) =>
    `Emergency (${LABELS.gas_or_co}): the Safety Script was shown and Critical Handoff Ticket ${ref} is open for this conversation. Apex doesn't fix gas leaks. Do not book, reschedule or offer any Visit in this conversation until an Operator resolves ${ref}: the booking tools will refuse. Keep pointing the Customer to the safety advice: leave the property and call National Gas Emergency on 0800 111 999, which comes before waiting for Apex. ${contactNote(ref)} If the Customer mentions it, quote ${ref}. You may still answer other questions.`,
  flood_or_sparks: (ref) =>
    `Emergency (${LABELS.flood_or_sparks}): the Safety Script was shown and Critical Handoff Ticket ${ref} is open for this conversation. Offer the Customer the earliest Emergency Visit: collect their full name, postcode, email, phone number and Issue Type, call propose_emergency_visit, read back its window and call confirm_action once they agree. An Emergency Visit may be booked even when normal Availability is full. ${contactNote(ref)} If the Customer mentions it, quote ${ref}.`,
};

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
  // The Customer details known so far: whoever this conversation is verified as.
  const { verifiedCustomerId } = await getVerification(ctx.db, ctx);
  const before = await openEmergency(ctx);
  const ticket = await raiseHandoffTicket(ctx.db, {
    customerId: verifiedCustomerId,
    sessionId: ctx.sessionId,
    conversationId: ctx.conversationId,
    reason: "Emergency",
    urgency: "Critical",
    summary: `${LABELS[kind]} reported in chat. Customer said: "${quoted}"`,
    recommendedNextStep: NEXT_STEPS[kind],
    timelineEntry: `Customer: ${quoted}`,
    emergencyKind: kind,
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
  // Tell the model (mid-conversation, never by editing the system prompt) when
  // the ticket opens, or when a flood/sparks Emergency turns out to be gas/CO.
  const kindNow = before?.emergencyKind === "gas_or_co" ? "gas_or_co" : kind;
  if (ticket.isNew || before?.emergencyKind !== kindNow) {
    await ctx.enqueueSystemNote(EMERGENCY_NOTES[kindNow](ticket.ticketReference));
  }

  const contactNeeded = !(ticket.contactName && ticket.contactPhone);
  const notice = emergencyNotice(kindNow, ticket, contactNeeded);
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
        payload: { ticketReference: ticket.ticketReference, isNewTicket: ticket.isNew, contactNeeded },
      },
    ],
    historyNote: `[Emergency pre-filter fired on "${detected.phrase}": ${kind} Safety Script shown; Critical Handoff Ticket ${ticket.ticketReference} ${ticket.isNew ? "created" : "updated"}.]`,
  };
};

/**
 * The fixed notice under the Safety Script (never model-written, ADR-0002).
 * It asks for a name and phone while the ticket has none, and promises a
 * callback only once it does. For gas/CO the Safety Script's National Gas
 * Emergency call stays the first action, not something to wait for Apex over.
 */
function emergencyNotice(
  kind: EmergencyKind,
  ticket: { ticketReference: string; isNew: boolean },
  contactNeeded: boolean,
): string {
  const { ticketReference } = ticket;
  if (!contactNeeded) {
    return ticket.isNew
      ? `I've raised an urgent ticket with our team: ${ticketReference}. They have your details and will call you.`
      : `Your urgent ticket ${ticketReference} is already with our team, and I've added this message to it.`;
  }
  const ask = "Please reply with your name and a phone number so the Apex team can call you back. We'll call once we have a number.";
  const first = kind === "gas_or_co" ? "Follow the safety steps above first: don't wait for us. " : "";
  const opening = ticket.isNew
    ? `I've raised an urgent ticket with our team: ${ticketReference}.`
    : `Your urgent ticket ${ticketReference} is already with our team, and I've added this message to it.`;
  return `${opening} ${first}${ask}`;
}
