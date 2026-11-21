import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import type { AgentTool, PreModelHook } from "@/server/agent";
import {
  AGENT_ERROR_REPLY,
  MAX_MODEL_CALLS_PER_TURN,
  MODEL_REFUSAL_REPLY,
  OFF_TOPIC_REFUSAL,
} from "@/server/agent";
import { PRICE_LIST } from "@/server/agent/price-list";
import { ConversationNotFoundError, EmptyCustomerMessageError } from "@/server/demo-session";
import { createHarness, london } from "@/server/testing/harness";
import {
  ScriptedModelClient,
  assertValidMessages,
  lastToolResults,
  refusal,
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

  it("when the model refuses, the Customer gets the scripted reply, no tool runs, and the trace records it", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(
      reply([toolCall("check_coverage_area", { postcode: "SW4 7AA" })]),
      { ...refusal("general_harms"), content: [toolCall("check_coverage_area", { postcode: "SE5 1AA" })] },
    );

    const result = await service.sendCustomerMessage(sessionId, conversationId, "Do you cover SW4?");

    expect(result.replies.map((r) => [r.kind, r.text])).toEqual([["model_refusal", MODEL_REFUSAL_REPLY]]);
    const { agentTrace } = await service.getDashboardState(sessionId);
    expect(agentTrace.map((e) => [e.kind, e.toolName])).toEqual([
      ["tool_call", "check_coverage_area"],
      ["refusal", null],
    ]);
    expect(agentTrace[1]!.result).toContain("general_harms");

    model.script(reply([text("We cover SW4.")]));
    const next = await service.sendCustomerMessage(sessionId, conversationId, "Sorry, I meant SW4?");
    expect(next.replies.map((r) => r.kind)).toEqual(["text"]);
  });

  it("when the model can't be reached, the Customer gets an apology and the next turn still works", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(() => {
      throw new Error("529 overloaded");
    });

    const result = await service.sendCustomerMessage(sessionId, conversationId, "Hello?");

    expect(result.replies.map((r) => [r.kind, r.text])).toEqual([["agent_error", AGENT_ERROR_REPLY]]);
    expect((await service.getDashboardState(sessionId)).agentTrace.map((e) => e.kind)).toEqual(["error"]);

    model.script(reply([text("Hello! How can I help?")]));
    const next = await service.sendCustomerMessage(sessionId, conversationId, "Hello again");
    expect(next.replies.map((r) => r.kind)).toEqual(["text"]);
    expect(next.conversation.map((m) => m.speaker)).toEqual(["Customer", "Agent", "Customer", "Agent"]);
  });

  it("a turn that keeps calling tools is stopped after a bounded number of model calls", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    const loop = () => reply([toolCall("check_coverage_area", { postcode: "SW4 7AA" })]);
    model.script(...Array.from({ length: MAX_MODEL_CALLS_PER_TURN }, loop));

    const result = await service.sendCustomerMessage(sessionId, conversationId, "SW4?");

    expect(result.replies.map((r) => r.kind)).toEqual(["agent_error"]);
    expect(model.requests.length).toBeLessThanOrEqual(MAX_MODEL_CALLS_PER_TURN);
    model.script(reply([text("Yes.")]));
    expect((await service.sendCustomerMessage(sessionId, conversationId, "SW4?")).replies[0]!.kind).toBe("text");
  });

  describe("what the model is sent", () => {
    async function twoTurns() {
      const h = await chatHarness();
      h.model.script(
        reply([thinking(), toolCall("check_coverage_area", { postcode: "SW4 7AA" })]),
        reply([text("Yes, we cover SW4.")]),
      );
      await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "Do you cover SW4 7AA?");
      h.clock.set(london("2026-11-18T11:42"));
      h.model.script(reply([text("A boiler service is £89.")]));
      await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "How much is a boiler service?");
      return h;
    }

    it("keeps tools and system prompt byte-identical across a conversation, and only appends to history", async () => {
      const { model } = await twoTurns();
      const [first, ...rest] = model.requests;
      for (const r of rest) {
        expect(JSON.stringify(r.tools)).toBe(JSON.stringify(first!.tools));
        expect(JSON.stringify(r.system)).toBe(JSON.stringify(first!.system));
      }
      for (let i = 1; i < model.requests.length; i++) {
        const prev = model.requests[i - 1]!.messages;
        expect(model.requests[i]!.messages.slice(0, prev.length)).toEqual(prev);
      }
      // Thinking blocks go back to the model verbatim.
      expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain("sig_fake");
    });

    it("shares the cached prefix across Demo Sessions: only the block after the breakpoint differs", async () => {
      const a = await twoTurns();
      const b = await chatHarness();
      b.clock.set(london("2026-11-18T14:05"));
      const laterConversation = await b.service.openConversation(b.sessionId, undefined);
      b.model.script(reply([text("Hi!")]));
      await b.service.sendCustomerMessage(b.sessionId, laterConversation, "Hi");

      const [reqA, reqB] = [a.model.requests[0]!, b.model.requests[0]!];
      expect(JSON.stringify(reqB.tools)).toBe(JSON.stringify(reqA.tools));
      const [stableA, factsA] = reqA.system as { text: string; cache_control?: unknown }[];
      const [stableB, factsB] = reqB.system as { text: string; cache_control?: unknown }[];
      expect(stableA!.cache_control).toEqual({ type: "ephemeral" });
      expect(stableB).toEqual(stableA);
      expect(factsB!.text).not.toBe(factsA!.text);
    });

    it("gives the current time as a system notice right after each Customer message", async () => {
      const { model } = await twoTurns();
      const messages = model.requests.at(-1)!.messages;
      const customerTurns = messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.role === "user" && typeof m.content === "string");
      expect(customerTurns).toHaveLength(2);
      for (const { i } of customerTurns) expect(messages[i + 1]!.role).toBe("system");
      expect(JSON.stringify(messages[customerTurns[1]!.i + 1])).toContain("11:42");
    });

    it("uses auto tool choice, strict schemas sorted by name, adaptive thinking and no sampling settings", async () => {
      const { model } = await twoTurns();
      const req = model.requests[0]!;
      expect(req.tool_choice).toEqual({ type: "auto" });
      expect(req.thinking).toEqual({ type: "adaptive" });
      const tools = req.tools as { name: string; strict?: boolean }[];
      expect(tools.map((t) => t.name)).toEqual([...tools.map((t) => t.name)].sort());
      expect(tools.every((t) => t.strict === true)).toBe(true);
      expect(req).not.toHaveProperty("temperature");
      expect(req).not.toHaveProperty("top_p");
    });

    it("includes every published Price List figure", async () => {
      const { model } = await twoTurns();
      const system = JSON.stringify(model.requests[0]!.system);
      for (const figure of ["£95", "£89", "£75", "£120"]) expect(system).toContain(figure);
      // Every published entry, including the free heat pump survey (facts, not prompt wording).
      for (const { item, price } of PRICE_LIST) {
        expect(system).toContain(item);
        expect(system).toContain(price);
      }
    });
  });

  describe("extension points for domain tools and pre-model hooks", () => {
    const systemMessagesAfterLastCustomerMessage = (messages: BetaMessageParam[]) => {
      const i = messages.findLastIndex((m) => m.role === "user" && typeof m.content === "string");
      return messages.slice(i + 1).filter((m) => m.role === "system").map((m) => JSON.stringify(m.content));
    };

    it("a system note queued by a tool reaches the model right after the next Customer message, once", async () => {
      const seqs: number[] = [];
      const raiseFlag: AgentTool = {
        name: "raise_flag",
        description: "test tool",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        async run(_input, ctx) {
          seqs.push(ctx.customerMessage.seq);
          await ctx.enqueueSystemNote("Ticket APX-H-0003 is open. Do not book.");
          return { ok: true, result: { raised: true } };
        },
      };
      const model = new ScriptedModelClient();
      const h = await createHarness({ now: WEDNESDAY, modelClient: model, agentTools: [raiseFlag] });
      const sessionId = await h.service.createDemoSession();
      const conversationId = await h.service.openConversation(sessionId, undefined);

      model.script(reply([toolCall("raise_flag", {})]), reply([text("Raised.")]));
      await h.service.sendCustomerMessage(sessionId, conversationId, "first");
      model.script(reply([text("Noted.")]));
      await h.service.sendCustomerMessage(sessionId, conversationId, "second");
      model.script(reply([text("Still noted.")]));
      await h.service.sendCustomerMessage(sessionId, conversationId, "third");

      const notesIn = (request: number) =>
        systemMessagesAfterLastCustomerMessage(model.requests[request]!.messages).join(" ");
      expect(notesIn(1)).not.toContain("APX-H-0003"); // same turn: not yet
      expect(notesIn(2)).toContain("APX-H-0003"); // delivered with the next Customer message
      expect(notesIn(3)).not.toContain("APX-H-0003"); // not repeated…
      expect(JSON.stringify(model.requests[3]!.messages)).toContain("APX-H-0003"); // …but kept in history
      expect(seqs).toHaveLength(1);
    });

    it("a pre-model hook can handle a turn without calling the model; the conversation carries on", async () => {
      const prefilter: PreModelHook = async (ctx) => {
        if (!ctx.customerMessage.text.includes("smell gas")) return undefined;
        await ctx.recordTrace({ kind: "emergency_prefilter", result: "gas_or_co" });
        await ctx.enqueueSystemNote("Emergency ticket open. Do not book.");
        return {
          replies: [{ kind: "text", text: "Leave the property and call 0800 111 999." }],
          historyNote: "[Safety Script shown]",
        };
      };
      const model = new ScriptedModelClient();
      const h = await createHarness({ now: WEDNESDAY, modelClient: model, preModelHooks: [prefilter] });
      const sessionId = await h.service.createDemoSession();
      const conversationId = await h.service.openConversation(sessionId, undefined);

      const handled = await h.service.sendCustomerMessage(sessionId, conversationId, "I smell gas");
      expect(handled.replies.map((r) => r.text)).toEqual(["Leave the property and call 0800 111 999."]);
      expect(model.requests).toHaveLength(0);
      expect((await h.service.getDashboardState(sessionId)).agentTrace.map((e) => e.kind)).toEqual([
        "emergency_prefilter",
      ]);

      model.script(reply([text("A boiler service is £89.")]));
      const next = await h.service.sendCustomerMessage(sessionId, conversationId, "How much is a service?");
      expect(next.replies.map((r) => r.kind)).toEqual(["text"]);
      const messages = model.requests[0]!.messages;
      expect(JSON.stringify(messages)).toContain("I smell gas");
      expect(JSON.stringify(messages)).toContain("[Safety Script shown]");
      expect(systemMessagesAfterLastCustomerMessage(messages).join(" ")).toContain("Emergency ticket open");
      expect(next.conversation.map((m) => m.speaker)).toEqual(["Customer", "Agent", "Customer", "Agent"]);
    });
  });

  it("a conversation belongs to its Demo Session: another session can't read or write it", async () => {
    const a = await chatHarness();
    a.model.script(reply([text("Hello!")]));
    await a.service.sendCustomerMessage(a.sessionId, a.conversationId, "Hi");
    const b = await chatHarness();

    await expect(b.service.getConversation(b.sessionId, a.conversationId)).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
    await expect(b.service.sendCustomerMessage(b.sessionId, a.conversationId, "Hi")).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
    // Opening someone else's conversation id starts a fresh one instead.
    const opened = await b.service.openConversation(b.sessionId, a.conversationId);
    expect(opened).not.toBe(a.conversationId);
    expect(await b.service.getConversation(b.sessionId, opened)).toEqual([]);
  });

  it("an empty Customer message is rejected without reaching the Agent", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    await expect(service.sendCustomerMessage(sessionId, conversationId, "   ")).rejects.toBeInstanceOf(
      EmptyCustomerMessageError,
    );
    expect(model.requests).toHaveLength(0);
    expect(await service.getConversation(sessionId, conversationId)).toEqual([]);
  });

  it("a reply cut off at max_tokens mid tool call is retried rather than running a truncated call", async () => {
    const { service, model, sessionId, conversationId } = await chatHarness();
    model.script(
      reply([toolCall("check_coverage_area", { postcode: "SW" })], "max_tokens"),
      reply([toolCall("check_coverage_area", { postcode: "SW4 7AA" })]),
      reply([text("Yes, we cover SW4.")]),
    );

    await service.sendCustomerMessage(sessionId, conversationId, "SW4 7AA?");

    const { agentTrace } = await service.getDashboardState(sessionId);
    expect(agentTrace.map((e) => e.input)).toEqual([{ postcode: "SW4 7AA" }]);
    expect(model.requests[1]!.max_tokens).toBeGreaterThan(model.requests[0]!.max_tokens);
    expect(model.requests[1]!.messages).toEqual(model.requests[0]!.messages);
  });
});
