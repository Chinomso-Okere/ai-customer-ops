/**
 * Europe/London is the business timezone for all Time Window logic.
 *
 * A `PlainDate` is a London calendar date as "YYYY-MM-DD". Instants are JS
 * `Date`s. Date arithmetic on PlainDates is done in UTC so DST never shifts it.
 */
export type PlainDate = string;

export const BUSINESS_TIME_ZONE = "Europe/London";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const offsetFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  timeZoneName: "shortOffset",
});

/** The London calendar date of an instant. */
export function londonDateOf(instant: Date): PlainDate {
  return dateFormatter.format(instant);
}

/** The instant of a London wall-clock time, e.g. londonInstant("2026-11-18", "08:00"). */
export function londonInstant(date: PlainDate, time: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Offset at the guessed instant; correct for all times outside the DST jump hour.
  const offset = londonOffsetMinutes(new Date(asIfUtc));
  return new Date(asIfUtc - offset * 60_000);
}

function londonOffsetMinutes(instant: Date): number {
  const name = offsetFormatter.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value;
  const match = /GMT([+-]\d+)/.exec(name ?? "");
  return match?.[1] ? Number(match[1]) * 60 : 0;
}

function toUtcDate(date: PlainDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: PlainDate): number {
  return toUtcDate(date).getUTCDay();
}

export function isWeekday(date: PlainDate): boolean {
  const dow = dayOfWeek(date);
  return dow !== 0 && dow !== 6;
}

/**
 * Moves `count` weekdays from `date` (negative = backwards). With count 0,
 * returns `date` itself, even on a weekend.
 */
export function addWeekdays(date: PlainDate, count: number): PlainDate {
  let current = date;
  let remaining = Math.abs(count);
  const step = count < 0 ? -1 : 1;
  while (remaining > 0) {
    current = addDays(current, step);
    if (isWeekday(current)) remaining--;
  }
  return current;
}

/** The Monday of the week containing `date`. */
export function mondayOf(date: PlainDate): PlainDate {
  const dow = dayOfWeek(date);
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}
