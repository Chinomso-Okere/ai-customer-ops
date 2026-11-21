import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
import { ScriptedModelClient, reply, text } from "@/server/testing/scripted-model-client";

const WEDNESDAY = london("2026-11-18T11:30");

async function chatHarness(model = new ScriptedModelClient()) {
  const harness = await createHarness({ now: WEDNESDAY, modelClient: model });
  const sessionId = await harness.service.createDemoSession();
  const conversationId = await harness.service.openConversation(sessionId, undefined);
  return { ...harness, model, sessionId, conversationId };
}

describe("Agent chat", () => {
  it("a Customer message gets the Agent's reply, and the conversation persists in the Demo Session", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(reply([text("Hello! How can Apex help today?")]));

    const result = await service.sendCustomerMessage(sessionId, conversationId, "Hi there");

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ speaker: "Agent", kind: "text" });
    expect(result.replies[0]!.text.length).toBeGreaterThan(0);

    // Reopening the same conversation resumes it with the full transcript.
    expect(await service.openConversation(sessionId, conversationId)).toBe(conversationId);
    const conversation = await service.getConversation(sessionId, conversationId);
    expect(conversation.map((m) => m.speaker)).toEqual(["Customer", "Agent"]);
    expect(conversation[0]!.text).toBe("Hi there");
    expect(result.conversation).toEqual(conversation);
  });
});
