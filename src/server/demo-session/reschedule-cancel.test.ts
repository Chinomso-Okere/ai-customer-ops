import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn, toolTurns, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");
// The Visit under test: Friday 20 November, AM (starts 08:00).
const FRIDAY_AM = { date: "2026-11-20", timeWindow: "AM" } as const;

const CUSTOMER = {
  fullName: "Hannah Brooks",
  postcode: "SW4 9ZZ",
  email: "hannah.brooks@example.com",
  phone: "07700 900999",
  issueType: "Boiler Service",
};

/**
 * A new Customer Books a Boiler Service on Friday AM (at `startAt`), then (in a fresh
 * conversation) verifies with the Job Reference, and looks the Job up.
 */
async function bookedAndVerified(startAt: Date = WEDNESDAY_0930) {
  const h = await chatHarness(startAt);
  const proposal = await toolTurn(h, "Book me in", "propose_booking", { ...CUSTOMER, ...FRIDAY_AM });
  if (!proposal.ok) throw new Error(proposal.error);
  const confirmed = await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
  if (!confirmed.ok) throw new Error(confirmed.error);
  const jobReference: string = confirmed.result.jobReference;

  const c: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };
  const verified = await toolTurn(c, "Hi, about my booking", "verify_customer", { jobReference, postcode: CUSTOMER.postcode });
  if (!verified.ok || !verified.result.verified) throw new Error("verification failed");
  const visit = await upcomingVisit(c, jobReference);
  return { h: c, jobReference, visit };
}

async function upcomingVisit(h: ChatHarness, jobReference: string) {
  const details = await toolTurn(h, "When is it?", "get_job_details", { jobReference });
  if (!details.ok) throw new Error(details.error);
  return details.result.upcomingVisits[0] as { visitId: string; date: string; timeWindow: string };
}

async function jobOnDashboard(h: ChatHarness, jobReference: string) {
  const state = await h.service.getDashboardState(h.sessionId);
  return { state, job: state.jobs.find((j) => j.jobReference === jobReference)! };
}

