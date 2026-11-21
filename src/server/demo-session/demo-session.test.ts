import { describe, expect, it } from "vitest";
import { addDays } from "@/domain/london-time";
import { DEMO_SESSION_TTL_MS, DemoSessionNotFoundError } from "@/server/demo-session";
import type { DashboardState } from "@/server/demo-session";
import { createHarness, london } from "@/server/testing/harness";

const WEDNESDAY = london("2026-11-18T09:15");

function allIds(state: DashboardState): string[] {
  return [
    ...state.calendar.engineers.map((e) => e.id),
    ...state.jobs.map((j) => j.id),
    ...state.jobs.flatMap((j) => j.visits.map((v) => v.id)),
    ...state.partsOrders.map((p) => p.id),
    ...state.handoffTickets.map((t) => t.id),
  ];
}

describe("Demo Session", () => {
  it("session isolation: one session's data never appears in another's dashboard state", async () => {
    const { service } = await createHarness({ now: WEDNESDAY });

    const a = await service.createDemoSession();
    const stateABefore = await service.getDashboardState(a);
    const b = await service.createDemoSession();
    const stateA = await service.getDashboardState(a);
    const stateB = await service.getDashboardState(b);

    expect(a).not.toBe(b);
    expect(stateB.sessionId).toBe(b);
    // B holds exactly one world, not A's rows as well…
    expect(stateB.jobs).toHaveLength(stateA.jobs.length);
    expect(stateB.handoffTickets).toHaveLength(stateA.handoffTickets.length);
    expect(stateB.partsOrders).toHaveLength(stateA.partsOrders.length);
    // …none of A's records leak into B…
    const idsInA = new Set(allIds(stateA));
    for (const id of allIds(stateB)) expect(idsInA.has(id)).toBe(false);
    // …and creating B left A untouched.
    expect(stateA).toEqual(stateABefore);
  });

  it("seeds dates relative to the moment the session was created", async () => {
    const { service, clock } = await createHarness({ now: WEDNESDAY });
    const thisWeek = await service.getDashboardState(await service.createDemoSession());

    clock.set(new Date(WEDNESDAY.getTime() + 7 * 24 * 60 * 60 * 1000));
    const nextWeek = await service.getDashboardState(await service.createDemoSession());

    const visitDates = (s: DashboardState) =>
      s.jobs.flatMap((j) => j.visits.map((v) => `${j.jobReference} ${v.timeWindow} ${v.date}`)).sort();
    const shifted = (s: DashboardState) =>
      s.jobs
        .flatMap((j) => j.visits.map((v) => `${j.jobReference} ${v.timeWindow} ${addDays(v.date, 7)}`))
        .sort();
    expect(visitDates(nextWeek)).toEqual(shifted(thisWeek));
    expect(nextWeek.partsOrders.map((p) => p.expectedArrival)).toEqual(
      thisWeek.partsOrders.map((p) => addDays(p.expectedArrival, 7)),
    );
  });

  it("opening the demo with a live session resumes it", async () => {
    const { service, clock } = await createHarness({ now: WEDNESDAY });
    const sessionId = await service.createDemoSession();

    clock.set(new Date(WEDNESDAY.getTime() + 60 * 60 * 1000));
    expect(await service.openDemoSession(sessionId)).toBe(sessionId);
  });

  it("opening the demo without a session, or with an unknown one, starts a new session", async () => {
    const { service } = await createHarness({ now: WEDNESDAY });

    const fresh = await service.openDemoSession(undefined);
    const fromUnknown = await service.openDemoSession(crypto.randomUUID());
    const fromGarbage = await service.openDemoSession("not-a-session-id");

    for (const id of [fresh, fromUnknown, fromGarbage]) {
      expect((await service.getDashboardState(id)).jobs.length).toBeGreaterThan(0);
    }
    expect(new Set([fresh, fromUnknown, fromGarbage]).size).toBe(3);
  });

  it("an expired session is not resumed and its dashboard state is gone", async () => {
    const { service, clock } = await createHarness({ now: WEDNESDAY });
    const expired = await service.createDemoSession();

    clock.set(new Date(WEDNESDAY.getTime() + DEMO_SESSION_TTL_MS + 1));

    expect(await service.openDemoSession(expired)).not.toBe(expired);
    await expect(service.getDashboardState(expired)).rejects.toBeInstanceOf(DemoSessionNotFoundError);
  });

  it("asking for an unknown session's dashboard state fails with DemoSessionNotFoundError", async () => {
    const { service } = await createHarness({ now: WEDNESDAY });

    await expect(service.getDashboardState(crypto.randomUUID())).rejects.toBeInstanceOf(
      DemoSessionNotFoundError,
    );
    await expect(service.getDashboardState("garbage")).rejects.toBeInstanceOf(
      DemoSessionNotFoundError,
    );
  });
});
