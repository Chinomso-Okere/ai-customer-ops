/**
 * The eval harness: runs scripted multi-turn Customer conversations through
 * the Demo Session service (Seam 1) with whatever model client it is given,
 * then checks facts about the Agent Trace and dashboard state. Never reply
 * wording (spec #1, "Testing Decisions").
 *
 * The real-model suite is `agent.eval.ts` (`npm run eval`); the runner's own
 * mechanics are tested with the scripted fake in `runner.test.ts`.
 */
import type { ChatMessage } from "@/server/agent";
import type { AgentTraceEntry } from "@/server/agent/conversation-store";
import type { Database } from "@/server/db/database";
import type { DashboardState, DemoSessionService } from "@/server/demo-session";
import type { ModelClient, ModelRequest, ModelResponse } from "@/server/model-client";
import { createHarness, london } from "@/server/testing/harness";

/** What a scenario's steps and facts can see. */
export interface EvalWorld {
  service: DemoSessionService;
  db: Database;
  sessionId: string;
  conversationId: string;
  now: Date;
  /** Dashboard state when the Demo Session was created (the seed). */
  initialState: DashboardState;
  /** Dashboard state now (refreshed after every step). */
  state: DashboardState;
  /** This conversation's Agent Trace, oldest first. */
  trace: AgentTraceEntry[];
  /** The trace entries each Customer turn produced, in turn order. */
  turns: AgentTraceEntry[][];
  /** Every Agent message shown to the Customer. */
  replies: ChatMessage[];
  /** Scratch values a step computes for later facts (e.g. a target date). */
  vars: Record<string, unknown>;
}

export type Step =
  /** A Customer message; a function may build it from the world (e.g. a seeded Job Reference). */
  | { customer: string | ((w: EvalWorld) => string | Promise<string>) }
  /** Something an Operator does on the dashboard between Customer turns. */
  | { operator: string; act: (w: EvalWorld) => Promise<void> };

/**
 * A fact that must hold once the conversation is over. `check` returns true,
 * or a short description of what was observed instead.
 */
export interface Fact {
  fact: string;
  check(w: EvalWorld): true | string;
}

export interface Scenario {
  id: string;
  title: string;
  /** The tickets whose behaviour it exercises, e.g. ["#5"]. */
  covers: string[];
  /** London wall-clock "now" for the whole scenario (default: Wednesday 18 Nov 2026, 09:30). */
  now?: string;
  steps: Step[];
  expect: Fact[];
  /**
   * The facts hold whatever the model does, because the server guarantees
   * them (e.g. the Emergency pre-filter, ADR-0002).
   */
  guaranteedWithoutModel?: true;
}

export interface FactResult {
  fact: string;
  ok: boolean;
  observed?: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  covers: string[];
  passed: boolean;
  facts: FactResult[];
  /** Tool names in the order the Agent called them. */
  toolCalls: string[];
  customerTurns: number;
  durationMs: number;
}

export const DEFAULT_SCENARIO_NOW = "2026-11-18T09:30";

/** The fact every scenario gets: no Agent error (e.g. an API 400) in any turn. */
const NO_AGENT_ERRORS: Fact = {
  fact: "the Agent never errored",
  check: (w) => {
    const errors = w.trace.filter((e) => e.kind === "error").map((e) => e.result ?? "");
    const errorReplies = w.replies.filter((r) => r.kind === "agent_error");
    if (errors.length === 0 && errorReplies.length === 0) return true;
    return errors.length ? errors.join("; ") : `${errorReplies.length} agent_error replies`;
  },
};