describe("Reschedule a Visit more than 24h away", () => {
  it("proposes with a read-back, then moves the existing Visit on confirm (no new Job)", async () => {
    const { h, jobReference, visit } = await bookedAndVerified();
    expect(visit).toMatchObject({ visitId: expect.any(String), ...FRIDAY_AM });
    const jobsBefore = (await h.service.getDashboardState(h.sessionId)).jobs.length;

    const proposal = await toolTurn(h, "Can we move it to Monday afternoon?", "propose_reschedule", {
      visitId: visit.visitId,
      date: "2026-11-23",
      timeWindow: "PM",
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.result.readBack).toMatchObject({
      jobReference,
      from: { date: FRIDAY_AM.date, timeWindow: "AM" },
      to: { date: "2026-11-23", timeWindow: "PM" },
    });
    // Nothing moves until the Customer agrees.
    expect((await jobOnDashboard(h, jobReference)).job.visits[0]).toMatchObject({ date: FRIDAY_AM.date });

    const confirmed = await toolTurn(h, "yep that works", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(confirmed.ok).toBe(true);
    const { state, job } = await jobOnDashboard(h, jobReference);
    expect(state.jobs).toHaveLength(jobsBefore);
    expect(job.jobStatus).toBe("Scheduled");
    expect(job.visits).toHaveLength(1);
    expect(job.visits[0]).toMatchObject({ id: visit.visitId, date: "2026-11-23", timeWindow: "PM" });
    expect(state.calendar.visits.filter((v) => v.jobReference === jobReference)).toEqual([
      expect.objectContaining({ visitId: visit.visitId, date: "2026-11-23", timeWindow: "PM" }),
    ]);
  });
});

/** This conversation's Out of Policy Handoff Tickets. */
async function outOfPolicyTickets(h: ChatHarness) {
  const state = await h.service.getDashboardState(h.sessionId);
  return state.handoffTickets.filter((t) => t.conversationId === h.conversationId && t.escalationReason === "Out of Policy");
}

describe("Cancel a Visit more than 24h away", () => {
  it("proposes with a read-back, then on confirm removes the Visit and cancels the Job", async () => {
    const { h, jobReference, visit } = await bookedAndVerified();

    const proposal = await toolTurn(h, "I need to cancel please", "propose_cancellation", { visitId: visit.visitId });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.result.readBack).toMatchObject({ jobReference, ...FRIDAY_AM });
    expect((await jobOnDashboard(h, jobReference)).job.visits).toHaveLength(1);

    const confirmed = await toolTurn(h, "yes cancel it", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(confirmed.ok && confirmed.result).toMatchObject({ cancelled: true, jobStatus: "Cancelled" });
    const { state, job } = await jobOnDashboard(h, jobReference);
    expect(job.jobStatus).toBe("Cancelled");
    expect(job.visits).toEqual([]);
    expect(state.calendar.visits.some((v) => v.jobReference === jobReference)).toBe(false);
    const details = await toolTurn(h, "Anything left?", "get_job_details", { jobReference });
    expect(details.ok && details.result.upcomingVisits).toEqual([]);
  });

  it("a cancelled Visit no longer makes its Engineer busy: the slot can be booked again", async () => {
    const { h, visit } = await bookedAndVerified();
    const visitsFridayAm = async () =>
      (await h.service.getDashboardState(h.sessionId)).calendar.visits.filter(
        (v) => v.date === FRIDAY_AM.date && v.timeWindow === FRIDAY_AM.timeWindow,
      ).length;
    const before = await visitsFridayAm();
    const proposal = await toolTurn(h, "cancel it", "propose_cancellation", { visitId: visit.visitId });
    if (!proposal.ok) throw new Error(proposal.error);
    await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
    expect(await visitsFridayAm()).toBe(before - 1);

    const again = await toolTurn(h, "Book Friday morning for my brother", "propose_booking", {
      ...CUSTOMER,
      fullName: "Tom Brooks",
      email: "tom.brooks@example.com",
      ...FRIDAY_AM,
    });
    if (!again.ok) throw new Error(again.error);
    const booked = await toolTurn(h, "yes", "confirm_action", { pendingActionId: again.result.pendingActionId });
    expect(booked.ok).toBe(true);
    expect(await visitsFridayAm()).toBe(before);
  });
});

describe("The 24h policy, enforced server-side", () => {
  // The Visit starts Friday 08:00, so the 24h mark is Thursday 08:00. Sessions
  // start that morning (a Demo Session lives 4h).
  const THURSDAY_0500 = london("2026-11-19T05:00");
  const JUST_OVER_24H = london("2026-11-19T07:59");
  const EXACTLY_24H = london("2026-11-19T08:00");
  const UNDER_24H = london("2026-11-19T08:30");

  it("just over 24h before, a reschedule and a cancellation can both be proposed", async () => {
    const { h, visit } = await bookedAndVerified(THURSDAY_0500);
    h.clock.set(JUST_OVER_24H);

    const reschedule = await toolTurn(h, "move it to Monday PM", "propose_reschedule", {
      visitId: visit.visitId,
      date: "2026-11-23",
      timeWindow: "PM",
    });
    const cancel = await toolTurn(h, "or just cancel", "propose_cancellation", { visitId: visit.visitId });

    expect(reschedule.ok && reschedule.result.pendingActionId).toEqual(expect.any(String));
    expect(cancel.ok && cancel.result.pendingActionId).toEqual(expect.any(String));
    expect(await outOfPolicyTickets(h)).toEqual([]);
  });

  for (const [label, at] of [
    ["exactly 24h", EXACTLY_24H],
    ["under 24h", UNDER_24H],
  ] as const) {
    it(`${label} before, a reschedule is refused, the Visit stays put and an Out of Policy ticket is raised`, async () => {
      const { h, jobReference, visit } = await bookedAndVerified(THURSDAY_0500);
      h.clock.set(at);

      const res = await toolTurn(h, "Can I move it to Monday afternoon?", "propose_reschedule", {
        visitId: visit.visitId,
        date: "2026-11-23",
        timeWindow: "PM",
      });

      expect(res.ok && res.result).toMatchObject({ changed: false, outOfPolicy: true, ticketReference: expect.stringMatching(/^APX-H-/) });
      expect(res.ok && res.result.pendingActionId).toBeUndefined();
      const tickets = await outOfPolicyTickets(h);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        ticketReference: res.ok ? res.result.ticketReference : "",
        urgency: "Normal",
        jobReference,
        customer: expect.objectContaining({ fullName: CUSTOMER.fullName }),
      });
      expect((await jobOnDashboard(h, jobReference)).job.visits[0]).toMatchObject(FRIDAY_AM);
    });

    it(`${label} before, a cancellation is refused, the Visit stays and an Out of Policy ticket is raised`, async () => {
      const { h, jobReference, visit } = await bookedAndVerified(THURSDAY_0500);
      h.clock.set(at);

      const res = await toolTurn(h, "Cancel it please", "propose_cancellation", { visitId: visit.visitId });

      expect(res.ok && res.result).toMatchObject({ changed: false, outOfPolicy: true });
      expect(await outOfPolicyTickets(h)).toHaveLength(1);
      const { job } = await jobOnDashboard(h, jobReference);
      expect(job.jobStatus).toBe("Scheduled");
      expect(job.visits).toHaveLength(1);
    });
  }

  it("asking again within 24h appends to the same Out of Policy ticket", async () => {
    const { h, visit } = await bookedAndVerified(THURSDAY_0500);
    h.clock.set(UNDER_24H);

    await toolTurn(h, "Cancel it", "propose_cancellation", { visitId: visit.visitId });
    await toolTurn(h, "Please, I really need to cancel", "propose_cancellation", { visitId: visit.visitId });

    const tickets = await outOfPolicyTickets(h);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.timeline.map((e) => e.kind)).toEqual(["created", "appended"]);
  });

  it("proposed just over 24h before but confirmed at the 24h mark: refused and escalated at confirm", async () => {
    const { h, jobReference, visit } = await bookedAndVerified(THURSDAY_0500);
    h.clock.set(JUST_OVER_24H);
    const proposal = await toolTurn(h, "cancel it", "propose_cancellation", { visitId: visit.visitId });
    if (!proposal.ok) throw new Error(proposal.error);

    h.clock.set(EXACTLY_24H);
    const confirmed = await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(confirmed.ok && confirmed.result).toMatchObject({ changed: false, outOfPolicy: true });
    expect(await outOfPolicyTickets(h)).toHaveLength(1);
    expect((await jobOnDashboard(h, jobReference)).job.visits).toHaveLength(1);
  });
});

