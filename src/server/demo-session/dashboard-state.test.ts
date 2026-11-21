import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";

async function seededState(now: Date) {
  const { service } = await createHarness({ now });
  const sessionId = await service.createDemoSession();
  return service.getDashboardState(sessionId);
}

describe("Operations Dashboard state", () => {
  it("the calendar covers the weekdays of this week and next", async () => {
    const state = await seededState(london("2026-11-18T09:15")); // Wednesday

    expect(state.calendar.days.map((d) => d.date)).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
      "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27",
    ]);
    expect(state.calendar.days.find((d) => d.isToday)?.date).toBe("2026-11-18");
  });

  it("at a weekend the calendar starts from the coming Monday", async () => {
    const state = await seededState(london("2026-11-22T12:00")); // Sunday

    expect(state.calendar.days.map((d) => d.date)).toEqual([
      "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27",
      "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04",
    ]);
    expect(state.calendar.days.some((d) => d.isToday)).toBe(false);
  });

  it("the calendar shows exactly the Jobs' Visits that fall on its days, by Engineer and Time Window", async () => {
    const state = await seededState(london("2026-11-18T09:15"));
    const days = new Set(state.calendar.days.map((d) => d.date));

    const expected = state.jobs
      .flatMap((job) =>
        job.visits.map((v) => `${v.id}|${v.date}|${v.timeWindow}|${v.engineer.id}|${job.jobReference}`),
      )
      .filter((key) => days.has(key.split("|")[1]!))
      .sort();
    const shown = state.calendar.visits
      .map((v) => `${v.visitId}|${v.date}|${v.timeWindow}|${v.engineerId}|${v.jobReference}`)
      .sort();

    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(expected);
  });
});
