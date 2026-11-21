import { londonInstant, type PlainDate } from "./london-time";

/** A half-day period in which a Visit takes place, weekdays only. */
export const TIME_WINDOWS = ["AM", "PM"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const TIME_WINDOW_HOURS: Record<TimeWindow, { start: string; end: string }> = {
  AM: { start: "08:00", end: "12:00" },
  PM: { start: "12:00", end: "17:00" },
};

export function timeWindowStart(date: PlainDate, window: TimeWindow): Date {
  return londonInstant(date, TIME_WINDOW_HOURS[window].start);
}

export function timeWindowEnd(date: PlainDate, window: TimeWindow): Date {
  return londonInstant(date, TIME_WINDOW_HOURS[window].end);
}
