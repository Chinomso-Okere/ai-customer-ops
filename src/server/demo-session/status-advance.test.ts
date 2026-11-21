import { describe, expect, it } from "vitest";
import { InvalidStatusAdvanceError } from "@/server/demo-session";
import { createHarness, london } from "@/server/testing/harness";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

async function sessionHarness() {
  const h = await createHarness({ now: WEDNESDAY_0930 });
  const sessionId = await h.service.createDemoSession();
  const state = () => h.service.getDashboardState(sessionId);
  return { ...h, sessionId, state };
}

describe("Status advance: one step forward only", () => {
  it("advances a Job through Scheduled → In Progress → Awaiting Parts → Completed", async () => {
    const h = await sessionHarness();
    const job = (await h.state()).jobs.find((j) => j.jobStatus === "Scheduled")!;

    const seen: string[] = [];
    for (const from of ["Scheduled", "In Progress", "Awaiting Parts"] as const) {
      const { jobStatus } = await h.service.advanceJobStatus(h.sessionId, job.id, from);
      seen.push(jobStatus);
    }

    expect(seen).toEqual(["In Progress", "Awaiting Parts", "Completed"]);
    expect((await h.state()).jobs.find((j) => j.id === job.id)!.jobStatus).toBe("Completed");
  });

  it("advances a Parts Order through Ordered → Dispatched → Arrived → Fitted", async () => {
    const h = await sessionHarness();
    const order = (await h.state()).partsOrders.find((p) => p.partsStatus === "Ordered")!;

    const seen: string[] = [];
    for (const from of ["Ordered", "Dispatched", "Arrived"] as const) {
      const { partsStatus } = await h.service.advancePartsStatus(h.sessionId, order.id, from);
      seen.push(partsStatus);
    }

    expect(seen).toEqual(["Dispatched", "Arrived", "Fitted"]);
    expect((await h.state()).partsOrders.find((p) => p.id === order.id)!.partsStatus).toBe("Fitted");
  });

  it("a Parts Order that Arrives shows today as its arrival date", async () => {
    const h = await sessionHarness();
    const order = (await h.state()).partsOrders.find((p) => p.partsStatus === "Dispatched")!;

    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");

    expect((await h.state()).partsOrders.find((p) => p.id === order.id)!.expectedArrival).toBe("2026-11-18");
  });

  it("rejects advancing from terminal states: Completed and Cancelled Jobs, Fitted Parts Orders", async () => {
    const h = await sessionHarness();
    const state = await h.state();
    const completed = state.jobs.find((j) => j.jobStatus === "Completed")!;
    const cancelled = state.jobs.find((j) => j.jobStatus === "Cancelled")!;
    const fitted = state.partsOrders.find((p) => p.partsStatus === "Fitted")!;

    await expect(h.service.advanceJobStatus(h.sessionId, completed.id, "Completed")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
    await expect(h.service.advanceJobStatus(h.sessionId, cancelled.id, "Cancelled")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
    await expect(h.service.advancePartsStatus(h.sessionId, fitted.id, "Fitted")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
  });

  it("rejects a stale advance (the status has moved on), so a double click never skips a step", async () => {
    const h = await sessionHarness();
    const job = (await h.state()).jobs.find((j) => j.jobStatus === "Scheduled")!;

    await h.service.advanceJobStatus(h.sessionId, job.id, "Scheduled");
    await expect(h.service.advanceJobStatus(h.sessionId, job.id, "Scheduled")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );

    expect((await h.state()).jobs.find((j) => j.id === job.id)!.jobStatus).toBe("In Progress");
  });

  it("only touches its own Demo Session", async () => {
    const h = await sessionHarness();
    const other = await h.service.createDemoSession();
    const otherJob = (await h.service.getDashboardState(other)).jobs.find((j) => j.jobStatus === "Scheduled")!;

    await expect(h.service.advanceJobStatus(h.sessionId, otherJob.id, "Scheduled")).rejects.toThrow(
      InvalidStatusAdvanceError,
    );
    const after = (await h.service.getDashboardState(other)).jobs.find((j) => j.id === otherJob.id)!;
    expect(after.jobStatus).toBe("Scheduled");
  });
});
