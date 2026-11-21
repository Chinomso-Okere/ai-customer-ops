import { describe, expect, it } from "vitest";
import { isInCoverageArea, outwardCode } from "@/domain/coverage-area";
import { JOB_STATUSES } from "@/domain/vocabulary";
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
});
