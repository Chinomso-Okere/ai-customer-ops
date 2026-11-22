import { describeWindow, parseWindow, requireAvailableWindow } from "@/server/scheduling/availability";
import { proposeAction } from "../confirmation";
import { rescheduleAction, type ReschedulePayload } from "../confirmation/visit-changes";
import type { AgentTool } from "../types";
import { visitChangeableInChat } from "../visit-change-checks";

/** First phase of rescheduling a Visit (#14): checks the 24h policy and Availability, records a pending action. */
export const proposeReschedule: AgentTool = {
  name: "propose_reschedule",
  description:
    "Proposes moving one of a verified Customer's upcoming Visits (visitId from get_job_details) to another Time Window from get_availability. Visits within 24 hours can't be moved in chat: the request is escalated automatically and the result says so. Nothing changes yet: it returns a pendingActionId and the details to read back.",
  inputSchema: {
    type: "object",
    properties: {
      visitId: { type: "string", description: "The Visit to move: a visitId from get_job_details upcomingVisits" },
      date: { type: "string", format: "date", description: "The new date, YYYY-MM-DD, from get_availability" },
      timeWindow: { type: "string", enum: ["AM", "PM"] },
    },
    required: ["visitId", "date", "timeWindow"],
    additionalProperties: false,
  },
  promptGuidance:
    "To reschedule or cancel a Visit, verify the Customer, call get_job_details for the visitId, then (for a reschedule) get_availability with the issueType and postcode from get_job_details (don't ask the Customer for them) and, if the Customer named a day, that day as fromDate. Once the Customer has named a free window, call propose_reschedule in the same turn. Call propose_reschedule or propose_cancellation, read back the change and call confirm_action only after the Customer agrees. If a result has outOfPolicy: true, the change was not made: tell the Customer the Apex team will contact them (a late-change fee may apply) and quote the ticketReference.",
  async run(input, ctx) {
    const check = await visitChangeableInChat(ctx, input.visitId, "reschedule");
    if (check.refused) return check.refused;
    const { visit } = check;
    const window = parseWindow(input.date, input.timeWindow);
    if (!window) return { ok: false, error: "Give date as YYYY-MM-DD and timeWindow as AM or PM, from get_availability." };
    if (window.date === visit.date && window.timeWindow === visit.timeWindow) {
      return { ok: false, error: "That is the Visit's current Time Window. Ask the Customer which other window they want." };
    }
    const available = await requireAvailableWindow(ctx.db, ctx.sessionId, visit.issueType, window, ctx.now);
    if (!available.ok) return available;

    const from = { date: visit.date, timeWindow: visit.timeWindow };
    const payload: ReschedulePayload = { visitId: visit.visitId, date: window.date, timeWindow: window.timeWindow };
    const readBack = {
      jobReference: visit.jobReference,
      issueType: visit.issueType,
      from: { ...from, label: describeWindow(from) },
      to: { ...window, label: describeWindow(window) },
    };
    return proposeAction(ctx, rescheduleAction, {
      payload,
      readBack,
      guidance:
        "Nothing has changed yet. Read back the Visit's current and new date and Time Window and ask the Customer to confirm. Call confirm_action only after they agree.",
    });
  },
};
