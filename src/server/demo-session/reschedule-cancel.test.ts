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

  it("a moved Visit frees its old window and takes the new one", async () => {
    const { h, visit } = await bookedAndVerified();
    const count = async (w: { date: string; timeWindow: string }) =>
      (await h.service.getDashboardState(h.sessionId)).calendar.visits.filter(
        (v) => v.date === w.date && v.timeWindow === w.timeWindow,
      ).length;
    const MONDAY_PM = { date: "2026-11-23", timeWindow: "PM" };
    const [fridayBefore, mondayBefore] = [await count(FRIDAY_AM), await count(MONDAY_PM)];

    const proposal = await toolTurn(h, "Monday PM please", "propose_reschedule", { visitId: visit.visitId, ...MONDAY_PM });
    if (!proposal.ok) throw new Error(proposal.error);
    await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(await count(FRIDAY_AM)).toBe(fridayBefore - 1);
    expect(await count(MONDAY_PM)).toBe(mondayBefore + 1);
  });
});

describe("Cancelling a fitting Visit", () => {
  it("returns the Job to Awaiting Parts and re-offers the fitting Visit", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const state = await h.service.getDashboardState(h.sessionId);
    const sarah = state.demoCustomers.find((c) => c.fullName === "Sarah Mitchell")!;
    const job = state.jobs.find((j) => j.customer.fullName === "Sarah Mitchell" && j.jobStatus === "Awaiting Parts")!;
    const order = state.partsOrders.find((p) => p.jobReference === job.jobReference)!;
    await toolTurn(h, "Hi, it's Sarah", "verify_customer", { jobReference: job.jobReference, postcode: sarah.postcode });
    await h.service.advancePartsStatus(h.sessionId, order.id, "Dispatched");
    const fitting = await toolTurn(h, "Book the fitting Monday morning", "propose_fitting_visit", {
      jobReference: job.jobReference,
      date: "2026-11-23",
      timeWindow: "AM",
    });
    if (!fitting.ok) throw new Error(fitting.error);
    await toolTurn(h, "yes", "confirm_action", { pendingActionId: fitting.result.pendingActionId });
    const visit = (await upcomingVisit(h, job.jobReference)) as { visitId: string };

    const proposal = await toolTurn(h, "Actually cancel the fitting", "propose_cancellation", { visitId: visit.visitId });
    if (!proposal.ok) throw new Error(proposal.error);
    const cancelled = await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(cancelled.ok && cancelled.result.jobStatus).toBe("Awaiting Parts");
    const details = await toolTurn(h, "What now?", "get_job_details", { jobReference: job.jobReference });
    expect(details.ok && details.result.jobStatus).toBe("Awaiting Parts");
    expect(details.ok && details.result.fittingVisitOffer).toMatchObject({ partName: "Diverter valve" });
  });
});

describe("Capacity: no Availability within the 10-weekday horizon", () => {
  const AC_CUSTOMER = { ...CUSTOMER, issueType: "AC Repair & Install" };

  /**
   * Fixture setup: fills every free AC Engineer cell in the horizon with a Visit.
   * Done in the database because Booking ~20 windows through chat would exceed
   * the Demo Session's message cap.
   */
  async function fillAcHorizon(h: ChatHarness) {
    const { jobs, calendar } = await h.service.getDashboardState(h.sessionId);
    const jobId = jobs[0]!.id;
    const acEngineers = calendar.engineers.filter((e) => e.skills.includes("AC Repair & Install"));
    await h.db.query(
      `INSERT INTO visit (session_id, job_id, engineer_id, visit_date, time_window)
       SELECT $1, $2, e, d::date, w
         FROM unnest($3::uuid[]) e, generate_series($4::date, $5::date, '1 day') d, unnest(ARRAY['AM','PM']) w
        WHERE extract(isodow FROM d) < 6
       ON CONFLICT DO NOTHING`,
      [h.sessionId, jobId, acEngineers.map((e) => e.id), "2026-11-18", "2026-12-04"],
    );
  }

  it("a fully booked horizon is escalated server-side as an Out of Policy (capacity) ticket", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    await fillAcHorizon(h);
    const customer: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };

    const res = await toolTurn(customer, "Can someone look at my AC?", "get_availability", {
      issueType: AC_CUSTOMER.issueType,
      postcode: AC_CUSTOMER.postcode,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.windows).toEqual([]);
    expect(res.result.escalation).toMatchObject({ outOfPolicy: true, ticketReference: expect.stringMatching(/^APX-H-/) });
    const tickets = await outOfPolicyTickets(customer);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ ticketReference: res.result.escalation.ticketReference, urgency: "Normal" });
    expect(tickets[0]!.summary).toMatch(/AC Repair & Install/);
  });

  it("during a gas/CO Emergency get_availability is blocked and raises no capacity ticket", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    await fillAcHorizon(h);
    const customer: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };
    await h.service.sendCustomerMessage(h.sessionId, customer.conversationId, "I can smell gas");

    const res = await toolTurn(customer, "Can someone look at my AC?", "get_availability", {
      issueType: AC_CUSTOMER.issueType,
      postcode: AC_CUSTOMER.postcode,
    });

    expect(res.ok).toBe(false);
    expect(await outOfPolicyTickets(customer)).toEqual([]);
  });
});

describe("Reschedule and cancel during a gas/CO Emergency", () => {
  it("a Customer can still cancel a Visit, but a reschedule is refused", async () => {
    const { h, jobReference, visit } = await bookedAndVerified();
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I can smell gas in the hall");

    const reschedule = await toolTurn(h, "Can we move it to Monday?", "propose_reschedule", {
      visitId: visit.visitId,
      date: "2026-11-23",
      timeWindow: "PM",
    });
    expect(reschedule.ok).toBe(false);

    const proposal = await toolTurn(h, "Actually, just cancel it", "propose_cancellation", { visitId: visit.visitId });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const confirmed = await toolTurn(h, "yes cancel it", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(confirmed.ok && confirmed.result).toMatchObject({ cancelled: true, jobStatus: "Cancelled" });
    expect((await jobOnDashboard(h, jobReference)).job.jobStatus).toBe("Cancelled");
  });

  it("a reschedule proposed before the gas Emergency can't be confirmed while it is unresolved", async () => {
    const { h, jobReference, visit } = await bookedAndVerified();
    const proposal = await toolTurn(h, "Move it to Monday afternoon", "propose_reschedule", {
      visitId: visit.visitId,
      date: "2026-11-23",
      timeWindow: "PM",
    });
    if (!proposal.ok) throw new Error(proposal.error);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "the CO alarm is going off");

    const confirmed = await toolTurn(h, "yes move it", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(confirmed.ok).toBe(false);
    expect((await jobOnDashboard(h, jobReference)).job.visits[0]).toMatchObject({ date: FRIDAY_AM.date });
  });
});
