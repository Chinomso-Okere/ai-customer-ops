import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn, toolTurns, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

const NEW_CUSTOMER = {
  fullName: "Hannah Brooks",
  postcode: "sw4 9zz",
  email: "hannah.brooks@example.com",
  phone: "07700 900999",
  issueType: "Boiler Service",
};

/** The Agent checks Availability and proposes the first window, in one turn. */
async function proposeFirstWindow(h: ChatHarness, details: Record<string, unknown> = NEW_CUSTOMER) {
  const [availability, proposal] = await toolTurns(h, "Book me in for the earliest slot please", [
    ["get_availability", { issueType: details.issueType, postcode: details.postcode }],
    ["propose_booking", (prev) => ({ ...details, ...pick(prev[0]!.ok ? prev[0]!.result.windows[0] : {}) })],
  ]);
  return { availability: availability!, proposal: proposal! };
}

const pick = (w: { date?: string; timeWindow?: string }) => ({ date: w.date, timeWindow: w.timeWindow });

describe("Book a Visit: two-phase Confirmation", () => {
  it("the proposal reads back the booking and nothing is written until the Customer confirms", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);

    const { proposal } = await proposeFirstWindow(h);

    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.result.pendingActionId).toEqual(expect.any(String));
    expect(proposal.result.readBack).toMatchObject({
      issueType: "Boiler Service",
      postcode: "SW4 9ZZ",
      date: "2026-11-18",
      timeWindow: "PM",
      fullName: "Hannah Brooks",
      email: "hannah.brooks@example.com",
    });
    const after = await h.service.getDashboardState(h.sessionId);
    expect(after.jobs).toHaveLength(before.jobs.length);
    expect(after.calendar.visits).toHaveLength(before.calendar.visits.length);
  });

  it("after the Customer's reply, confirming Books a Job, its first Visit and a new Customer, and returns a Job Reference", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);
    const { proposal } = await proposeFirstWindow(h);
    if (!proposal.ok) throw new Error(proposal.error);

    const confirmed = await toolTurn(h, "yeah go ahead", "confirm_action", {
      pendingActionId: proposal.result.pendingActionId,
    });

    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const jobReference: string = confirmed.result.jobReference;
    expect(jobReference).toMatch(/^APX-\d{5}$/);
    expect(before.jobs.map((j) => j.jobReference)).not.toContain(jobReference);

    const state = await h.service.getDashboardState(h.sessionId);
    const job = state.jobs.find((j) => j.jobReference === jobReference)!;
    expect(job).toMatchObject({
      issueType: "Boiler Service",
      jobStatus: "Scheduled",
      customer: { fullName: "Hannah Brooks", postcode: "SW4 9ZZ", email: "hannah.brooks@example.com" },
    });
    expect(job.visits).toHaveLength(1);
    expect(job.visits[0]).toMatchObject({ date: "2026-11-18", timeWindow: "PM", isEmergencyVisit: false });

    // It is on the dashboard calendar, with an Engineer skilled for the Issue Type.
    const onCalendar = state.calendar.visits.find((v) => v.jobReference === jobReference)!;
    expect(onCalendar).toMatchObject({ date: "2026-11-18", timeWindow: "PM", customerName: "Hannah Brooks" });
    const engineer = state.calendar.engineers.find((e) => e.id === onCalendar.engineerId)!;
    expect(engineer.skills).toContain("Boiler Service");

    // propose -> (Customer replies) -> confirm is visible in the Agent Trace.
    expect(state.agentTrace.map((e) => [e.toolName, e.isError])).toEqual([
      ["get_availability", false],
      ["propose_booking", false],
      ["confirm_action", false],
    ]);
  });

  it("confirming in the same turn as the proposal is rejected; after the Customer replies it succeeds", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);

    const [, proposal, sameTurn] = await toolTurns(h, "Book the earliest slot", [
      ["get_availability", { issueType: "Boiler Service", postcode: "SW4 9ZZ" }],
      ["propose_booking", (prev) => ({ ...NEW_CUSTOMER, ...pick(prev[0]!.ok ? prev[0]!.result.windows[0] : {}) })],
      ["confirm_action", (prev) => ({ pendingActionId: prev[1]!.ok ? prev[1]!.result.pendingActionId : "" })],
    ]);

    expect(proposal!.ok).toBe(true);
    expect(sameTurn!.ok).toBe(false);
    expect((await h.service.getDashboardState(h.sessionId)).jobs).toHaveLength(before.jobs.length);

    const later = await toolTurn(h, "yep Wednesday PM works", "confirm_action", {
      pendingActionId: proposal!.ok ? proposal!.result.pendingActionId : "",
    });
    expect(later.ok).toBe(true);
    const state = await h.service.getDashboardState(h.sessionId);
    expect(state.jobs).toHaveLength(before.jobs.length + 1);
    expect(state.agentTrace.map((e) => [e.toolName, e.isError])).toEqual([
      ["get_availability", false],
      ["propose_booking", false],
      ["confirm_action", true],
      ["confirm_action", false],
    ]);
  });

  it("a pending action can be confirmed only once", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);
    const { proposal } = await proposeFirstWindow(h);
    const pendingActionId = proposal.ok ? proposal.result.pendingActionId : "";

    expect((await toolTurn(h, "yes", "confirm_action", { pendingActionId })).ok).toBe(true);
    expect((await toolTurn(h, "yes, book it", "confirm_action", { pendingActionId })).ok).toBe(false);
    expect((await h.service.getDashboardState(h.sessionId)).jobs).toHaveLength(before.jobs.length + 1);
  });

  it("an unknown pending action, or one from another conversation, cannot be confirmed", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { proposal } = await proposeFirstWindow(h);
    const pendingActionId = proposal.ok ? proposal.result.pendingActionId : "";
    const other = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };

    expect((await toolTurn(other, "yes", "confirm_action", { pendingActionId })).ok).toBe(false);
    expect((await toolTurn(h, "yes", "confirm_action", { pendingActionId: "not-an-id" })).ok).toBe(false);
  });

  it("a newer proposal replaces the earlier one, which can no longer be confirmed", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { proposal: first } = await proposeFirstWindow(h);
    const second = await toolTurn(h, "Actually make it Thursday morning", "propose_booking", {
      ...NEW_CUSTOMER,
      date: "2026-11-19",
      timeWindow: "AM",
    });

    const stale = await toolTurn(h, "yes", "confirm_action", {
      pendingActionId: first.ok ? first.result.pendingActionId : "",
    });
    expect(stale.ok).toBe(false);
    const fresh = await toolTurn(h, "yes", "confirm_action", {
      pendingActionId: second.ok ? second.result.pendingActionId : "",
    });
    expect(fresh.ok).toBe(true);
  });
});

