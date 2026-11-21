import { addWeekdays, isWeekday, londonDateOf, type PlainDate } from "@/domain/london-time";
import { timeWindowStart } from "@/domain/time-window";
import type { Database } from "@/server/db/database";
import { CUSTOMERS, ENGINEERS, JOBS, type JobSeed } from "./seed-data";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Job Reference number of the first seeded Job; later Jobs count up from here. */
const FIRST_JOB_REFERENCE = 10401;

/** Seeds a complete Apex world into `sessionId`, with dates relative to `now`. */
export async function seedWorld(tx: Database, sessionId: string, now: Date): Promise<void> {
  const today = londonDateOf(now);

  for (const [i, e] of ENGINEERS.entries()) {
    await tx.query(
      "INSERT INTO engineer (session_id, name, skills, sort_order) VALUES ($1, $2, $3, $4)",
      [sessionId, e.name, e.skills, i],
    );
  }

  const customerIds: string[] = [];
  for (const c of CUSTOMERS) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO customer (session_id, full_name, postcode, email, phone, demo_friendly, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [sessionId, c.fullName, c.postcode, c.email, c.phone, c.demoFriendly ?? false, new Date(now.getTime() - 60 * DAY_MS)],
    );
    customerIds.push(rows[0]!.id);
  }

  // Job References count up in the order Jobs were raised.
  const raised = JOBS.map((job, i) => ({ job, createdAt: jobRaisedAt(job, i, today, now) }));
  const byAge = [...raised].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const [rank, { job, createdAt }] of byAge.entries()) {
    await tx.query(
      `INSERT INTO job (session_id, job_reference, customer_id, issue_type, description, job_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        `APX-${FIRST_JOB_REFERENCE + rank * 3 + (rank % 2)}`,
        customerIds[job.customer],
        job.issueType,
        job.description,
        job.jobStatus,
        createdAt,
      ],
    );
  }
}

/** The London date of a seed weekday offset; offset 0 at a weekend means the previous Friday. */
export function seedVisitDate(today: PlainDate, weekdayOffset: number): PlainDate {
  if (weekdayOffset === 0) return isWeekday(today) ? today : addWeekdays(today, -1);
  return addWeekdays(today, weekdayOffset);
}

/** When the Customer first got in touch: a few days before the first Visit, never after "now". */
function jobRaisedAt(job: JobSeed, index: number, today: PlainDate, now: Date): Date {
  const notAfter = now.getTime() - (1 + (index % 5)) * DAY_MS;
  const first = job.visits[0];
  if (!first) return new Date(now.getTime() - (job.raisedDaysAgo ?? 7) * DAY_MS);
  const firstVisit = timeWindowStart(seedVisitDate(today, first[0]), first[1]).getTime();
  return new Date(Math.min(firstVisit - (2 + (index % 4)) * DAY_MS, notAfter));
}
