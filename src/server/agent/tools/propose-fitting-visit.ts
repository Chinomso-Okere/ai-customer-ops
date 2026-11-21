import { describeWindow, parseWindow, requireAvailableWindow } from "@/server/scheduling/availability";
import { jobAwaitingFitting } from "@/server/scheduling/fitting-visit";
import { getVerification, normaliseJobReference, verifiedJobId } from "@/server/verification";
import { proposeAction } from "../confirmation";
import type { FittingVisitPayload } from "../confirmation/fitting-visit";
import type { AgentTool } from "../types";

/** First phase of booking a fitting Visit (#12): validates and records a pending action. */
export const proposeFittingVisit: AgentTool = {
  name: "propose_fitting_visit",
  description:
    "Proposes booking the fitting Visit for a verified Customer's Job whose part has Arrived (get_job_details shows a fittingVisitOffer). Use a window from that offer. Nothing is booked yet: it returns a pendingActionId and the details to read back.",
  inputSchema: {
    type: "object",
    properties: {
      jobReference: { type: "string", description: "Job Reference, e.g. APX-10482" },
      date: { type: "string", format: "date", description: "The Visit date, YYYY-MM-DD, from fittingVisitOffer" },
      timeWindow: { type: "string", enum: ["AM", "PM"] },
    },
    required: ["jobReference", "date", "timeWindow"],
    additionalProperties: false,
  },
  promptGuidance:
    "When get_job_details returns a fittingVisitOffer, tell the Customer their part has arrived and offer its windows for the fitting Visit. Once they pick one, call propose_fitting_visit, read back the date and Time Window, and call confirm_action only after they agree.",
  async run(input, ctx) {
    const reference = typeof input.jobReference === "string" ? input.jobReference : "";
    const jobId = reference.trim() ? await verifiedJobId(ctx.db, ctx, reference) : null;
    if (!jobId) {
      const state = await getVerification(ctx.db, ctx);
      return {
        ok: false,
        error: state.verifiedCustomerId
          ? `${normaliseJobReference(reference)} is not one of the verified Customer's Jobs.`
          : "The Customer is not verified in this conversation. Call verify_customer first.",
      };
    }
    const job = await jobAwaitingFitting(ctx.db, ctx.sessionId, jobId);
    if (!job) {
      return {
        ok: false,
        error: "This Job isn't waiting for a fitting Visit (its part hasn't Arrived, or the fitting is already booked). Call get_job_details for its status.",
      };
    }
    const window = parseWindow(input.date, input.timeWindow);
    if (!window) return { ok: false, error: "Give date as YYYY-MM-DD and timeWindow as AM or PM, from fittingVisitOffer." };
    const check = await requireAvailableWindow(ctx.db, ctx.sessionId, job.issueType, window, ctx.now);
    if (!check.ok) return check;

    const payload: FittingVisitPayload = { jobId, date: window.date, timeWindow: window.timeWindow };
    const readBack = {
      jobReference: job.jobReference,
      partName: job.partName,
      date: window.date,
      timeWindow: window.timeWindow,
      label: describeWindow(window),
    };
    const pendingActionId = await proposeAction(ctx, { kind: "fitting_visit", payload, readBack });
    return {
      ok: true,
      result: {
        pendingActionId,
        readBack,
        guidance:
          "Nothing is booked yet. Read back the fitting Visit's date and Time Window and ask the Customer to confirm. Call confirm_action only after they agree.",
      },
    };
  },
};