describe("Book a Visit: the server enforces the rules, not the model", () => {
  const propose = async (overrides: Record<string, unknown>, now = WEDNESDAY_0930) => {
    const h = await chatHarness(now);
    return toolTurn(h, "Book it", "propose_booking", {
      ...NEW_CUSTOMER,
      date: "2026-11-19",
      timeWindow: "AM",
      ...overrides,
    });
  };

  it("rejects a postcode outside the Coverage Area", async () => {
    const res = await propose({ postcode: "M1 1AE" });
    expect(res).toMatchObject({ ok: false, code: "outside_coverage_area" });
  });

  it("rejects a window starting in under 2 hours", async () => {
    expect((await propose({ date: "2026-11-18", timeWindow: "AM" })).ok).toBe(false);
    expect((await propose({ date: "2026-11-18", timeWindow: "PM" }, london("2026-11-18T11:30"))).ok).toBe(false);
  });

  it("rejects a weekend or a date beyond the 10-weekday horizon", async () => {
    expect((await propose({ date: "2026-11-21" })).ok).toBe(false);
    expect((await propose({ date: "2026-12-01" })).ok).toBe(true);
    expect((await propose({ date: "2026-12-02" })).ok).toBe(false);
  });

  it("requires a name, a valid email and a known Issue Type; phone is optional", async () => {
    expect((await propose({ fullName: " " })).ok).toBe(false);
    expect((await propose({ email: "hannah at example" })).ok).toBe(false);
    expect((await propose({ issueType: "Roof Repair" })).ok).toBe(false);
    const { phone: _phone, ...withoutPhone } = NEW_CUSTOMER;
    const h = await chatHarness(WEDNESDAY_0930);
    const res = await toolTurn(h, "Book it", "propose_booking", { ...withoutPhone, date: "2026-11-19", timeWindow: "AM" });
    expect(res.ok).toBe(true);
  });

  it("no Engineer is ever double-booked: a window fills up and drops out of Availability", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const ac = { ...NEW_CUSTOMER, issueType: "AC Repair & Install" };
    const offered = await toolTurn(h, "AC please", "get_availability", { issueType: ac.issueType, postcode: ac.postcode });
    if (!offered.ok) throw new Error(offered.error);
    const target = pick(offered.result.windows[0]);

    // Three Customers in separate conversations all get a proposal for the same
    // window before anyone confirms; only 2 Engineers do AC work.
    const conversations: ChatHarness[] = [];
    const proposals: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };
      const p = await toolTurn(c, "Book it", "propose_booking", { ...ac, email: `ac${i}@example.com`, ...target });
      if (!p.ok) throw new Error(p.error);
      conversations.push(c);
      proposals.push(p.result.pendingActionId);
    }
    const outcomes = [];
    for (const [i, c] of conversations.entries()) {
      outcomes.push((await toolTurn(c, "yes please", "confirm_action", { pendingActionId: proposals[i] })).ok);
    }

    expect(outcomes.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(outcomes.filter((ok) => !ok).length).toBeGreaterThanOrEqual(1);

    const state = await h.service.getDashboardState(h.sessionId);
    const cells = state.calendar.visits.filter((v) => !v.isEmergencyVisit).map((v) => `${v.engineerId}|${v.date}|${v.timeWindow}`);
    expect(new Set(cells).size).toBe(cells.length);
    const booked = state.calendar.visits.filter((v) => v.date === target.date && v.timeWindow === target.timeWindow && v.issueType === "AC Repair & Install");
    for (const v of booked) {
      expect(state.calendar.engineers.find((e) => e.id === v.engineerId)!.skills).toContain("AC Repair & Install");
    }

    // The full window is no longer offered; the next ones move up.
    const again = await toolTurn(h, "Any other times?", "get_availability", { issueType: ac.issueType, postcode: ac.postcode });
    if (!again.ok) throw new Error(again.error);
    const slots = (ws: { date: string; timeWindow: string }[]) => ws.map((w) => `${w.date} ${w.timeWindow}`);
    expect(slots(again.result.windows)).not.toContain(`${target.date} ${target.timeWindow}`);
    expect(slots(again.result.windows).slice(0, 2)).toEqual(slots(offered.result.windows).slice(1, 3));
    // And proposing it again is refused.
    expect((await toolTurn(h, "Book it", "propose_booking", { ...ac, ...target })).ok).toBe(false);
  });

  it("one Demo Session's booking never appears in another's dashboard", async () => {
    const a = await chatHarness(WEDNESDAY_0930);
    const b = await chatHarness(WEDNESDAY_0930);
    const before = await b.service.getDashboardState(b.sessionId);
    const { proposal } = await proposeFirstWindow(a);
    await toolTurn(a, "yes", "confirm_action", { pendingActionId: proposal.ok ? proposal.result.pendingActionId : "" });

    const after = await b.service.getDashboardState(b.sessionId);
    expect(after.jobs).toHaveLength(before.jobs.length);
    expect(after.calendar.visits).toHaveLength(before.calendar.visits.length);
  });
});
