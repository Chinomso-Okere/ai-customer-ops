import type {
  BetaContentBlock,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Clock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import type { ModelClient, ModelRequest } from "@/server/model-client";
import * as store from "./conversation-store";
import { buildSystemPrompt, currentTimeNote } from "./system-prompt";
import type { AgentReplyDraft, AgentTool, AgentTurnContext, ChatMessage, PreModelHook } from "./types";

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
  const { db, clock, modelClient, tools } = deps;

  async function runCustomerTurn(
    sessionId: string,
    conversationId: string,
    startedAt: Date,
    text: string,
  ): Promise<ChatMessage[]> {
    const ids = { sessionId, conversationId };
    const now = clock.now();
    await store.appendChatMessage(db, ids, "Customer", { kind: "text", text }, now);

    const history = await store.readAgentHistory(db, sessionId, conversationId);
    const turn: BetaMessageParam[] = [
      { role: "user", content: text },
      { role: "system", content: currentTimeNote(now) },
    ];
    const request = (): ModelRequest => ({
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      tool_choice: { type: "auto" },
      tools: [],
      system: buildSystemPrompt(tools, startedAt),
      cache_control: { type: "ephemeral" },
      messages: [...history, ...turn],
    });

    const response = await modelClient.createMessage(request());
    turn.push({ role: "assistant", content: response.content });
    const replies: AgentReplyDraft[] = [{ kind: "text", text: textOf(response.content) }];

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

export type { AgentTurnContext };
