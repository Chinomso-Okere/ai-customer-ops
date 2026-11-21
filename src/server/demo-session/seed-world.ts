import {
  addDays,
  addWeekdays,
  isWeekday,
  londonDateOf,
  type PlainDate,
} from "@/domain/london-time";
import { timeWindowStart, type TimeWindow } from "@/domain/time-window";
import type { Database } from "@/server/db/database";
import { CUSTOMERS, ENGINEERS, JOBS, type JobSeed } from "./seed-data";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Job Reference number of the first seeded Job; later Jobs count up from here. */
const FIRST_JOB_REFERENCE = 10401;

/** Seeds a complete Apex world into `sessionId`, with dates relative to `now`. */
export async function seedWorld(tx: Database, sessionId: string, now: Date): Promise<void> {
  const today = londonDateOf(now);

  const engineerIds: string[] = [];
  for (const [i, e] of ENGINEERS.entries()) {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO engineer (session_id, name, skills, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
      [sessionId, e.name, e.skills, i],
    );
    engineerIds.push(rows[0]!.id);
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

  const visitPlan = planVisits(today);

  // Job References count up in the order Jobs were raised.
  const raised = JOBS.map((job, i) => ({ job, i, createdAt: jobRaisedAt(job, i, today, now) }));
  const byAge = [...raised].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const [rank, { job, i, createdAt }] of byAge.entries()) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO job (session_id, job_reference, customer_id, issue_type, description, job_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
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
    for (const v of visitPlan[i]!) {
      await tx.query(
        `INSERT INTO visit (session_id, job_id, engineer_id, visit_date, time_window)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, rows[0]!.id, engineerIds[v.engineer], v.date, v.timeWindow],
      );
    }
    if (job.partsOrder) {
      await tx.query(
        `INSERT INTO parts_order (session_id, job_id, part_name, parts_status, expected_arrival, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          rows[0]!.id,
          job.partsOrder.partName,
          job.partsOrder.partsStatus,
          addDays(today, job.partsOrder.arrivalDayOffset),
          createdAt,
        ],
      );
    }
  }
}

interface PlannedVisit {
  engineer: number;
  date: PlainDate;
  timeWindow: TimeWindow;
}

/**
 * Assigns every seeded Visit an Engineer skilled for its Job's Issue Type,
 * never double-booking. A multi-Visit Job keeps one Engineer where possible.
 * Deterministic for a given `today`.
 */
function planVisits(today: PlainDate): PlannedVisit[][] {
  const booked = new Set<string>();
  const cell = (engineer: number, date: PlainDate, w: TimeWindow) => `${engineer}|${date}|${w}`;

  return JOBS.map((job, jobIndex) => {
    const visits = job.visits.map(([offset, timeWindow]) => ({
      date: seedVisitDate(today, offset),
      timeWindow,
    }));
    const skilled = ENGINEERS.flatMap((e, i) => (e.skills.includes(job.issueType) ? [i] : []));
    // Rotate the starting Engineer so work spreads across the team.
    const candidates = skilled.map((_, k) => skilled[(k + jobIndex) % skilled.length]!);
    const isFree = (engineer: number, v: { date: PlainDate; timeWindow: TimeWindow }) =>
      !booked.has(cell(engineer, v.date, v.timeWindow));

    const oneEngineer = candidates.find((e) => visits.every((v) => isFree(e, v)));
    return visits.map((v) => {
      const engineer = oneEngineer ?? candidates.find((e) => isFree(e, v));
      if (engineer === undefined) {
        throw new Error(`Seed world: no free ${job.issueType} Engineer on ${v.date} ${v.timeWindow}`);
      }
      booked.add(cell(engineer, v.date, v.timeWindow));
      return { engineer, ...v };
    });
  });
}

/**
 * The London date of a seed weekday offset. At a weekend, "today" (offset 0)
 * is the previous Friday and earlier offsets count back from there.
 */
function seedVisitDate(today: PlainDate, weekdayOffset: number): PlainDate {
  if (weekdayOffset > 0 || isWeekday(today)) return addWeekdays(today, weekdayOffset);
  return addWeekdays(today, weekdayOffset - 1);
}

/** When the Customer first got in touch: a few days before the first Visit, never after "now". */
function jobRaisedAt(job: JobSeed, index: number, today: PlainDate, now: Date): Date {
  const notAfter = now.getTime() - (1 + (index % 5)) * DAY_MS;
  const first = job.visits[0];
  if (!first) return new Date(now.getTime() - (job.raisedDaysAgo ?? 7) * DAY_MS);
  const firstVisit = timeWindowStart(seedVisitDate(today, first[0]), first[1]).getTime();
  return new Date(Math.min(firstVisit - (2 + (index % 4)) * DAY_MS, notAfter));
}
