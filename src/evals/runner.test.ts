import { describe, expect, it } from "vitest";
import { ScriptedModelClient, reply, text, toolCall } from "@/server/testing/scripted-model-client";
import type { ModelClient } from "@/server/model-client";
import { called, newJobs, ticketsInConversation } from "./facts";
import { MeteredModelClient, formatReport, requireApiKey, runScenario, type Scenario } from "./scenario";

const BOOKING_DETAILS = {
  fullName: "Rosa Example",
  postcode: "SW4 9ZZ",
  email: "rosa.example@example.com",
  issueType: "Boiler Service",
};

const bookingScenario: Scenario = {
  id: "mini-booking",
  title: "Mini booking",
  covers: ["#5"],
  steps: [
    { customer: "Book my boiler service please. Rosa Example, SW4 9ZZ, rosa.example@example.com, 20 Nov AM." },
    { customer: "Yes, go ahead." },
  ],
  expect: [
    called("propose_booking"),
    newJobs((jobs) => jobs.length === 1 && jobs[0]!.visits.length === 1, "one new Job with one Visit"),
  ],
};

/** An Agent that answers every call with plain text and never uses a tool. */
const doNothingAgent: ModelClient = {
  async createMessage() {
    return reply([text("Sure, let me know if there's anything else.")]);
  },
};

describe("Eval scenario runner (Seam 1, scripted model)", () => {
  it("passes a scenario when the Agent's tool calls produce the expected dashboard state", async () => {
    const model = new ScriptedModelClient();
    let pendingActionId = "";
    model.script(
      reply([toolCall("propose_booking", { ...BOOKING_DETAILS, date: "2026-11-20", timeWindow: "AM" })]),
      (request) => {
        const last = request.messages.at(-1)!;
        const block = (last.content as Array<{ type: string; content?: string }>).find((b) => b.type === "tool_result")!;
        pendingActionId = JSON.parse(block.content!).pendingActionId;
        return reply([text("Shall I book Friday AM?")]);
      },
      () => reply([toolCall("confirm_action", { pendingActionId })]),
      reply([text("Booked.")]),
    );

    const result = await runScenario(bookingScenario, { modelClient: model, now: "2026-11-18T09:30" });

    expect(result.passed).toBe(true);
    expect(result.facts.every((f) => f.ok)).toBe(true);
    expect(result.toolCalls).toEqual(["propose_booking", "confirm_action"]);
    expect(formatReport([result])).toMatch(/PASS\s+mini-booking/);
  });

  it("fails a scenario when the Agent does nothing, naming the missing fact and what was observed", async () => {
    const result = await runScenario(bookingScenario, { modelClient: doNothingAgent, now: "2026-11-18T09:30" });

    expect(result.passed).toBe(false);
    const failed = result.facts.filter((f) => !f.ok).map((f) => f.fact);
    expect(failed).toEqual(["propose_booking was called", "one new Job with one Visit"]);
    const report = formatReport([result]);
    expect(report).toMatch(/FAIL\s+mini-booking/);
    expect(report).toContain("propose_booking was called");
    expect(report).toContain("1 failed");
    // The transcript of a failed scenario helps diagnose it (it is never asserted on).
    expect(report).toContain("Customer: Yes, go ahead.");
    expect(report).toContain("Agent: Sure, let me know if there's anything else.");
  });

  it("fails any scenario in which the Agent errored (e.g. the API rejected a request)", async () => {
    const broken: ModelClient = {
      async createMessage() {
        throw new Error("400 invalid_request_error");
      },
    };
    const scenario: Scenario = { ...bookingScenario, expect: [] };

    const result = await runScenario(scenario, { modelClient: broken, now: "2026-11-18T09:30" });

    expect(result.passed).toBe(false);
    expect(result.facts.find((f) => !f.ok)?.fact).toBe("the Agent never errored");
    expect(result.facts.find((f) => !f.ok)?.observed).toContain("400 invalid_request_error");
  });

  it("runs Operator steps between Customer turns and resolves Customer text from the world", async () => {
    const seen: string[] = [];
    const recorder: ModelClient = {
      async createMessage(request) {
        const last = request.messages.filter((m) => m.role === "user").at(-1)!;
        if (typeof last.content === "string") seen.push(last.content);
        else for (const b of last.content) if (b.type === "text") seen.push(b.text);
        return reply([text("ok")]);
      },
    };
    const scenario: Scenario = {
      id: "operator-step",
      title: "Operator step",
      covers: ["#12"],
      steps: [
        {
          operator: "advance Sarah's part to Arrived",
          act: async (w) => {
            const part = w.state.partsOrders.find((p) => p.customerName === "Sarah Mitchell")!;
            await w.service.advancePartsStatus(w.sessionId, part.id, part.partsStatus);
          },
        },
        { customer: (w) => `Part is ${w.state.partsOrders.find((p) => p.customerName === "Sarah Mitchell")!.partsStatus}` },
      ],
      expect: [],
    };

    const result = await runScenario(scenario, { modelClient: recorder, now: "2026-11-18T09:30" });

    expect(result.passed).toBe(true);
    expect(seen).toContain("Part is Arrived");
  });

  it("only counts tickets and Jobs from the scenario's own conversation, not the seed", async () => {
    const scenario: Scenario = {
      ...bookingScenario,
      expect: [
        ticketsInConversation((t) => t.length === 0, "no Handoff Tickets"),
        newJobs((j) => j.length === 0, "no new Jobs"),
      ],
    };
    const result = await runScenario(scenario, { modelClient: doNothingAgent, now: "2026-11-18T09:30" });
    expect(result.passed).toBe(true);
  });

  it("meters token usage across calls and estimates the cost in the report", async () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const metered = new MeteredModelClient({
      async createMessage() {
        return { ...reply([text("ok")]), usage };
      },
    });
    await metered.createMessage({ max_tokens: 10, messages: [] });
    await metered.createMessage({ max_tokens: 10, messages: [] });

    expect(metered.usage).toMatchObject({ calls: 2, inputTokens: 2_000_000, outputTokens: 200_000 });
    // Sonnet 5.5: $2/MTok input, $10/MTok output -> 2*2 + 0.2*10 = $6.00
    expect(metered.estimatedCostUsd()).toBeCloseTo(6, 5);
    expect(formatReport([], metered)).toContain("$6.00");
  });
});

describe("Eval suite guard", () => {
  it("refuses to run without ANTHROPIC_API_KEY, saying how to fix it", () => {
    expect(() => requireApiKey({})).toThrow(/ANTHROPIC_API_KEY.*npm run eval/s);
    expect(requireApiKey({ ANTHROPIC_API_KEY: "sk-test" })).toBe("sk-test");
  });
});
