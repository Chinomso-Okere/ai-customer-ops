import type { TimeWindow } from "@/domain/time-window";
import { describeWindow } from "@/server/scheduling/availability";
import { createVisit } from "@/server/scheduling/booking";
import { jobAwaitingFitting } from "@/server/scheduling/fitting-visit";
import type { PendingActionKind } from "./pending-actions";

/** What `propose_fitting_visit` stores, already validated. */
export interface FittingVisitPayload {
  jobId: string;
  date: string;
  timeWindow: TimeWindow;
}

/** Books the fitting Visit for a Job whose part has Arrived, returning the Job to Scheduled. */
export const fittingVisitAction: PendingActionKind<FittingVisitPayload> = {
  kind: "fitting_visit",
  async execute(tx, ctx, p) {
    const job = await jobAwaitingFitting(tx, ctx.sessionId, p.jobId);
    if (!job) {
      return { ok: false, error: "Not booked: this Job is no longer waiting for a fitting Visit. Call get_job_details for its current status." };
    }
    const window = { date: p.date, timeWindow: p.timeWindow };
    const visit = await createVisit(tx, ctx.sessionId, { jobId: p.jobId, issueType: job.issueType, window, now: ctx.now });
    if (!visit) {
      return {
        ok: false,
        error: `Not booked: ${describeWindow(window)} is no longer available. Apologise, call get_job_details for fresh windows and offer them.`,
      };
    }
    await tx.query(`UPDATE job SET job_status = 'Scheduled' WHERE session_id = $1 AND id = $2`, [ctx.sessionId, p.jobId]);
    return {
      ok: true,
      result: {
        booked: true,
        jobReference: job.jobReference,
        jobStatus: "Scheduled",
        partName: job.partName,
        date: p.date,
        timeWindow: p.timeWindow,
        label: describeWindow(window),
        engineerFirstName: visit.engineerName.split(" ")[0],
        guidance: "Confirm the fitting Visit's date and Time Window to the Customer.",
      },
    };
  },
};
