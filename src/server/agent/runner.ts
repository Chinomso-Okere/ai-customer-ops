import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Clock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import type { ModelClient, ModelRequest } from "@/server/model-client";
import * as store from "./conversation-store";
import { AGENT_ERROR_REPLY, MODEL_REFUSAL_REPLY } from "./scripted-replies";
import { buildSystemPrompt, currentTimeNote } from "./system-prompt";
import type {
  AgentReplyDraft,
  AgentTool,
  AgentTurnContext,
  ChatMessage,
  PreModelHook,
  ToolOutcome,
} from "./types";

export interface AgentRunnerDeps {
  db: Database;
  clock: Clock;
  modelClient: ModelClient;
  tools: readonly AgentTool[];
  preModelHooks: readonly PreModelHook[];
}

/** Fixed request settings. Changing any of them between requests invalidates the cache. */
const MAX_TOKENS = 4096;

/** Bounds cost per Customer message: model calls allowed in one turn. */
export const MAX_MODEL_CALLS_PER_TURN = 8;

/**
 * The same tool call (name and input) failing the same way this many times in
 * one turn ends the turn: the model is stuck, so stop before the call budget
 * runs out. The failure before that one tells the model not to repeat it.
 */
export const MAX_IDENTICAL_FAILED_CALLS_PER_TURN = 3;

const REPEATED_CALL_NOTICE =
  "You already made this exact call in this turn and it failed the same way. Do not repeat it: reply to the Customer (e.g. ask for what is missing) instead.";

/**
 * The Agent runner: a self-hosted manual tool loop on the Messages API.
 * One call runs one Customer turn: pre-model hooks, then model calls and tool
 * runs until the model stops calling tools.
 */
