import { ISSUE_TYPES } from "@/domain/vocabulary";
import { describeWindow } from "@/server/scheduling/availability";
import { emergencyVisitWindow } from "@/server/scheduling/emergency-visit";
import { oneCustomerPerChatBlock } from "../chat-customer";
import { proposeAction } from "../confirmation";
import type { EmergencyVisitPayload } from "../confirmation/emergency-visit";
import { openEmergency } from "../emergency";
import type { AgentTool } from "../types";
import { parseBookingDetails } from "./propose-booking";

/**
 * First phase of booking an Emergency Visit (#13). Only during this
 * conversation's open flood/sparks Emergency; the window is the earliest one,
 * chosen server-side, regardless of normal capacity.
 */
export const proposeEmergencyVisit: AgentTool = {
  name: "propose_emergency_visit",
  description:
    "Proposes booking the earliest Emergency Visit, only while this conversation has an open flooding/sparks Emergency ticket. It may be booked even when normal Availability is full; the Time Window is chosen for you. Call it once you have the Customer's full name, postcode, email and Issue Type (phone optional). Nothing is booked yet: it returns a pendingActionId and the details to read back.",
  inputSchema: {
    type: "object",
    properties: {
      fullName: { type: "string", description: "The Customer's full name" },
      postcode: { type: "string", description: "The property's full UK postcode" },
      email: { type: "string", description: "The Customer's email address" },
      issueType: { type: "string", enum: [...ISSUE_TYPES] },
      phone: { type: "string", description: "Optional phone number, only if the Customer gave one" },
      problemSummary: { type: "string", description: "Optional one-line description of the Emergency, in the Customer's terms" },
    },
    required: ["fullName", "postcode", "email", "issueType"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const emergency = await openEmergency(ctx);
    if (emergency?.emergencyKind !== "flood_or_sparks") {
      return {
        ok: false,
        error:
          "Refused: an Emergency Visit is only for an open flooding or sparks Emergency in this conversation. For anything else, use get_availability and propose_booking.",
      };
    }
    const details = parseBookingDetails(input);
    if (!details.ok) return details;
    const otherCustomer = await oneCustomerPerChatBlock(ctx.db, ctx, details);
    if (otherCustomer) return otherCustomer;

    const window = emergencyVisitWindow(ctx.now);
    const payload: EmergencyVisitPayload = {
      fullName: details.fullName,
      postcode: details.postcode,
      email: details.email,
      phone: details.phone,
      issueType: details.issueType,
      description: details.description,
      date: window.date,
      timeWindow: window.timeWindow,
    };
    const readBack = {
      emergencyVisit: true,
      issueType: details.issueType,
      postcode: details.postcode,
      date: window.date,
      timeWindow: window.timeWindow,
      label: describeWindow(window),
      fullName: details.fullName,
      email: details.email,
      phone: details.phone,
      ticketReference: emergency.ticketReference,
    };
    const pendingActionId = await proposeAction(ctx, { kind: "emergency_visit", payload, readBack });
    return {
      ok: true,
      result: {
        pendingActionId,
        readBack,
        guidance:
          "Nothing is booked yet. Read back that this is an Emergency Visit, with the Issue Type, postcode, date and Time Window, and ask the Customer to confirm. Call confirm_action only after they agree.",
      },
    };
  },
};
