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
