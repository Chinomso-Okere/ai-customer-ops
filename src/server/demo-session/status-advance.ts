import { londonDateOf } from "@/domain/london-time";
import {
  JOB_STATUS_PATH,
  PARTS_STATUSES,
  nextStatus,
  type JobStatus,
  type PartsStatus,
} from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";
import { InvalidStatusAdvanceError } from "./errors";

/**
 * Dashboard status advances: exactly one step forward from `from`, the status
 * the Operator saw. A stale `from` is refused rather than applied, so a double
 * click can never skip a step.
 */
export async function advanceJobStatus(
  db: Database,
  sessionId: string,
  jobId: string,
  from: JobStatus,
): Promise<{ jobStatus: JobStatus }> {
  const to = nextStatus(JOB_STATUS_PATH, from);
  if (!to) throw new InvalidStatusAdvanceError(`A ${from} Job can't be advanced.`);
  const { rows } = await db.query(
    `UPDATE job SET job_status = $4 WHERE session_id = $1 AND id = $2 AND job_status = $3 RETURNING id`,
    [sessionId, jobId, from, to],
  );
  if (rows.length === 0) throw new InvalidStatusAdvanceError(`That Job is no longer ${from}; refresh and try again.`);
  return { jobStatus: to };
}

export async function advancePartsStatus(
  db: Database,
  sessionId: string,
  partsOrderId: string,
  from: PartsStatus,
  now: Date,
): Promise<{ partsStatus: PartsStatus }> {
  const to = nextStatus(PARTS_STATUSES, from);
  if (!to) throw new InvalidStatusAdvanceError(`A ${from} Parts Order can't be advanced.`);
  // On arrival the expected date becomes the actual one: today.
  const { rows } = await db.query(
    `UPDATE parts_order
        SET parts_status = $4,
            expected_arrival = CASE WHEN $4 = 'Arrived' THEN $5::date ELSE expected_arrival END
      WHERE session_id = $1 AND id = $2 AND parts_status = $3
      RETURNING id`,
    [sessionId, partsOrderId, from, to, londonDateOf(now)],
  );
  if (rows.length === 0) {
    throw new InvalidStatusAdvanceError(`That Parts Order is no longer ${from}; refresh and try again.`);
  }
  return { partsStatus: to };
}
