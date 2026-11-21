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

  async function runTool(use: BetaToolUseBlock, ctx: AgentTurnContext): Promise<BetaToolResultBlockParam> {
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
    const content = outcome.ok ? JSON.stringify(outcome.result) : outcome.error;
    await ctx.recordTrace({
      kind: "tool_call",
      toolName: use.name,
      input: use.input,
      result: content,
      isError: !outcome.ok,
    });
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content,
      ...(outcome.ok ? {} : { is_error: true }),
    };
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
    const turn: BetaMessageParam[] = [
      { role: "user", content: text },
      { role: "system", content: currentTimeNote(now) },
    ];
    const system = buildSystemPrompt(tools, startedAt);
    const request = (): ModelRequest => ({
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      tool_choice: { type: "auto" },
      tools: toolDefinitions,
      system,
      cache_control: { type: "ephemeral" },
      messages: [...history, ...turn],
    });

    const texts: string[] = [];
    for (;;) {
      const response = await modelClient.createMessage(request());
      turn.push({ role: "assistant", content: response.content });
      const said = textOf(response.content);
      if (said) texts.push(said);
      if (response.stop_reason !== "tool_use") break;

      const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      const results: BetaToolResultBlockParam[] = [];
      // Sequential, so the trace and any propose -> confirm ordering are deterministic.
      for (const use of uses) results.push(await runTool(use, ctx));
      turn.push({ role: "user", content: results });
    }
    const replies: AgentReplyDraft[] = [{ kind: "text", text: texts.join("\n\n") }];

    await store.appendAgentHistory(db, ids, turn, clock.now());
    const stored: ChatMessage[] = [];
    for (const r of replies) {
      stored.push((await store.appendChatMessage(db, ids, "Agent", r, clock.now())).message);
    }
    return stored;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
