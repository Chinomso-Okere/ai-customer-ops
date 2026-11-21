import { describe, expect, it } from "vitest";
import { OFF_TOPIC_REFUSAL } from "@/server/agent";
import { createHarness, london } from "@/server/testing/harness";
import {
  ScriptedModelClient,
  assertValidMessages,
  lastToolResults,
  reply,
  text,
  thinking,
  toolCall,
} from "@/server/testing/scripted-model-client";

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

  it("every tool call is recorded in the Agent Trace with its inputs and result", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(
      reply([thinking(), text("Let me check."), toolCall("check_coverage_area", { postcode: "sw4 7aa" })]),
      reply([text("Yes, we cover SW4.")]),
    );

    await service.sendCustomerMessage(sessionId, conversationId, "Do you cover SW4 7AA?");

    const { agentTrace } = await service.getDashboardState(sessionId);
    expect(agentTrace).toHaveLength(1);
    expect(agentTrace[0]).toMatchObject({
      kind: "tool_call",
      conversationId,
      toolName: "check_coverage_area",
      input: { postcode: "sw4 7aa" },
      isError: false,
    });
    expect(JSON.parse(agentTrace[0]!.result!)).toMatchObject({ inCoverageArea: true });
    // The model got exactly what the trace shows.
    const [result] = lastToolResults(model.requests[1]!);
    expect(result!.content).toBe(agentTrace[0]!.result);
  });

  it("parallel tool calls are all answered in one message, and failures go back with is_error", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(
      reply([
        toolCall("check_coverage_area", { postcode: "SE15 4AB" }),
        toolCall("check_coverage_area", { postcode: "M1 1AE" }),
        toolCall("check_coverage_area", {}),
      ]),
      reply([text("SE15 yes, Manchester no.")]),
    );

    await service.sendCustomerMessage(sessionId, conversationId, "SE15 4AB or M1 1AE?");

    const results = lastToolResults(model.requests[1]!);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.is_error ?? false)).toEqual([false, false, true]);
    const { agentTrace } = await service.getDashboardState(sessionId);
    expect(agentTrace.map((e) => [e.toolName, e.isError])).toEqual([
      ["check_coverage_area", false],
      ["check_coverage_area", false],
      ["check_coverage_area", true],
    ]);
    expect(JSON.parse(agentTrace[1]!.result!)).toMatchObject({ inCoverageArea: false });
  });

  it("an unknown tool name is returned to the model as an error rather than crashing the turn", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(reply([toolCall("launch_rocket", {})]), reply([text("Sorry, I can't do that.")]));

    const result = await service.sendCustomerMessage(sessionId, conversationId, "Launch it");

    expect(result.replies.map((r) => r.kind)).toEqual(["text"]);
    expect(lastToolResults(model.requests[1]!)[0]!.is_error).toBe(true);
  });

  it("an off-topic request gets the scripted refusal, without another model call", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(reply([toolCall("refuse_off_topic", {})]));

    const result = await service.sendCustomerMessage(sessionId, conversationId, "Write me a poem about cats");

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ speaker: "Agent", kind: "off_topic_refusal", text: OFF_TOPIC_REFUSAL });
    expect(model.requests).toHaveLength(1);
    const { agentTrace } = await service.getDashboardState(sessionId);
    expect(agentTrace.map((e) => e.toolName)).toEqual(["refuse_off_topic"]);

    // The conversation carries on normally afterwards.
    model.script(reply([text("A boiler service is £89.")]));
    const next = await service.sendCustomerMessage(sessionId, conversationId, "OK, how much is a boiler service?");
    expect(next.replies.map((r) => r.kind)).toEqual(["text"]);
    assertValidMessages(model.requests.at(-1)!.messages);
  });

  it("one Demo Session's Agent Trace never shows another session's tool calls", async () => {
    const a = await chatHarness();
    a.model.script(reply([toolCall("check_coverage_area", { postcode: "SW4 7AA" })]), reply([text("Yes.")]));
    await a.service.sendCustomerMessage(a.sessionId, a.conversationId, "SW4?");
    const b = await chatHarness();

    expect((await b.service.getDashboardState(b.sessionId)).agentTrace).toEqual([]);
    expect((await a.service.getDashboardState(a.sessionId)).agentTrace).toHaveLength(1);
  });
});
