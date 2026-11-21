import { londonDateOf } from "@/domain/london-time";
import { timeWindowStart, type TimeWindow } from "@/domain/time-window";
import { parseIssueType, type IssueType } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";
import { lockDemoSession } from "@/server/db/session-lock";
import { checkWindowAvailable, type CandidateWindow } from "./availability";

/**
 * A Visit can be rescheduled or cancelled in chat only if it starts more than
 * this long from now; otherwise the change is Out of Policy (late-change fee
 * may apply) and goes to an Operator.
 */
export const LATE_CHANGE_NOTICE_MS = 24 * 60 * 60 * 1000;

/** A Visit that a Customer might reschedule or cancel. */
export interface ChangeableVisit {
  visitId: string;
  jobId: string;
  jobReference: string;
  jobStatus: string;
  issueType: IssueType;
  date: string;
  timeWindow: TimeWindow;
  isEmergencyVisit: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The (not cancelled) Visit with this id in the Demo Session, if any. */
export async function findVisit(db: Database, sessionId: string, visitId: string): Promise<ChangeableVisit | undefined> {
  if (!UUID.test(visitId)) return undefined;
  const { rows } = await db.query<{
    job_id: string;
    job_reference: string;
    job_status: string;
    issue_type: string;
    visit_date: string;
    time_window: TimeWindow;
    is_emergency_visit: boolean;
  }>(
    `SELECT v.job_id, j.job_reference, j.job_status, j.issue_type, v.visit_date::text AS visit_date,
            v.time_window, v.is_emergency_visit
       FROM visit v
       JOIN job j ON j.id = v.job_id AND j.session_id = v.session_id
      WHERE v.session_id = $1 AND v.id = $2 AND v.cancelled_at IS NULL`,
    [sessionId, visitId],
  );
  const row = rows[0];
  const issueType = row && parseIssueType(row.issue_type);
  if (!row || !issueType) return undefined;
  return {
    visitId,
    jobId: row.job_id,
    jobReference: row.job_reference,
    jobStatus: row.job_status,
    issueType,
    date: row.visit_date,
    timeWindow: row.time_window,
    isEmergencyVisit: row.is_emergency_visit,
  };
}

/** Where `now` stands relative to the Visit: already started, within 24h, or changeable in chat. */
export function changeNotice(visit: CandidateWindow, now: Date): "started" | "late" | "ok" {
  const untilStart = timeWindowStart(visit.date, visit.timeWindow).getTime() - now.getTime();
  if (untilStart <= 0) return "started";
  return untilStart <= LATE_CHANGE_NOTICE_MS ? "late" : "ok";
}

/**
 * Moves the Visit to `window`, assigned to the first free skilled Engineer
 * there. Returns the Engineer's name, or undefined (writing nothing) if the
 * window has no Availability. Call inside a transaction.
 */
export async function moveVisit(
  tx: Database,
  sessionId: string,
  visit: ChangeableVisit,
  window: CandidateWindow,
  now: Date,
): Promise<{ engineerName: string } | undefined> {
  await lockDemoSession(tx, sessionId);
  const available = await checkWindowAvailable(tx, sessionId, visit.issueType, window, now);
  const engineerId = available?.freeEngineerIds[0];
  if (!engineerId) return undefined;
  const { rows } = await tx.query<{ engineer_name: string }>(
    `UPDATE visit SET engineer_id = $3, visit_date = $4, time_window = $5
      WHERE session_id = $1 AND id = $2 AND cancelled_at IS NULL
      RETURNING (SELECT name FROM engineer WHERE id = $3 AND session_id = $1) AS engineer_name`,
    [sessionId, visit.visitId, engineerId, window.date, window.timeWindow],
  );
  const row = rows[0];
  return row ? { engineerName: row.engineer_name } : undefined;
}

/**
 * Cancels the Visit. If the Job then has no upcoming Visits: a Job whose part
 * has Arrived goes back to Awaiting Parts (its fitting Visit can be booked
 * again); a Scheduled Job becomes Cancelled. Returns the Job's Job Status.
 * Call inside a transaction.
 */
export async function cancelVisit(
  tx: Database,
  sessionId: string,
  visit: ChangeableVisit,
  now: Date,
): Promise<{ jobStatus: string }> {
  await lockDemoSession(tx, sessionId);
  await tx.query(`UPDATE visit SET cancelled_at = $3 WHERE session_id = $1 AND id = $2`, [sessionId, visit.visitId, now]);
  const { rows } = await tx.query<{ job_status: string; upcoming: number; part_arrived: boolean }>(
    `SELECT j.job_status,
            (SELECT count(*)::int FROM visit v
              WHERE v.session_id = j.session_id AND v.job_id = j.id
                AND v.cancelled_at IS NULL AND v.visit_date >= $3::date) AS upcoming,
            EXISTS (SELECT 1 FROM parts_order p
                     WHERE p.session_id = j.session_id AND p.job_id = j.id AND p.parts_status = 'Arrived') AS part_arrived
       FROM job j WHERE j.session_id = $1 AND j.id = $2`,
    [sessionId, visit.jobId, londonDateOf(now)],
  );
  const job = rows[0]!;
  let jobStatus = job.job_status;
  if (job.upcoming === 0 && jobStatus === "Scheduled") {
    jobStatus = job.part_arrived ? "Awaiting Parts" : "Cancelled";
    await tx.query(`UPDATE job SET job_status = $3 WHERE session_id = $1 AND id = $2`, [sessionId, visit.jobId, jobStatus]);
  }
  return { jobStatus };
}
