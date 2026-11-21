import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
import { ScriptedModelClient, reply, text, toolCall } from "@/server/testing/scripted-model-client";

const WEDNESDAY = london("2026-11-18T11:30");

async function chat() {
  const model = new ScriptedModelClient();
  const harness = { ...(await createHarness({ now: WEDNESDAY, modelClient: model })), model };
  const sessionId = await harness.service.createDemoSession();
  const conversationId = await harness.service.openConversation(sessionId, undefined);
  const send = (text: string) => harness.service.sendCustomerMessage(sessionId, conversationId, text);
  return { ...harness, sessionId, conversationId, send };
}

describe("Emergency pre-filter → Safety Script → Critical Handoff Ticket", () => {
  it("a gas Emergency gets the gas Safety Script and a Critical ticket, without calling the model", async () => {
    const { service, model, sessionId, conversationId, send } = await chat();

    const { replies } = await send("Help, I think I smell gas in the hallway");

    expect(model.requests).toHaveLength(0);
    const script = replies.find((r) => r.kind === "safety_script");
    expect(script).toBeDefined();
    expect(script!.payload).toMatchObject({ emergencyKind: "gas_or_co" });
    const bullets = (script!.payload as { bullets: string[] }).bullets;
    expect(bullets.some((b) => b.includes("0800 111 999"))).toBe(true);

    const { handoffTickets } = await service.getDashboardState(sessionId);
    const top = handoffTickets[0]!;
    expect(top).toMatchObject({
      escalationReason: "Emergency",
      urgency: "Critical",
      status: "Open",
      conversationId,
    });
    expect(top.summary.length).toBeGreaterThan(0);
    expect(top.recommendedNextStep.length).toBeGreaterThan(0);
    // The Customer is given the ticket ID.
    expect(replies.some((r) => (r.payload as { ticketReference?: string } | null)?.ticketReference === top.ticketReference)).toBe(true);
  });

  it("a second Emergency message appends to the open ticket and quotes its ID; no duplicate", async () => {
    const { service, sessionId, conversationId, send } = await chat();
    await send("I smell gas");
    const before = (await service.getDashboardState(sessionId)).handoffTickets.filter(
      (t) => t.conversationId === conversationId,
    );
    expect(before).toHaveLength(1);
    const ticketReference = before[0]!.ticketReference;

    const { replies } = await send("the CO alarm has started going off too");

    expect(replies.some((r) => r.kind === "safety_script")).toBe(true);
    const notice = replies.find((r) => r.kind === "handoff_notice");
    expect(notice!.payload).toMatchObject({ ticketReference, isNewTicket: false });
    expect(notice!.text).toContain(ticketReference);
    const after = (await service.getDashboardState(sessionId)).handoffTickets.filter(
      (t) => t.conversationId === conversationId,
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.timeline.map((e) => e.kind)).toEqual(["created", "appended"]);
    expect(after[0]!.timeline[1]!.text).toContain("CO alarm");
  });

  it("each conversation gets its own Emergency ticket, numbered after the seed tickets", async () => {
    const { service, sessionId, send } = await chat();
    const other = await service.openConversation(sessionId, crypto.randomUUID());

    await send("gas leak!");
    await service.sendCustomerMessage(sessionId, other, "gas leak!");

    const refs = (await service.getDashboardState(sessionId)).handoffTickets
      .filter((t) => t.escalationReason === "Emergency" && t.conversationId)
      .map((t) => t.ticketReference)
      .sort();
    // The seed world has 2 tickets.
    expect(refs).toEqual(["APX-H-0003", "APX-H-0004"]);
  });

  it("the pre-filter runs on every message: an Emergency mid-conversation is caught, and the model then learns of the ticket", async () => {
    const { service, model, sessionId, conversationId, send } = await chat();
    model.script(reply([text("A boiler service is £89. Shall I book one?")]));
    const routine = await send("How much is a gas boiler service? There's no gas smell, it's just due.");
    expect(routine.replies[0]!.kind).toBe("text");
    expect(model.requests).toHaveLength(1);

    const emergency = await send("Actually wait, I can smell gas now");
    expect(model.requests).toHaveLength(1);
    expect(emergency.replies.some((r) => r.kind === "safety_script")).toBe(true);
    const ticket = (await service.getDashboardState(sessionId)).handoffTickets.find(
      (t) => t.conversationId === conversationId,
    )!;
    expect(ticket.urgency).toBe("Critical");

    // The next ordinary message reaches the model with a valid history that
    // tells it about the open Emergency ticket.
    model.script(reply([text("I've left the house.")]));
    await send("OK I'm outside now, what happens next?");
    const request = model.requests[1]!;
    expect(JSON.stringify(request.messages)).toContain(ticket.ticketReference);
  });

  it("an Emergency ticket carries the Customer's details once they are verified", async () => {
    const { service, model, sessionId, conversationId, send } = await chat();
    const sarah = (await service.getDashboardState(sessionId)).demoCustomers.find(
      (c) => c.fullName === "Sarah Mitchell",
    )!;
    model.script(
      reply([toolCall("verify_customer", { jobReference: sarah.jobReferences[0], postcode: sarah.postcode })]),
      reply([text("Thanks Sarah, you're verified.")]),
    );
    await send(`My reference is ${sarah.jobReferences[0]}, postcode ${sarah.postcode}`);

    await send("there's water pouring from the boiler");

    const ticket = (await service.getDashboardState(sessionId)).handoffTickets.find(
      (t) => t.conversationId === conversationId,
    )!;
    expect(ticket.customer).toMatchObject({ fullName: "Sarah Mitchell", postcode: sarah.postcode });
  });

  it("the pre-filter firing is recorded in the Agent Trace", async () => {
    const { service, sessionId, conversationId, send } = await chat();
    await send("there are sparks coming from the boiler");
    const entry = (await service.getDashboardState(sessionId)).agentTrace.find(
      (e) => e.conversationId === conversationId,
    );
    expect(entry).toMatchObject({ kind: "emergency_prefilter" });
  });

  it("a flood Emergency gets the flood/sparks Safety Script", async () => {
    const { model, send } = await chat();

    const { replies } = await send("water pouring through the kitchen ceiling!!");

    expect(model.requests).toHaveLength(0);
    const script = replies.find((r) => r.kind === "safety_script");
    expect(script!.payload).toMatchObject({ emergencyKind: "flood_or_sparks" });
  });
});
