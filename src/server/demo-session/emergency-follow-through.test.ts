import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@/server/model-client";
import { london } from "@/server/testing/harness";
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

/** The harness's system messages delivered at the start of the request's last Customer turn. */
function systemMessagesAfterLastCustomerMessage(request: ModelRequest): string[] {
  const { messages } = request;
  const i = messages.findLastIndex((m) => m.role === "user" && typeof m.content === "string");
  return messages.slice(i + 1).filter((m) => m.role === "system").map((m) => JSON.stringify(m.content));
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
    const notes = systemMessagesAfterLastCustomerMessage(latest).join(" ");
    expect(notes).toContain(ticket.ticketReference);
    expect(notes).toContain("0800 111 999");
  });

  it("the block is per conversation, and a flood Emergency doesn't block normal booking", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const gasConversation = await h.service.openConversation(h.sessionId, crypto.randomUUID());
    await h.service.sendCustomerMessage(h.sessionId, gasConversation, "gas leak!");
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

    const notes = systemMessagesAfterLastCustomerMessage(h.model.requests.at(-1)!).join(" ");
    expect(notes).toContain(ticket.ticketReference);
    expect(notes).toContain("propose_emergency_visit");
  });
});
