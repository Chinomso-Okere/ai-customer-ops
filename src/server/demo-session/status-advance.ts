import { londonDateOf } from "@/domain/london-time";
import {
  JOB_STATUS_PATH,
  PARTS_STATUSES,
  nextStatus,
  type JobStatus,
  type PartsStatus,
} from "@/domain/vocabulary";
import { enqueueSystemNote } from "@/server/agent/conversation-store";
import type { Database } from "@/server/db/database";
import { InvalidStatusAdvanceError } from "./errors";

/**
 * Dashboard status advances: exactly one step forward from `from`, the status
 * the Operator saw. A stale `from` is refused rather than applied, so a double
 * click can never skip a step. Every conversation verified for the Job's
 * Customer is then told to re-check the Job before answering about it.
 */
export async function advanceJobStatus(
  db: Database,
  sessionId: string,
  jobId: string,
  from: JobStatus,
  now: Date,
): Promise<{ jobStatus: JobStatus }> {
  const to = nextStatus(JOB_STATUS_PATH, from);
  if (!to) throw new InvalidStatusAdvanceError(`A ${from} Job can't be advanced.`);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE job SET job_status = $4 WHERE session_id = $1 AND id = $2 AND job_status = $3 RETURNING id`,
      [sessionId, jobId, from, to],
    );
    if (rows.length === 0) throw new InvalidStatusAdvanceError(`That Job is no longer ${from}; refresh and try again.`);
    await tellVerifiedConversations(tx, sessionId, jobId, now);
    return { jobStatus: to };
  });
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
  return db.transaction(async (tx) => {
    // On arrival the expected date becomes the actual one: today.
    const { rows } = await tx.query<{ job_id: string }>(
      `UPDATE parts_order
          SET parts_status = $4,
              expected_arrival = CASE WHEN $4 = 'Arrived' THEN $5::date ELSE expected_arrival END
        WHERE session_id = $1 AND id = $2 AND parts_status = $3
        RETURNING job_id`,
      [sessionId, partsOrderId, from, to, londonDateOf(now)],
    );
    if (rows.length === 0) {
      throw new InvalidStatusAdvanceError(`That Parts Order is no longer ${from}; refresh and try again.`);
    }
    await tellVerifiedConversations(tx, sessionId, rows[0]!.job_id, now);
    return { partsStatus: to };
  });
}

/**
 * Queues a mid-conversation system note for every conversation verified for
 * the Job's Customer: what the Agent fetched earlier may be stale.
 */
async function tellVerifiedConversations(tx: Database, sessionId: string, jobId: string, now: Date): Promise<void> {
  const { rows } = await tx.query<{ conversation_id: string; job_reference: string }>(
    `SELECT v.conversation_id, j.job_reference
       FROM job j
       JOIN conversation_verification v
         ON v.session_id = j.session_id AND v.verified_customer_id = j.customer_id
      WHERE j.session_id = $1 AND j.id = $2`,
    [sessionId, jobId],
  );
  for (const row of rows) {
    await enqueueSystemNote(
      tx,
      { sessionId, conversationId: row.conversation_id },
      `An Operator has just updated Job ${row.job_reference} (its Job Status or a Parts Order). Anything you fetched about it earlier may be out of date: call get_job_details for ${row.job_reference} again before answering any question about its status, Visits or parts.`,
      now,
    );
  }
}
