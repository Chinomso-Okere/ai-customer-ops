import { formatPostcode, isInCoverageArea, normalisePostcode, outwardCode } from "@/domain/coverage-area";
import { ISSUE_TYPES, parseIssueType, type IssueType } from "@/domain/vocabulary";
import { describeWindow, parseWindow, requireAvailableWindow } from "@/server/scheduling/availability";
import { proposeAction } from "../confirmation";
import { bookingAction, type BookingPayload } from "../confirmation/booking";
import { TOOL_ERRORS, type AgentTool, type ToolOutcome } from "../types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** First phase of Booking: validates everything and records a pending action. Writes nothing else. */
export const proposeBooking: AgentTool = {
  name: "propose_booking",
  description:
    "Proposes Booking a new Job and its first Visit in a Time Window from get_availability. Call it once you have the Customer's full name, postcode, email and Issue Type (phone is optional) and they have picked a window. Nothing is booked yet: it returns a pendingActionId and the details to read back.",
  inputSchema: {
    type: "object",
    properties: {
      fullName: { type: "string", description: "The Customer's full name" },
      postcode: { type: "string", description: "The property's full UK postcode" },
      email: { type: "string", description: "The Customer's email address" },
      issueType: { type: "string", enum: [...ISSUE_TYPES] },
      date: { type: "string", format: "date", description: "The Visit date, YYYY-MM-DD, from get_availability" },
      timeWindow: { type: "string", enum: ["AM", "PM"] },
      phone: { type: "string", description: "Optional phone number, only if the Customer gave one" },
      problemSummary: { type: "string", description: "Optional one-line description of the problem, in the Customer's terms" },
    },
    required: ["fullName", "postcode", "email", "issueType", "date", "timeWindow"],
    additionalProperties: false,
  },
  promptGuidance:
    "To Book: collect full name, postcode, Issue Type and email (phone optional), call get_availability and offer its windows (never invent dates), then call propose_booking with the chosen window. If the Customer has already named a day or window, call get_availability with that day as fromDate; if their window is free, call propose_booking for it in the same turn rather than asking them to choose again. Read back the Issue Type, postcode, date and Time Window and ask the Customer to confirm before calling confirm_action. One chat is about one Customer: if propose_booking is refused with the errorCode one_customer_per_chat, tell the Customer this chat can only help with one Customer, ask them to check what they typed for typos, and, if the Booking is for someone else, to start a new chat for it. Never say whether the details they gave belong to anyone. More Jobs for the same Customer are fine.",
  async run(input, ctx) {
    const details = parseBookingDetails(input);
    if (!details.ok) return details;
    const { fullName, email, issueType, postcode, phone, description } = details;
    const window = parseWindow(input.date, input.timeWindow);
    if (!window) return { ok: false, error: "Give date as YYYY-MM-DD and timeWindow as AM or PM, from get_availability." };
    const check = await requireAvailableWindow(ctx.db, ctx.sessionId, issueType, window, ctx.now);
    if (!check.ok) return check;

    const payload: BookingPayload = {
      fullName,
      postcode,
      email,
      phone,
      issueType,
      description,
      date: window.date,
      timeWindow: window.timeWindow,
    };
    const readBack = {
      issueType,
      postcode: payload.postcode,
      date: window.date,
      timeWindow: window.timeWindow,
      label: describeWindow(window),
      fullName,
      email,
      phone,
    };
    return proposeAction(ctx, bookingAction, {
      payload,
      readBack,
      guidance:
        "Nothing is booked yet. Read back the Issue Type, postcode, date and Time Window and ask the Customer to confirm. Call confirm_action only after they agree.",
    });
  },
};

/**
 * Validates the Customer details a Booking needs (also used for an Emergency
 * Visit). `postcode` comes back in display form, e.g. "SW4 9ZZ".
 */
export function parseBookingDetails(input: Record<string, unknown>):
  | Extract<ToolOutcome, { ok: false }>
  | { ok: true; fullName: string; email: string; issueType: IssueType; postcode: string; phone: string | null; description: string } {
  const fullName = typeof input.fullName === "string" ? input.fullName.replace(/\s+/g, " ").trim() : "";
  if (!fullName) return { ok: false, error: "Ask the Customer for their full name." };
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return { ok: false, error: "That email address doesn't look valid. Ask the Customer for it again." };
  const issueType = parseIssueType(input.issueType);
  if (!issueType) return { ok: false, error: `Unknown Issue Type. Use one of: ${ISSUE_TYPES.join(", ")}.` };
  const postcode = typeof input.postcode === "string" ? normalisePostcode(input.postcode) : "";
  if (postcode.length < 5) return { ok: false, error: "Ask the Customer for their full postcode." };
  if (!isInCoverageArea(postcode)) {
    return TOOL_ERRORS.outsideCoverageArea(outwardCode(postcode));
  }
  const phone = typeof input.phone === "string" && input.phone.trim() ? input.phone.trim() : null;
  const summary = typeof input.problemSummary === "string" ? input.problemSummary.trim() : "";
  return { ok: true, fullName, email, issueType, postcode: formatPostcode(postcode), phone, description: summary || issueType };
}
