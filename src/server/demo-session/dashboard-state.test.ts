import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
import { chatHarness, toolTurn } from "@/server/testing/tool-turns";

async function seededState(now: Date) {
  const { service } = await createHarness({ now });
  const sessionId = await service.createDemoSession();
  return service.getDashboardState(sessionId);
}

describe("Operations Dashboard state", () => {
  it("the calendar covers this week through the week holding the last day of Availability", async () => {
    // Wednesday: Availability runs 10 weekdays, to Tuesday 1 December; show through Friday 4th.
    const state = await seededState(london("2026-11-18T09:15"));

    expect(state.calendar.days.map((d) => d.date)).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
      "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27",
      "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04",
    ]);
    expect(state.calendar.days.find((d) => d.isToday)?.date).toBe("2026-11-18");
  });

  it("on a Monday the Availability horizon ends on Friday next week, so two weeks are shown", async () => {
    const state = await seededState(london("2026-11-16T09:15"));

    expect(state.calendar.days.map((d) => d.date)).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
      "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27",
    ]);
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

  it("a Visit booked on the last day of Availability appears on the calendar", async () => {
    const h = await chatHarness(london("2026-11-18T09:15"));
    const proposal = await toolTurn(h, "Book me in on Tuesday 1st December, morning", "propose_booking", {
      fullName: "Hannah Brooks",
      postcode: "SW4 9ZZ",
      email: "hannah.brooks@example.com",
      issueType: "Boiler Service",
      date: "2026-12-01",
      timeWindow: "AM",
    });
    if (!proposal.ok) throw new Error(proposal.error);
    const confirmed = await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
    if (!confirmed.ok) throw new Error(confirmed.error);

    const { calendar } = await h.service.getDashboardState(h.sessionId);

    expect(calendar.visits.find((v) => v.jobReference === confirmed.result.jobReference)).toMatchObject({
      date: "2026-12-01",
      timeWindow: "AM",
    });
  });

  it("the Handoff Ticket queue puts higher Urgency first, even ahead of older tickets", async () => {
    const state = await seededState(london("2026-11-18T09:15"));

    // Seed: a High Complaint opened 3h ago and a Normal Out of Policy opened 26h ago.
    expect(state.handoffTickets.map((t) => [t.urgency, t.escalationReason])).toEqual([
      ["High", "Complaint"],
      ["Normal", "Out of Policy"],
    ]);
  });
});
