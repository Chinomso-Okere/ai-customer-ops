import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Database } from "@/server/db/database";

/**
 * What a chat message is, so the widget can render it. Extend this union when
 * a new kind of Agent message appears (e.g. "safety_script" for #4).
 */
export type ChatMessageKind =
  /** Ordinary Customer text or model-written Agent text. */
  | "text"
  /** The fixed reply to an off-topic request. */
  | "off_topic_refusal"
  /** The fixed reply when the model declines (stop reason `refusal`). */
  | "model_refusal"
  /** The fixed apology when the model could not be reached or the turn failed. */
  | "agent_error"
  /** The fixed reply once the Demo Session's message cap is reached (#7). */
  | "message_cap"
  /** The fixed Safety Script for an Emergency; payload `{ emergencyKind, title, bullets }`. */
  | "safety_script"
  /** A fixed notice that a Handoff Ticket was raised or updated; payload `{ ticketReference, isNewTicket, contactNeeded }`. */
  | "handoff_notice";

/** One message of the Customer-visible transcript. JSON-safe. */
export interface ChatMessage {
  id: string;
  speaker: "Customer" | "Agent";
  kind: ChatMessageKind;
  text: string;
  /** Structured extras for the widget (e.g. Safety Script bullets); null for plain text. */
  payload: unknown;
  createdAt: string;
}

/** An Agent message to show the Customer, before it is stored. */
export interface AgentReplyDraft {
  kind: ChatMessageKind;
  text: string;
  payload?: unknown;
}

/** What `sendCustomerMessage` returns. */
export interface CustomerTurnResult {
  /** The Agent messages produced by this turn, in order. */
  replies: ChatMessage[];
  /** The whole transcript after this turn. */
  conversation: ChatMessage[];
}

/** Open-ended so later tickets can add kinds (e.g. "emergency_prefilter"). */
export type AgentTraceKind = "tool_call" | "refusal" | "error" | (string & {});

export interface AgentTraceDraft {
  kind: AgentTraceKind;
  toolName?: string | null;
  input?: unknown;
  result?: string | null;
  isError?: boolean;
}

/**
 * Everything a domain tool or pre-model hook may use during one Customer turn.
 * `db` is the shared database (not a transaction): writes are visible to the
 * dashboard immediately. Always scope queries by `sessionId`.
 */
export interface AgentTurnContext {
  db: Database;
  sessionId: string;
  conversationId: string;
  /** The clock's "now" when the turn started. */
  now: Date;
  /**
   * The Customer message that started this turn. `seq` increases with every
   * Customer message, so "a new Customer message arrived since X" is
   * `ctx.customerMessage.seq > seqRecordedAtX` (two-phase Confirmation, #5).
   */
  customerMessage: { id: string; seq: number; text: string };
  /**
   * Queues a notice for the model (e.g. "Emergency ticket APX-H-0003 is open;
   * do not book"). It is delivered as a mid-conversation system message right
   * after the next Customer message, and stays in the history from then on.
   */
  enqueueSystemNote(text: string): Promise<void>;
  /** Adds an entry to the Agent Trace (tool calls are recorded by the runner itself). */
  recordTrace(entry: AgentTraceDraft): Promise<void>;
}

/** The outcome of a domain tool. Failures go back to the model with `is_error`. */
export type ToolOutcome =
  | {
      ok: true;
      /** JSON-serialisable; build it with a fixed key order (it is replayed verbatim). */
      result: unknown;
      /**
       * Ends the turn after this tool without another model call, showing this
       * fixed reply instead of model text (e.g. the off-topic refusal).
       */
      endTurn?: AgentReplyDraft;
    }
  | {
      ok: false;
      /** Actionable for the model, e.g. "Postcode missing: ask the Customer for it." */
      error: string;
      /** A stable, machine-readable reason, sent alongside `error` (tests assert on it, never on wording). */
      code?: ToolErrorCode;
    };

/** Structured reasons a tool refused. */
export type ToolErrorCode =
  | "outside_coverage_area"
  | "not_verified"
  /** A phone number that is not a UK number (see `normaliseUkPhone`). */
  | "invalid_phone"
  /** Set by the runner: this exact call already failed the same way in this turn. */
  | "repeated_failed_call";

/** Shared refusals, so every tool words and codes them the same way. */
export const TOOL_ERRORS = {
  notVerified: {
    ok: false,
    code: "not_verified",
    error: "The Customer is not verified in this conversation. Call verify_customer first.",
  },
  outsideCoverageArea: (outwardCode: string) => ({
    ok: false as const,
    code: "outside_coverage_area" as const,
    error: `${outwardCode} is outside the Apex Coverage Area, so it can't be booked. Politely tell the Customer Apex doesn't cover their postcode. This is not an Escalation.`,
  }),
} as const satisfies Record<string, ToolOutcome | ((...args: never[]) => ToolOutcome)>;

/**
 * A domain tool the Agent can call. Each lives in its own file under
 * `src/server/agent/tools/` and is listed in `tools/index.ts`.
 */
export interface AgentTool {
  name: string;
  /** Say WHEN to call it; Sonnet 5.5 is steered by descriptions, not tool_choice. */
  description: string;
  /** Strict schema: every object needs `additionalProperties: false`. */
  inputSchema: BetaTool["input_schema"];
  /** Optional extra instructions appended to the system prompt (sorted by tool name). */
  promptGuidance?: string;
  /** Validate the input (never trust the model) and enforce policy server-side. */
  run(input: Record<string, unknown>, ctx: AgentTurnContext): Promise<ToolOutcome>;
}

/**
 * Runs on every Customer message before the model is called (e.g. the
 * Emergency pre-filter, #4; the message cap, #7). Return `undefined` to let the
 * model handle the turn, or a handled outcome to short-circuit it.
 */
export type PreModelHook = (ctx: AgentTurnContext) => Promise<PreModelOutcome | undefined>;

export interface PreModelOutcome {
  /** Fixed Agent messages shown to the Customer instead of calling the model. */
  replies: AgentReplyDraft[];
  /**
   * What the model will see as the Agent's turn in its history, e.g.
   * "[Safety Script shown; Critical Handoff Ticket APX-H-0003 created]". It is
   * stored as a synthetic assistant message so the history stays valid.
   */
  historyNote: string;
}
