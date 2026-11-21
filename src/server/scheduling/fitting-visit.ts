import { parseIssueType, type IssueType } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";
import { OFFERED_WINDOWS, findAvailability, windowForModel } from "./availability";

/** A Job whose part has Arrived and that is waiting for its fitting Visit to be booked. */
export interface FittingVisitJob {
  jobId: string;
  jobReference: string;
  issueType: IssueType;
  partName: string;
}

/**
 * The Job, if it is Awaiting Parts and one of its Parts Orders has Arrived:
 * the Job stays Awaiting Parts until a fitting Visit is booked.
 */
export async function jobAwaitingFitting(
  db: Database,
  sessionId: string,
  jobId: string,
): Promise<FittingVisitJob | undefined> {
  const { rows } = await db.query<{ job_reference: string; issue_type: string; part_name: string }>(
    `SELECT j.job_reference, j.issue_type, p.part_name
       FROM job j
       JOIN parts_order p ON p.job_id = j.id AND p.session_id = j.session_id
      WHERE j.session_id = $1 AND j.id = $2
        AND j.job_status = 'Awaiting Parts' AND p.parts_status = 'Arrived'
      ORDER BY p.created_at, p.id
      LIMIT 1`,
    [sessionId, jobId],
  );
  const row = rows[0];
  const issueType = row && parseIssueType(row.issue_type);
  if (!row || !issueType) return undefined;
  return { jobId, jobReference: row.job_reference, issueType, partName: row.part_name };
}

/** What `get_job_details` tells the model when the Job is awaiting its fitting Visit; null otherwise. */
export async function fittingVisitOffer(db: Database, sessionId: string, jobId: string, now: Date) {
  const job = await jobAwaitingFitting(db, sessionId, jobId);
  if (!job) return null;
  const windows = await findAvailability(db, sessionId, job.issueType, now, { limit: OFFERED_WINDOWS });
  return {
    partName: job.partName,
    windows: windows.map(windowForModel),
    guidance:
      windows.length > 0
        ? `Tell the Customer their ${job.partName} has arrived and offer to book the fitting Visit in one of these windows. When they pick one, call propose_fitting_visit.`
        : `Tell the Customer their ${job.partName} has arrived. No fitting Visit windows are free in the next 10 weekdays; offer Escalation so the team can arrange it.`,
  };
}