export function createAgentRunner(deps: AgentRunnerDeps) {
  const { db, clock, modelClient } = deps;
  const tools = [...deps.tools].sort((a, b) => a.name.localeCompare(b.name));
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolDefinitions: BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    strict: true,
    input_schema: t.inputSchema,
  }));

  async function runTool(
    use: BetaToolUseBlock,
    ctx: AgentTurnContext,
    failures: Map<string, number>,
  ): Promise<{ block: BetaToolResultBlockParam; endTurn?: AgentReplyDraft; stuck?: true }> {
    const tool = toolsByName.get(use.name);
    const input = isRecord(use.input) ? use.input : {};
    let outcome: ToolOutcome;
    try {
      outcome = tool
        ? await tool.run(input, ctx)
        : { ok: false, error: `Unknown tool "${use.name}". Use only the tools provided.` };
    } catch (error) {
      console.error(`Agent tool ${use.name} failed`, error);
      outcome = { ok: false, error: "The tool failed unexpectedly. Apologise and offer to pass this to the team." };
    }
    let stuck = false;
    if (!outcome.ok) {
      const key = `${use.name}\n${canonicalJson(input)}\n${outcome.code ?? ""}\n${outcome.error}`;
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count >= 2) outcome = { ok: false, code: "repeated_failed_call", error: `${outcome.error} ${REPEATED_CALL_NOTICE}` };
      stuck = count >= MAX_IDENTICAL_FAILED_CALLS_PER_TURN;
    }
    const content = outcome.ok
      ? JSON.stringify(outcome.result)
      : outcome.code
        ? JSON.stringify({ errorCode: outcome.code, error: outcome.error })
        : outcome.error;
    await ctx.recordTrace({
      kind: "tool_call",
      toolName: use.name,
      input: use.input,
      result: content,
      isError: !outcome.ok,
    });
    return {
      block: {
        type: "tool_result",
        tool_use_id: use.id,
        content,
        ...(outcome.ok ? {} : { is_error: true }),
      },
      ...(outcome.ok && outcome.endTurn ? { endTurn: outcome.endTurn } : {}),
      ...(stuck ? { stuck: true as const } : {}),
    };
  }

  /**
   * Calls the model and runs its tools until it stops. Appends every message to
   * `turn` (the caller persists them) and returns what the Customer is shown.
   * Always leaves `turn` ending in an assistant message, or throws.
   */
  async function runToolLoop(
    turn: BetaMessageParam[],
    request: (maxTokens?: number) => ModelRequest,
    ctx: AgentTurnContext,
  ): Promise<AgentReplyDraft[]> {
    const texts: string[] = [];
    const failures = new Map<string, number>();
    let calls = 0;
    const call = async (maxTokens?: number) => {
      if (++calls > MAX_MODEL_CALLS_PER_TURN) throw new Error("Agent turn exceeded the model call limit");
      return modelClient.createMessage(request(maxTokens));
    };

    for (;;) {
      let response = await call();
      if (response.stop_reason === "max_tokens" && hasToolUse(response.content)) {
        // The tool input may be truncated: never run it. Nothing was appended, so retry with room.
        response = await call(MAX_TOKENS * 2);
        if (response.stop_reason === "max_tokens" && hasToolUse(response.content)) {
          throw new Error("Agent reply truncated at max_tokens twice");
        }
      }

      if (response.stop_reason === "refusal") {
        // Never run tools from a refused turn, and never echo its (partial) content.
        const category = response.stop_details?.category ?? "unspecified";
        await ctx.recordTrace({ kind: "refusal", result: `Model declined (category: ${category})` });
        turn.push(fixedAssistantTurn(MODEL_REFUSAL_REPLY));
        return [{ kind: "model_refusal", text: MODEL_REFUSAL_REPLY }];
      }

      const content = echoableContent(response.content);
      if (content.length === 0) {
        turn.push(fixedAssistantTurn(AGENT_ERROR_REPLY));
        return [{ kind: "agent_error", text: AGENT_ERROR_REPLY }];
      }
      turn.push({ role: "assistant", content });
      const said = textOf(content);
      if (said) texts.push(said);
      const uses = content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || uses.length === 0) {
        return texts.length > 0
          ? [{ kind: "text", text: texts.join("\n\n") }]
          : [{ kind: "agent_error", text: AGENT_ERROR_REPLY }];
      }

      const results: BetaToolResultBlockParam[] = [];
      let endTurn: AgentReplyDraft | undefined;
      let stuck = false;
      // Sequential, so the trace and any propose -> confirm ordering are deterministic.
      for (const use of uses) {
        const ran = await runTool(use, ctx, failures);
        results.push(ran.block);
        endTurn ??= ran.endTurn;
        stuck ||= ran.stuck ?? false;
      }
      // All results for one assistant turn go back in ONE user message.
      turn.push({ role: "user", content: results });
      if (stuck) {
        await ctx.recordTrace({
          kind: "error",
          result: `Agent repeated a failing tool call ${MAX_IDENTICAL_FAILED_CALLS_PER_TURN} times; turn ended`,
        });
        turn.push(fixedAssistantTurn(AGENT_ERROR_REPLY));
        return [{ kind: "agent_error", text: AGENT_ERROR_REPLY }];
      }
      if (endTurn) {
        // A fixed reply replaces model text; record it as the Agent's turn so
        // the history shows what the Customer saw and stays valid.
        turn.push(fixedAssistantTurn(endTurn.text));
        return [endTurn];
      }
    }
  }

  async function runCustomerTurn(
    sessionId: string,
    conversationId: string,
    startedAt: Date,
    text: string,
  ): Promise<ChatMessage[]> {
    const ids = { sessionId, conversationId };
    const now = clock.now();
    const customer = await store.appendChatMessage(db, ids, "Customer", { kind: "text", text }, now);
    const ctx: AgentTurnContext = {
      db,
      sessionId,
      conversationId,
      now,
      customerMessage: { id: customer.message.id, seq: customer.seq, text },
      enqueueSystemNote: (note) => store.enqueueSystemNote(db, ids, note, clock.now()),
      recordTrace: (entry) => store.recordTrace(db, ids, entry, clock.now()),
    };

    const history = await store.readAgentHistory(db, sessionId, conversationId);
    const finish = async (turn: BetaMessageParam[], replies: AgentReplyDraft[]) => {
      await store.appendAgentHistory(db, ids, turn, clock.now());
      const stored: ChatMessage[] = [];
      for (const r of replies) {
        stored.push((await store.appendChatMessage(db, ids, "Agent", r, clock.now())).message);
      }
      return stored;
    };

    for (const hook of deps.preModelHooks) {
      const outcome = await hook(ctx);
      if (!outcome) continue;
      // Handled without the model. Pending system notes stay queued for the
      // next model turn: a system message must be followed by an assistant
      // turn, and a synthetic one is all this turn has.
      return finish(
        [{ role: "user", content: text }, fixedAssistantTurn(outcome.historyNote)],
        outcome.replies,
      );
    }

    // Harness notices go right after the Customer's words, at the start of the
    // turn (the most robust spot on Sonnet 5.5): the time, then queued notes.
    const notes = [currentTimeNote(now), ...(await store.takePendingSystemNotes(db, sessionId, conversationId))];
    const turn: BetaMessageParam[] = [
      { role: "user", content: text },
      { role: "system", content: notes.join("\n") },
    ];
    const system = buildSystemPrompt(tools, startedAt);
    const request = (maxTokens = MAX_TOKENS): ModelRequest => ({
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      tool_choice: { type: "auto" },
      tools: toolDefinitions,
      system,
      cache_control: { type: "ephemeral" },
      messages: [...history, ...turn],
    });

    let replies: AgentReplyDraft[];
    try {
      replies = await runToolLoop(turn, request, ctx);
    } catch (error) {
      console.error("Agent turn failed", error);
      await ctx.recordTrace({ kind: "error", result: error instanceof Error ? error.message : String(error) });
      // Keep the history valid: drop an unanswered tool call, then close the turn.
      const last = turn.at(-1);
      if (last?.role === "assistant" && hasToolUse(last.content)) turn.pop();
      if (turn.at(-1)?.role !== "assistant") turn.push(fixedAssistantTurn(AGENT_ERROR_REPLY));
      replies = [{ kind: "agent_error", text: AGENT_ERROR_REPLY }];
    }
    return finish(turn, replies);
  }

  return { runCustomerTurn };
}

export type AgentRunner = ReturnType<typeof createAgentRunner>;

/** The Customer-visible text of an assistant turn (thinking blocks are never shown). */
function textOf(content: readonly BetaContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function hasToolUse(content: BetaMessageParam["content"]): boolean {
  return Array.isArray(content) && content.some((b) => b.type === "tool_use");
}

/** A synthetic assistant turn showing what the Customer was shown (keeps the history append-only and valid). */
function fixedAssistantTurn(text: string): BetaMessageParam {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * The assistant content to store and echo back, verbatim (thinking blocks
 * included). After a server-side fallback, blocks before the last `fallback`
 * block that the API says not to echo (thinking and client tool calls) are dropped.
 */
function echoableContent(content: readonly BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return [...content];
  const dropBefore = new Set(["thinking", "redacted_thinking", "tool_use"]);
  return content.filter((b, i) => i >= boundary || !dropBefore.has(b.type));
}

/** JSON with object keys sorted, so the same input compares equal whatever its key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