describe("Reschedule and cancel: guardrails", () => {
  it("confirming in the same turn as the proposal is rejected and nothing changes", async () => {
    const { h, jobReference, visit } = await bookedAndVerified();

    const [proposal, confirm] = await toolTurns(h, "Cancel my Friday visit", [
      ["propose_cancellation", { visitId: visit.visitId }],
      ["confirm_action", (prev) => ({ pendingActionId: prev[0]!.ok ? prev[0]!.result.pendingActionId : "" })],
    ]);

    expect(proposal!.ok).toBe(true);
    expect(confirm!.ok).toBe(false);
    const { job } = await jobOnDashboard(h, jobReference);
    expect(job.jobStatus).toBe("Scheduled");
    expect(job.visits).toHaveLength(1);
  });

  it("requires Verification for the Visit's Customer", async () => {
    const { h, visit } = await bookedAndVerified();
    const stranger: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };

    const res = await toolTurn(stranger, "cancel visit", "propose_cancellation", { visitId: visit.visitId });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/verify_customer/);
  });

  it("another Customer's Visit can't be changed, even when verified", async () => {
    const { h } = await bookedAndVerified();
    const state = await h.service.getDashboardState(h.sessionId);
    const othersVisit = state.calendar.visits.find((v) => v.customerName !== CUSTOMER.fullName && v.date > "2026-11-20")!;

    const res = await toolTurn(h, "cancel that one", "propose_cancellation", { visitId: othersVisit.visitId });

    expect(res.ok).toBe(false);
  });
});
