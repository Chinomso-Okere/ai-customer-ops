import { describe, expect, it } from "vitest";
import { isInCoverageArea, outwardCode } from "@/domain/coverage-area";
import { addDays, addWeekdays, isWeekday, londonDateOf } from "@/domain/london-time";
import { TIME_WINDOWS } from "@/domain/time-window";
import { JOB_STATUSES, PARTS_STATUSES } from "@/domain/vocabulary";
import { createHarness, london } from "@/server/testing/harness";

// A Wednesday morning in November (GMT).
const WEDNESDAY = london("2026-11-18T09:15");

async function seededState(now: Date) {
  const { service } = await createHarness({ now });
  const sessionId = await service.createDemoSession();
  return service.getDashboardState(sessionId);
}

describe("seed world", () => {
  it("a new Demo Session is staffed by 5 Engineers", async () => {
    const state = await seededState(WEDNESDAY);

    expect(state.calendar.engineers).toHaveLength(5);
  });

  it("has about 40 Jobs in every Job Status, each with a unique Job Reference", async () => {
    const state = await seededState(WEDNESDAY);

    expect(state.jobs.length).toBeGreaterThanOrEqual(35);
    expect(state.jobs.length).toBeLessThanOrEqual(50);
    expect(new Set(state.jobs.map((j) => j.jobStatus))).toEqual(new Set(JOB_STATUSES));
    const references = state.jobs.map((j) => j.jobReference);
    expect(new Set(references).size).toBe(references.length);
    for (const ref of references) expect(ref).toMatch(/^APX-\d{5}$/);
  });

  it("Jobs belong to about 25 Customers across about 10 outward postcodes in the Coverage Area", async () => {
    const state = await seededState(WEDNESDAY);

    const customers = new Set(state.jobs.map((j) => j.customer.email));
    expect(customers.size).toBeGreaterThanOrEqual(20);
    expect(customers.size).toBeLessThanOrEqual(30);
    const outwardCodes = new Set(state.jobs.map((j) => outwardCode(j.customer.postcode)));
    expect(outwardCodes.size).toBeGreaterThanOrEqual(8);
    for (const job of state.jobs) expect(isInCoverageArea(job.customer.postcode)).toBe(true);
  });

  it("has 6 Parts Orders across every Parts Status, one Dispatched and arriving tomorrow", async () => {
    const state = await seededState(london("2026-11-20T16:30")); // Friday

    expect(state.partsOrders).toHaveLength(6);
    expect(new Set(state.partsOrders.map((p) => p.partsStatus))).toEqual(new Set(PARTS_STATUSES));
    const arrivingTomorrow = state.partsOrders.filter(
      (p) => p.partsStatus === "Dispatched" && p.expectedArrival === "2026-11-21",
    );
    expect(arrivingTomorrow).toHaveLength(1);
    const jobReferences = new Set(state.jobs.map((j) => j.jobReference));
    for (const p of state.partsOrders) expect(jobReferences).toContain(p.jobReference);
  });

  describe.each([
    ["Wednesday morning", london("2026-11-18T09:15")],
    ["Friday afternoon", london("2026-11-20T16:30")],
    ["Saturday", london("2026-11-21T10:00")],
    ["Sunday night", london("2026-11-22T23:30")],
    ["Monday before opening", london("2026-11-23T07:00")],
    ["summer (BST)", london("2026-07-15T11:30")],
    ["the Monday after clocks go forward", london("2026-03-30T08:30")],
  ])("seeded on %s", (_label, now) => {
    it("every Visit is on a weekday in a valid Time Window, with an Engineer skilled for the Job's Issue Type", async () => {
      const state = await seededState(now);
      const skills = new Map(state.calendar.engineers.map((e) => [e.id, e.skills]));

      const visits = state.jobs.flatMap((job) => job.visits.map((visit) => ({ job, visit })));
      expect(visits.length).toBeGreaterThan(0);
      for (const { job, visit } of visits) {
        expect(isWeekday(visit.date)).toBe(true);
        expect(TIME_WINDOWS).toContain(visit.timeWindow);
        expect(skills.get(visit.engineer.id)).toContain(job.issueType);
      }
    });

    it("no Engineer is double-booked", async () => {
      const state = await seededState(now);

      const cells = state.jobs.flatMap((job) =>
        job.visits.map((v) => `${v.engineer.id}|${v.date}|${v.timeWindow}`),
      );
      expect(new Set(cells).size).toBe(cells.length);
    });

    it("Visits span from about a month ago to two weeks ahead of the session's creation", async () => {
      const state = await seededState(now);
      const today = londonDateOf(now);

      const dates = state.jobs.flatMap((job) => job.visits.map((v) => v.date)).sort();
      expect(dates[0]! >= addDays(today, -30)).toBe(true);
      expect(dates[0]! <= addDays(today, -21)).toBe(true);
      expect(dates.at(-1)! <= addDays(today, 14)).toBe(true);
      expect(dates.at(-1)! >= addDays(today, 10)).toBe(true);
    });

    it("Engineers' calendars for the next 10 weekdays are roughly half full", async () => {
      const state = await seededState(now);
      const upcoming = new Set(
        Array.from({ length: 10 }, (_, i) => addWeekdays(londonDateOf(now), i + 1)),
      );

      const booked = state.jobs
        .flatMap((job) => job.visits)
        .filter((v) => upcoming.has(v.date)).length;
      const capacity = upcoming.size * TIME_WINDOWS.length * state.calendar.engineers.length;
      expect(booked / capacity).toBeGreaterThanOrEqual(0.35);
      expect(booked / capacity).toBeLessThanOrEqual(0.65);
    });
  });
});
