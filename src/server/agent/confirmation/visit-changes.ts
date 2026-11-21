import type { TimeWindow } from "@/domain/time-window";
import { describeWindow } from "@/server/scheduling/availability";
import { cancelVisit, changeNotice, findVisit, moveVisit } from "@/server/scheduling/visit-changes";
import { escalateLateChange } from "../visit-change-checks";
import type { PendingActionKind } from "./pending-actions";

/** What `propose_reschedule` stores, already validated. */
export interface ReschedulePayload {
  visitId: string;
  date: string;
  timeWindow: TimeWindow;
}

/** What `propose_cancellation` stores, already validated. */
export interface CancellationPayload {
  visitId: string;
}

const GONE = {
  ok: false,
  error: "This Visit has changed since it was proposed (moved or cancelled). Call get_job_details for its current details.",
} as const;

/** Moves an existing Visit to another Time Window (the Job stays the same). */
export const rescheduleAction: PendingActionKind<ReschedulePayload> = {
  kind: "reschedule",
  async execute(tx, ctx, p) {
    const visit = await findVisit(tx, ctx.sessionId, p.visitId);
    if (!visit) return GONE;
    // The 24h mark may have passed since the proposal.
    if (changeNotice(visit, ctx.now) !== "ok") return (await escalateLateChange(tx, ctx, visit, "reschedule")).outcome;
    const from = { date: visit.date, timeWindow: visit.timeWindow };
    const to = { date: p.date, timeWindow: p.timeWindow };
    const moved = await moveVisit(tx, ctx.sessionId, visit, to, ctx.now);
    if (!moved) {
      return {
        ok: false,
        error: `Not rescheduled: ${describeWindow(to)} is no longer available. Apologise, call get_availability and offer new windows.`,
      };
    }
    return {
      ok: true,
      result: {
        changed: true,
        rescheduled: true,
        jobReference: visit.jobReference,
        from: { ...from, label: describeWindow(from) },
        to: { ...to, label: describeWindow(to) },
        engineerFirstName: moved.engineerName.split(" ")[0],
        guidance: "Confirm the new date and Time Window to the Customer.",
      },
    };
  },
};

/** Cancels a Visit; the Job becomes Cancelled if it has no upcoming Visits left. */
export const cancellationAction: PendingActionKind<CancellationPayload> = {
  kind: "cancellation",
  async execute(tx, ctx, p) {
    const visit = await findVisit(tx, ctx.sessionId, p.visitId);
    if (!visit) return GONE;
    if (changeNotice(visit, ctx.now) !== "ok") return (await escalateLateChange(tx, ctx, visit, "cancellation")).outcome;
    const { jobStatus } = await cancelVisit(tx, ctx.sessionId, visit, ctx.now);
    return {
      ok: true,
      result: {
        changed: true,
        cancelled: true,
        jobReference: visit.jobReference,
        date: visit.date,
        timeWindow: visit.timeWindow,
        label: describeWindow(visit),
        jobStatus,
        guidance: "Confirm the cancellation to the Customer.",
      },
    };
  },
};
