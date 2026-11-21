import { addWeekdays, isWeekday, londonDateOf } from "@/domain/london-time";
import { TIME_WINDOWS, timeWindowEnd } from "@/domain/time-window";
import type { IssueType } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";
import { lockDemoSession } from "@/server/db/session-lock";
import type { CandidateWindow } from "./availability";
import { createCustomerJob, type BookedJob, type NewCustomer } from "./booking";

/** An Engineer must have at least this long left in a Time Window to attend an Emergency Visit in it. */
export const EMERGENCY_VISIT_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;

/**
 * The earliest Time Window for an Emergency Visit, ignoring capacity: the first
 * weekday window (today's included, even if under way) with at least two hours
 * left to run.
 */
export function emergencyVisitWindow(now: Date): CandidateWindow {
  const latestEnd = now.getTime() + EMERGENCY_VISIT_MIN_REMAINING_MS;
  const today = londonDateOf(now);
  for (let date = isWeekday(today) ? today : addWeekdays(today, 1); ; date = addWeekdays(date, 1)) {
    for (const timeWindow of TIME_WINDOWS) {
      if (timeWindowEnd(date, timeWindow).getTime() >= latestEnd) return { date, timeWindow };
    }
  }
}

/**
 * Books an Emergency Visit: a Scheduled Job and its Emergency Visit in
 * `window`, which may exceed normal capacity. It goes to the first skilled
 * Engineer free in that window, or else the first skilled Engineer (double-
 * booked; Emergency Visits are exempt from the one-Visit-per-window rule).
 * Returns undefined if no Engineer has the skill. Call inside a transaction.
 */
export async function bookEmergencyVisit(
  tx: Database,
  sessionId: string,
  booking: { customer: NewCustomer; issueType: IssueType; description: string; window: CandidateWindow; now: Date },
): Promise<BookedJob | undefined> {
  await lockDemoSession(tx, sessionId);
  // Skilled Engineers, least busy in the window first, then roster order.
  const skilled = await tx.query<{ id: string; name: string }>(
    `SELECT e.id, e.name FROM engineer e
      WHERE e.session_id = $1 AND $2 = ANY(e.skills)
      ORDER BY (SELECT count(*) FROM visit v
                 WHERE v.session_id = $1 AND v.engineer_id = e.id
                   AND v.cancelled_at IS NULL
                   AND v.visit_date = $3 AND v.time_window = $4),
               e.sort_order`,
    [sessionId, booking.issueType, booking.window.date, booking.window.timeWindow],
  );
  const engineer = skilled.rows[0];
  if (!engineer) return undefined;

  const { customerId, jobId, jobReference } = await createCustomerJob(tx, sessionId, booking);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO visit (session_id, job_id, engineer_id, visit_date, time_window, is_emergency_visit)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [sessionId, jobId, engineer.id, booking.window.date, booking.window.timeWindow],
  );
  return {
    jobId,
    jobReference,
    customerId,
    visit: { visitId: rows[0]!.id, engineerId: engineer.id, engineerName: engineer.name },
  };
}
