import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AGENT_MODEL, type ModelClient, type ModelRequest, type ModelResponse } from "@/server/model-client";

/** One scripted model call. It sees the request, e.g. to read the latest tool result. */
export type ScriptedStep = ModelResponse | ((request: ModelRequest) => ModelResponse);

/**
 * Seam 1 fake model client: replies to each Messages API call with the next
 * scripted step, and records every request so tests can assert on what the
 * model was sent (append-only history, stable prefix, tool results).
 */
export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly steps: ScriptedStep[];

  constructor(steps: ScriptedStep[] = []) {
    this.steps = [...steps];
  }

  /** Queues more steps, e.g. for the next Customer message. */
  script(...steps: ScriptedStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  get remainingSteps(): number {
    return this.steps.length;
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    // Fail like the real API would on an invalid history.
    assertValidMessages(request.messages);
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedModelClient: no scripted step left");
    return typeof step === "function" ? step(request) : step;
  }
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake_${++counter}`;

export function text(t: string): BetaContentBlock {
  return { type: "text", text: t, citations: null };
}

export function toolCall(name: string, input: unknown): BetaContentBlock {
  return { type: "tool_use", id: nextId("toolu"), name, input } as BetaContentBlock;
}

/** An opaque thinking block, as Sonnet 5.5 returns under `display: "omitted"`. */
export function thinking(): BetaContentBlock {
  return { type: "thinking", thinking: "", signature: "sig_fake" };
}

/** A model response; the stop reason is inferred from whether it calls a tool. */
export function reply(
  content: BetaContentBlock[],
  stopReason: ModelResponse["stop_reason"] = content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : "end_turn",
): ModelResponse {
  return { id: nextId("msg"), model: AGENT_MODEL, content, stop_reason: stopReason, stop_details: null };
}

/** The model declines: HTTP 200 with `stop_reason: "refusal"`. */
export function refusal(category: "cyber" | "general_harms" | null = "general_harms"): ModelResponse {
  return {
    id: nextId("msg"),
    model: AGENT_MODEL,
    content: [],
    stop_reason: "refusal",
    stop_details: { type: "refusal", category, explanation: null },
  } as unknown as ModelResponse;
}

/**
 * Throws if `messages` breaks a Messages API placement rule the runner must
 * respect (the real API answers these with a 400):
 * - the first entry is a user message; no assistant prefill at the end;
 * - assistant turns are non-empty and never back to back;
 * - every tool_use is answered by tool_result blocks first in the next user message;
 * - a system message follows a user message and is followed by an assistant
 *   turn or ends the array.
 */
export function assertValidMessages(messages: readonly BetaMessageParam[]): void {
  const fail = (i: number, why: string) => {
    throw new Error(`Invalid Messages API history at [${i}]: ${why}`);
  };
  if (messages[0]?.role !== "user") fail(0, "the first message must be a user message");
  if (messages.at(-1)?.role === "assistant") fail(messages.length - 1, "ends with an assistant prefill");
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (m.role === "system") {
      if (prev?.role !== "user") fail(i, "a system message must follow a user message");
      if (next && next.role !== "assistant") fail(i, "a system message must be last or precede an assistant turn");
    }
    if (m.role === "assistant") {
      if (prev?.role === "assistant") fail(i, "two assistant turns in a row");
      if (typeof m.content !== "string" && m.content.length === 0) fail(i, "empty assistant content");
      const uses = typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_use");
      if (uses.length === 0) return;
      if (!next) return; // the request being answered: tool results come next round
      const answered =
        next.role === "user" && typeof next.content !== "string"
          ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
          : [];
      for (const u of uses) if (!answered.includes(u.id)) fail(i + 1, `tool_use ${u.id} has no tool_result`);
    }
  });
}

/** The tool_result blocks in the last message of a request (what the runner just returned). */
export function lastToolResults(request: ModelRequest): BetaToolResultBlockParam[] {
  const last: BetaMessageParam | undefined = request.messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content.filter((b): b is BetaToolResultBlockParam => b.type === "tool_result");
}
