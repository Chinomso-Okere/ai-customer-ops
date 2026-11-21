import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
import { ScriptedModelClient, reply, text } from "@/server/testing/scripted-model-client";

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

  it("a flood Emergency gets the flood/sparks Safety Script", async () => {
    const { model, send } = await chat();

    const { replies } = await send("water pouring through the kitchen ceiling!!");

    expect(model.requests).toHaveLength(0);
    const script = replies.find((r) => r.kind === "safety_script");
    expect(script!.payload).toMatchObject({ emergencyKind: "flood_or_sparks" });
  });
});
