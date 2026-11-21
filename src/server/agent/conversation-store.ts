import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Database } from "@/server/db/database";
import type { AgentReplyDraft, AgentTraceDraft, ChatMessage, ChatMessageKind } from "./types";

/** Persistence for conversations, transcripts, model history and the Agent Trace. Session-scoped. */

export async function createConversation(db: Database, sessionId: string, now: Date): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO conversation (session_id, created_at) VALUES ($1, $2) RETURNING id",
    [sessionId, now],
  );
  return rows[0]!.id;
}

/** When the conversation started, or null if it isn't in this Demo Session. */
export async function conversationStartedAt(
  db: Database,
  sessionId: string,
  conversationId: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ created_at: Date }>(
    "SELECT created_at FROM conversation WHERE session_id = $1 AND id = $2",
    [sessionId, conversationId],
  );
  return rows[0]?.created_at ?? null;
}

interface ChatMessageRow {
  seq: string;
  id: string;
  speaker: ChatMessage["speaker"];
  kind: ChatMessageKind;
  text: string;
  payload: unknown;
  created_at: Date;
}

function toChatMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: r.id,
    speaker: r.speaker,
    kind: r.kind,
    text: r.text,
    payload: r.payload ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function appendChatMessage(
  db: Database,
  ids: { sessionId: string; conversationId: string },
  speaker: ChatMessage["speaker"],
  draft: AgentReplyDraft,
  now: Date,
): Promise<{ message: ChatMessage; seq: number }> {
  const { rows } = await db.query<ChatMessageRow>(
    `INSERT INTO chat_message (session_id, conversation_id, speaker, kind, text, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING seq, id, speaker, kind, text, payload, created_at`,
    [
      ids.sessionId,
      ids.conversationId,
      speaker,
      draft.kind,
      draft.text,
      draft.payload === undefined ? null : JSON.stringify(draft.payload),
      now,
    ],
  );
  const row = rows[0]!;
  return { message: toChatMessage(row), seq: Number(row.seq) };
}

export async function readChatMessages(
  db: Database,
  sessionId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  const { rows } = await db.query<ChatMessageRow>(
    `SELECT seq, id, speaker, kind, text, payload, created_at
       FROM chat_message
      WHERE session_id = $1 AND conversation_id = $2
      ORDER BY seq`,
    [sessionId, conversationId],
  );
  return rows.map(toChatMessage);
}

/** The model's history, exactly as previously sent. */
export async function readAgentHistory(
  db: Database,
  sessionId: string,
  conversationId: string,
): Promise<BetaMessageParam[]> {
  const { rows } = await db.query<{ message: string }>(
    "SELECT message FROM agent_message WHERE session_id = $1 AND conversation_id = $2 ORDER BY seq",
    [sessionId, conversationId],
  );
  return rows.map((r) => JSON.parse(r.message) as BetaMessageParam);
}

export async function appendAgentHistory(
  db: Database,
  ids: { sessionId: string; conversationId: string },
  messages: readonly BetaMessageParam[],
  now: Date,
): Promise<void> {
  for (const m of messages) {
    await db.query(
      "INSERT INTO agent_message (session_id, conversation_id, message, created_at) VALUES ($1, $2, $3, $4)",
      [ids.sessionId, ids.conversationId, JSON.stringify(m), now],
    );
  }
}

export async function enqueueSystemNote(
  db: Database,
  ids: { sessionId: string; conversationId: string },
  text: string,
  now: Date,
): Promise<void> {
  await db.query(
    "INSERT INTO agent_system_note (session_id, conversation_id, text, created_at) VALUES ($1, $2, $3, $4)",
    [ids.sessionId, ids.conversationId, text, now],
  );
}

/** Pending system notes, oldest first, marked delivered. */
export async function takePendingSystemNotes(
  db: Database,
  sessionId: string,
  conversationId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ seq: string; text: string }>(
    `UPDATE agent_system_note SET delivered = true
      WHERE session_id = $1 AND conversation_id = $2 AND NOT delivered
      RETURNING seq, text`,
    [sessionId, conversationId],
  );
  return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map((r) => r.text);
}

export async function recordTrace(
  db: Database,
  ids: { sessionId: string; conversationId: string },
  entry: AgentTraceDraft,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO agent_trace_entry (session_id, conversation_id, kind, tool_name, input, result, is_error, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ids.sessionId,
      ids.conversationId,
      entry.kind,
      entry.toolName ?? null,
      entry.input === undefined ? null : JSON.stringify(entry.input),
      entry.result ?? null,
      entry.isError ?? false,
      now,
    ],
  );
}

/** One Agent Trace entry as the Operations Dashboard shows it. JSON-safe. */
export interface AgentTraceEntry {
  id: string;
  conversationId: string;
  kind: string;
  toolName: string | null;
  input: unknown;
  /** The exact tool result sent back to the model (usually JSON), or a note. */
  result: string | null;
  isError: boolean;
  createdAt: string;
}

/** The Demo Session's Agent Trace, oldest first. */
export async function readAgentTrace(db: Database, sessionId: string): Promise<AgentTraceEntry[]> {
  const { rows } = await db.query<{
    id: string;
    conversation_id: string;
    kind: string;
    tool_name: string | null;
    input: unknown;
    result: string | null;
    is_error: boolean;
    created_at: Date;
  }>(
    `SELECT id, conversation_id, kind, tool_name, input, result, is_error, created_at
       FROM agent_trace_entry
      WHERE session_id = $1
      ORDER BY seq`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    toolName: r.tool_name,
    input: r.input ?? null,
    result: r.result,
    isError: r.is_error,
    createdAt: r.created_at.toISOString(),
  }));
}
