import { addWeekdays, isWeekday, londonDateOf, type PlainDate } from "@/domain/london-time";
import { TIME_WINDOW_HOURS, TIME_WINDOWS, timeWindowStart, type TimeWindow } from "@/domain/time-window";
import type { IssueType } from "@/domain/vocabulary";
import type { Database } from "@/server/db/database";

/** A window must start at least this long after "now" to be bookable. */
export const BOOKING_LEAD_TIME_MS = 2 * 60 * 60 * 1000;

/** Availability is searched over this many weekdays, today included. */
export const AVAILABILITY_HORIZON_WEEKDAYS = 10;

/** How many Time Windows are offered to a Customer at once. */
export const OFFERED_WINDOWS = 3;

export interface CandidateWindow {
  date: PlainDate;
  timeWindow: TimeWindow;
}

export interface AvailableWindow extends CandidateWindow {
  /** Skilled Engineers free in this window, in roster order. */
  freeEngineerIds: string[];
}

/** The weekdays Availability is searched over: today (if a weekday) and onwards. */
export function availabilityHorizon(now: Date): { from: PlainDate; until: PlainDate } {
  const today = londonDateOf(now);
  const from = isWeekday(today) ? today : addWeekdays(today, 1);
  return { from, until: addWeekdays(from, AVAILABILITY_HORIZON_WEEKDAYS - 1) };
}

/**
 * Every Time Window a Visit could be booked into, ignoring capacity: weekdays
 * within the horizon, starting at least the lead time after `now`. Earliest first.
 */
export function bookableWindows(now: Date): CandidateWindow[] {
  const { from, until } = availabilityHorizon(now);
  const earliestStart = now.getTime() + BOOKING_LEAD_TIME_MS;
  const windows: CandidateWindow[] = [];
  for (let date = from; date <= until; date = addWeekdays(date, 1)) {
    for (const timeWindow of TIME_WINDOWS) {
      if (timeWindowStart(date, timeWindow).getTime() >= earliestStart) windows.push({ date, timeWindow });
    }
  }
  return windows;
}

/**
 * Availability: the bookable Time Windows in which at least one Engineer
 * skilled for `issueType` has no Visit, earliest first. Any Visit (Emergency
 * Visits included; cancelled Visits not) makes its Engineer busy for that window.
 */
export async function findAvailability(
  db: Database,
  sessionId: string,
  issueType: IssueType,
  now: Date,
  options: { limit?: number; only?: CandidateWindow; fromDate?: PlainDate } = {},
): Promise<AvailableWindow[]> {
  const candidates = bookableWindows(now).filter(
    (w) =>
      (!options.only || (w.date === options.only.date && w.timeWindow === options.only.timeWindow)) &&
      (!options.fromDate || w.date >= options.fromDate),
  );
  if (candidates.length === 0) return [];

  const engineers = await db.query<{ id: string }>(
    "SELECT id FROM engineer WHERE session_id = $1 AND $2 = ANY(skills) ORDER BY sort_order",
    [sessionId, issueType],
  );
  const busy = await db.query<{ engineer_id: string; visit_date: PlainDate; time_window: TimeWindow }>(
    `SELECT engineer_id, visit_date::text AS visit_date, time_window
       FROM visit
      WHERE session_id = $1 AND visit_date BETWEEN $2 AND $3 AND cancelled_at IS NULL`,
    [sessionId, candidates[0]!.date, candidates.at(-1)!.date],
  );
  const busyCells = new Set(busy.rows.map((v) => `${v.engineer_id}|${v.visit_date}|${v.time_window}`));

  const available: AvailableWindow[] = [];
  for (const w of candidates) {
    const freeEngineerIds = engineers.rows
      .map((e) => e.id)
      .filter((id) => !busyCells.has(`${id}|${w.date}|${w.timeWindow}`));
    if (freeEngineerIds.length === 0) continue;
    available.push({ ...w, freeEngineerIds });
    if (options.limit && available.length >= options.limit) break;
  }
  return available;
}

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** A Time Window as the model reads it back, e.g. "Thursday 19 November, AM (08:00-12:00)". */
export function describeWindow(w: CandidateWindow): string {
  const { start, end } = TIME_WINDOW_HOURS[w.timeWindow];
  return `${dayFormatter.format(new Date(`${w.date}T00:00:00Z`))}, ${w.timeWindow} (${start}-${end})`;
}

/** A Time Window as sent to the model (no Engineer details). */
export function windowForModel(w: CandidateWindow) {
  return { date: w.date, timeWindow: w.timeWindow, label: describeWindow(w) };
}

/** The given window if it is bookable now and a skilled Engineer is free in it. */
export async function checkWindowAvailable(
  db: Database,
  sessionId: string,
  issueType: IssueType,
  window: CandidateWindow,
  now: Date,
): Promise<AvailableWindow | undefined> {
  const [found] = await findAvailability(db, sessionId, issueType, now, { only: window });
  return found;
}

/** A Time Window named by the model ({date: "YYYY-MM-DD", timeWindow: "AM"|"PM"}), or undefined. */
export function parseWindow(date: unknown, timeWindow: unknown): CandidateWindow | undefined {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return undefined;
  if (Number.isNaN(new Date(`${date.trim()}T00:00:00Z`).getTime())) return undefined;
  const w = typeof timeWindow === "string" ? timeWindow.trim().toUpperCase() : "";
  if (!(TIME_WINDOWS as readonly string[]).includes(w)) return undefined;
  return { date: date.trim(), timeWindow: w as TimeWindow };
}

/**
 * Checks that `window` can be booked for `issueType` now. On failure, `error`
 * is an actionable message for the model.
 */
export async function requireAvailableWindow(
  db: Database,
  sessionId: string,
  issueType: IssueType,
  window: CandidateWindow,
  now: Date,
): Promise<{ ok: true; available: AvailableWindow } | { ok: false; error: string }> {
  const label = describeWindow(window);
  if (!bookableWindows(now).some((w) => w.date === window.date && w.timeWindow === window.timeWindow)) {
    const { until } = availabilityHorizon(now);
    return {
      ok: false,
      error: `${label} can't be booked: Visits are on weekdays only, must start at least 2 hours from now, and no later than ${until}. Call get_availability and offer one of its windows.`,
    };
  }
  const available = await checkWindowAvailable(db, sessionId, issueType, window, now);
  if (!available) {
    return {
      ok: false,
      error: `${label} has no ${issueType} Engineer free. Call get_availability and offer one of its windows.`,
    };
  }
  return { ok: true, available };
}
