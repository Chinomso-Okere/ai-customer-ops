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

/** The tool_result blocks in the last message of a request (what the runner just returned). */
export function lastToolResults(request: ModelRequest): BetaToolResultBlockParam[] {
  const last: BetaMessageParam | undefined = request.messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content.filter((b): b is BetaToolResultBlockParam => b.type === "tool_result");
}
