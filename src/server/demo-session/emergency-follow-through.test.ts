import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { queuedNotes } from "@/server/testing/queued-notes";
import { reply, text } from "@/server/testing/scripted-model-client";
import { chatHarness, toolTurn, toolTurns, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

const NEW_CUSTOMER = {
  fullName: "Hannah Brooks",
  postcode: "sw4 9zz",
  email: "hannah.brooks@example.com",
  issueType: "Boiler Repair",
};

const pick = (w: { date?: string; timeWindow?: string } = {}) => ({ date: w.date, timeWindow: w.timeWindow });

/** The Agent checks Availability and proposes the first window, in one turn. */
async function proposeFirstWindow(h: ChatHarness) {
  const [availability, proposal] = await toolTurns(h, "Can you book me the earliest repair slot?", [
    ["get_availability", { issueType: NEW_CUSTOMER.issueType, postcode: NEW_CUSTOMER.postcode }],
    ["propose_booking", (prev) => ({ ...NEW_CUSTOMER, ...pick(prev[0]!.ok ? prev[0]!.result.windows[0] : {}) })],
  ]);
  return { availability: availability!, proposal: proposal! };
}

async function openEmergencyTicket(h: ChatHarness) {
  const state = await h.service.getDashboardState(h.sessionId);
  return state.handoffTickets.find(
    (t) => t.conversationId === h.conversationId && t.escalationReason === "Emergency" && t.status !== "Resolved",
  )!;
}

describe("Gas/CO Emergency: no booking until an Operator resolves the ticket", () => {
  it("booking tools refuse during an unresolved gas Emergency and succeed after the Operator resolves it", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I think I smell gas in the kitchen");

    const blocked = await proposeFirstWindow(h);
    expect(blocked.availability.ok).toBe(false);
    expect(blocked.proposal.ok).toBe(false);

    const ticket = await openEmergencyTicket(h);
    await h.service.resolveHandoffTicket(h.sessionId, ticket.id);

    const { proposal } = await proposeFirstWindow(h);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const confirmed = await toolTurn(h, "yes please", "confirm_action", {
      pendingActionId: proposal.result.pendingActionId,
    });
    expect(confirmed.ok).toBe(true);
  });

  it("the block covers the whole Demo Session: a New chat does not escape it", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I think I smell gas in the kitchen");
    const second = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };

    const blocked = await proposeFirstWindow(second);
    expect(blocked.availability.ok).toBe(false);
    expect(blocked.proposal.ok).toBe(false);

    const ticket = await openEmergencyTicket(h);
    await h.service.resolveHandoffTicket(h.sessionId, ticket.id);
    expect((await proposeFirstWindow(second)).proposal.ok).toBe(true);
  });

  it("a booking proposed in a New chat can't be confirmed once a gas Emergency opens in another chat", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const second = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };
    const { proposal } = await proposeFirstWindow(second);
    if (!proposal.ok) throw new Error(proposal.error);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "hang on, the CO alarm is going off");

    const confirmed = await toolTurn(second, "ok, yes book it", "confirm_action", {
      pendingActionId: proposal.result.pendingActionId,
    });
    expect(confirmed.ok).toBe(false);
  });

  it("a booking proposed before the gas Emergency can't be confirmed while it is unresolved", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);
    const { proposal } = await proposeFirstWindow(h);
    if (!proposal.ok) throw new Error(proposal.error);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "hang on, the CO alarm is going off");

    const confirmed = await toolTurn(h, "ok, yes book it", "confirm_action", {
      pendingActionId: proposal.result.pendingActionId,
    });

    expect(confirmed.ok).toBe(false);
    const after = await h.service.getDashboardState(h.sessionId);
    expect(after.jobs).toHaveLength(before.jobs.length);
  });

  it("the model learns of the gas Emergency through a mid-conversation system message, not the system prompt", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    h.model.script(reply([text("A boiler repair visit starts with a £95 call-out.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "how much is a boiler repair?");
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "wait, I can smell gas");
    const ticket = await openEmergencyTicket(h);

    h.model.script(reply([text("Please follow the safety advice.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "can you still book me in for tomorrow?");

    const [first, latest] = [h.model.requests[0]!, h.model.requests.at(-1)!];
    expect(latest.system).toEqual(first.system);
    const notes = queuedNotes(latest).join(" ");
    expect(notes).toContain(ticket.ticketReference);
    expect(notes).toContain("0800 111 999");
  });

  it("when the Operator resolves the gas Emergency, the model is told through a mid-conversation system message", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");
    const ticket = await openEmergencyTicket(h);
    h.model.script(reply([text("Please follow the safety advice.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "ok, I'm outside");
    h.model.script(reply([text("Please wait for the gas engineers.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "still waiting");
    expect(queuedNotes(h.model.requests.at(-1)!).join(" ")).not.toContain(
      ticket.ticketReference,
    );

    await h.service.resolveHandoffTicket(h.sessionId, ticket.id);
    h.model.script(reply([text("Happy to help with a booking.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "all sorted now, can I book a repair?");

    const latest = h.model.requests.at(-1)!;
    expect(latest.system).toEqual(h.model.requests[0]!.system);
    expect(queuedNotes(latest).join(" ")).toContain(ticket.ticketReference);
  });

  it("resolving a flood Emergency or a non-Emergency ticket queues no such note", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "water pouring from the ceiling");
    const ticket = await openEmergencyTicket(h);
    h.model.script(reply([text("An Engineer can come.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "ok");

    await h.service.resolveHandoffTicket(h.sessionId, ticket.id);
    h.model.script(reply([text("Anything else?")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "thanks");

    expect(queuedNotes(h.model.requests.at(-1)!).join(" ")).not.toContain(
      ticket.ticketReference,
    );
  });

  it("a flood Emergency doesn't block normal booking, in its own chat or another", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const floodConversation = await h.service.openConversation(h.sessionId, crypto.randomUUID());
    await h.service.sendCustomerMessage(h.sessionId, floodConversation, "water pouring from the ceiling");
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "water pouring from the ceiling");

    const { proposal } = await proposeFirstWindow(h);

    expect(proposal.ok).toBe(true);
  });
});

// Tuesday evening: Wednesday's windows are normally bookable (2h lead time).
const TUESDAY_1900 = london("2026-11-17T19:00");
const WEDNESDAY = "2026-11-18";

/** Books ordinary Visits (each in its own conversation) until Wednesday has no Availability left. */
async function fillWednesday(h: ChatHarness, issueType: string) {
  for (let i = 0; i < 20; i++) {
    const other: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, crypto.randomUUID()) };
    const availability = await toolTurn(other, "book me in", "get_availability", { issueType, postcode: "SW4 9ZZ" });
    if (!availability.ok) throw new Error(availability.error);
    const first = availability.result.windows[0];
    if (first.date !== WEDNESDAY) return;
    const proposal = await toolTurn(other, "the earliest please", "propose_booking", {
      fullName: `Filler Customer ${i}`,
      postcode: "SW4 9ZZ",
      email: `filler${i}@example.com`,
      issueType,
      ...pick(first),
    });
    if (!proposal.ok) throw new Error(proposal.error);
    const confirmed = await toolTurn(other, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
    if (!confirmed.ok) throw new Error(confirmed.error);
  }
  throw new Error("Wednesday never filled up");
}

const FLOODED_CUSTOMER = {
  fullName: "Priya Shah",
  postcode: "SE5 8AA",
  email: "priya.shah@example.com",
  issueType: "Boiler Repair",
};

describe("Flood/sparks Emergency: the earliest Emergency Visit", () => {
  it("can be booked on a day with no normal Availability, and is flagged as an Emergency Visit", async () => {
    const h = await chatHarness(TUESDAY_1900);
    await fillWednesday(h, "Boiler Repair");
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "water is pouring out of the boiler!");

    const proposal = await toolTurn(h, "yes please send someone", "propose_emergency_visit", FLOODED_CUSTOMER);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.result.readBack).toMatchObject({
      date: WEDNESDAY,
      timeWindow: "AM",
      issueType: "Boiler Repair",
      postcode: "SE5 8AA",
    });

    const confirmed = await toolTurn(h, "yes, book it", "confirm_action", {
      pendingActionId: proposal.result.pendingActionId,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    const state = await h.service.getDashboardState(h.sessionId);
    const job = state.jobs.find((j) => j.jobReference === confirmed.result.jobReference)!;
    expect(job.customer).toMatchObject({ fullName: "Priya Shah" });
    expect(job.visits).toEqual([expect.objectContaining({ date: WEDNESDAY, timeWindow: "AM", isEmergencyVisit: true })]);
    const onCalendar = state.calendar.visits.find((v) => v.jobReference === confirmed.result.jobReference)!;
    expect(onCalendar).toMatchObject({ isEmergencyVisit: true, date: WEDNESDAY, timeWindow: "AM" });
    const engineer = state.calendar.engineers.find((e) => e.id === onCalendar.engineerId)!;
    expect(engineer.skills).toContain("Boiler Repair");
  });

  it("is only offered during an open flood/sparks Emergency, never for gas/CO", async () => {
    const h = await chatHarness(TUESDAY_1900);
    const none = await toolTurn(h, "my boiler is broken, send someone now", "propose_emergency_visit", FLOODED_CUSTOMER);
    expect(none.ok).toBe(false);

    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");
    const gas = await toolTurn(h, "please send someone", "propose_emergency_visit", FLOODED_CUSTOMER);
    expect(gas.ok).toBe(false);
  });

  it("the model is told to offer the Emergency Visit through a mid-conversation system message", async () => {
    const h = await chatHarness(TUESDAY_1900);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "sparks coming from the boiler");
    const ticket = await openEmergencyTicket(h);

    h.model.script(reply([text("I can send an Engineer.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "what now?");

    const notes = queuedNotes(h.model.requests.at(-1)!).join(" ");
    expect(notes).toContain(ticket.ticketReference);
    expect(notes).toContain("propose_emergency_visit");
  });
});

describe("Emergency Visit: Engineer choice ignores cancelled Visits", () => {
  it("a cancelled Visit doesn't make an Engineer busier in the Emergency Visit's window", async () => {
    const h = await chatHarness(TUESDAY_1900);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "water is pouring out of the boiler!");
    // Seed, Wednesday AM: of the Boiler Repair Engineers (Dave Okafor, Marta Kowalski,
    // Leon Grant), Marta has a Visit; Dave and Leon are free, and Dave is first on
    // the roster. So the least-busy rule picks Dave, unless his cancelled Visits count.
    const { jobs, calendar: seeded } = await h.service.getDashboardState(h.sessionId);
    const expected = seeded.engineers.find((e) => e.name === "Dave Okafor")!.id;
    // Raw insert: the service can't create cancelled Visits pinned to one Engineer
    // in one window (booking picks the Engineer itself).
    await h.db.query(
      `INSERT INTO visit (session_id, job_id, engineer_id, visit_date, time_window, cancelled_at)
       SELECT $1, $2, $3, $4, 'AM', $5 FROM generate_series(1, 3)`,
      [h.sessionId, jobs[0]!.id, expected, WEDNESDAY, TUESDAY_1900],
    );

    const proposal = await toolTurn(h, "yes please send someone", "propose_emergency_visit", FLOODED_CUSTOMER);
    if (!proposal.ok) throw new Error(proposal.error);
    const confirmed = await toolTurn(h, "yes, book it", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
    if (!confirmed.ok) throw new Error(confirmed.error);

    const { calendar } = await h.service.getDashboardState(h.sessionId);
    const booked = calendar.visits.find((v) => v.jobReference === confirmed.result.jobReference)!;
    expect(booked.engineerId).toBe(expected);
  });
});