export async function runScenario(
  scenario: Scenario,
  options: { modelClient: ModelClient; now?: string },
): Promise<ScenarioResult> {
  const started = Date.now();
  const now = london(scenario.now ?? options.now ?? DEFAULT_SCENARIO_NOW);
  const { service, db } = await createHarness({ now, modelClient: options.modelClient });
  const sessionId = await service.createDemoSession();
  const conversationId = await service.openConversation(sessionId, undefined);
  const initialState = await service.getDashboardState(sessionId);
  const w: EvalWorld = {
    service,
    db,
    sessionId,
    conversationId,
    now,
    initialState,
    state: initialState,
    trace: [],
    turns: [],
    replies: [],
    vars: {},
  };
  const refresh = async () => {
    w.state = await service.getDashboardState(sessionId);
    w.trace = w.state.agentTrace.filter((e) => e.conversationId === conversationId);
  };

  const facts: FactResult[] = [];
  let customerTurns = 0;
  try {
    for (const step of scenario.steps) {
      if ("operator" in step) {
        await step.act(w);
      } else {
        const text = typeof step.customer === "function" ? await step.customer(w) : step.customer;
        const before = w.trace.length;
        const { replies } = await service.sendCustomerMessage(sessionId, conversationId, text);
        customerTurns++;
        w.replies.push(...replies);
        await refresh();
        w.turns.push(w.trace.slice(before));
        continue;
      }
      await refresh();
    }
    for (const fact of [NO_AGENT_ERRORS, ...scenario.expect]) {
      const outcome = safeCheck(fact, w);
      facts.push(outcome === true ? { fact: fact.fact, ok: true } : { fact: fact.fact, ok: false, observed: outcome });
    }
  } catch (error) {
    facts.push({ fact: "the scenario ran to the end", ok: false, observed: errorText(error) });
  }

  return {
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    passed: facts.every((f) => f.ok),
    facts,
    toolCalls: w.trace.filter((e) => e.kind === "tool_call").map((e) => e.toolName ?? "?"),
    customerTurns,
    durationMs: Date.now() - started,
  };
}

function safeCheck(fact: Fact, w: EvalWorld): true | string {
  try {
    return fact.check(w);
  } catch (error) {
    return `check threw: ${errorText(error)}`;
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Claude Sonnet 5.5 list prices, USD per million tokens (5-minute cache writes). */
const PRICE_PER_MTOK = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Wraps a model client and adds up the token usage of every call. */
export class MeteredModelClient implements ModelClient {
  readonly usage: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(private readonly inner: ModelClient) {}

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.createMessage(request);
    const u = response.usage;
    this.usage.calls++;
    this.usage.inputTokens += u?.input_tokens ?? 0;
    this.usage.outputTokens += u?.output_tokens ?? 0;
    this.usage.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
    this.usage.cacheWriteTokens += u?.cache_creation_input_tokens ?? 0;
    return response;
  }

  estimatedCostUsd(): number {
    const u = this.usage;
    return (
      (u.inputTokens * PRICE_PER_MTOK.input +
        u.outputTokens * PRICE_PER_MTOK.output +
        u.cacheWriteTokens * PRICE_PER_MTOK.cacheWrite +
        u.cacheReadTokens * PRICE_PER_MTOK.cacheRead) /
      1_000_000
    );
  }
}

/** A readable per-scenario pass/fail report. */
export function formatReport(results: readonly ScenarioResult[], metered?: MeteredModelClient): string {
  const lines: string[] = ["", "Apex Agent eval report", "=".repeat(60)];
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    lines.push(
      `${status}  ${r.id.padEnd(34)} ${r.covers.join(",").padEnd(8)} ${r.customerTurns} turns, ${(r.durationMs / 1000).toFixed(1)}s`,
    );
    if (!r.passed) {
      for (const f of r.facts.filter((f) => !f.ok)) {
        lines.push(`        x ${f.fact}`);
        if (f.observed) lines.push(`          observed: ${f.observed}`);
      }
      lines.push(`          tool calls: ${r.toolCalls.join(" -> ") || "(none)"}`);
    }
  }
  const failed = results.filter((r) => !r.passed).length;
  lines.push("-".repeat(60), `${results.length - failed} passed, ${failed} failed, ${results.length} scenarios`);
  if (metered) {
    const u = metered.usage;
    lines.push(
      `${u.calls} model calls; tokens in ${u.inputTokens}, out ${u.outputTokens}, cache read ${u.cacheReadTokens}, cache write ${u.cacheWriteTokens}`,
      `Estimated cost: $${metered.estimatedCostUsd().toFixed(2)} (Claude Sonnet 5.5 list prices)`,
    );
  }
  return lines.join("\n");
}

/** The eval suite calls the real model: it needs an API key and says so plainly. */
export function requireApiKey(env: Record<string, string | undefined>): string {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "The eval suite calls the real Claude API and needs ANTHROPIC_API_KEY.\n" +
        "Set it (e.g. in .env.local or your shell) and run `npm run eval` again. A full run costs roughly $1-3.",
    );
  }
  return key;
}
