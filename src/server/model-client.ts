import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** The model the Agent runs on (spec #1). */
export const AGENT_MODEL = "claude-sonnet-5-5";

/**
 * Everything the Agent runner decides about one Messages API call. The model
 * id, betas and fallbacks are the adapter's concern, not the runner's.
 */
export type ModelRequest = Omit<
  MessageCreateParamsNonStreaming,
  "model" | "betas" | "fallbacks" | "stream"
>;

/** The part of a Messages API response the runner reads. A real `BetaMessage` is assignable. */
export type ModelResponse = Pick<BetaMessage, "id" | "model" | "content" | "stop_reason" | "stop_details"> & {
  usage?: Pick<
    BetaUsage,
    "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
  >;
};

/**
 * The Agent's model dependency, injected into the Demo Session service.
 * Tests use the scripted fake in `src/server/testing/scripted-model-client.ts`.
 */
export interface ModelClient {
  createMessage(request: ModelRequest): Promise<ModelResponse>;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The real adapter: Claude Sonnet 5.5 on the Messages API (beta endpoint,
 * because `fallbacks` only exists there), with server-side fallbacks enabled.
 *
 * Decision (fallbacks vs mid-conversation system messages): the Agent puts
 * escalation state and the current time in mid-conversation `role: "system"`
 * messages, which the fallback model (Claude Sonnet 5) rejects with a 400. A
 * live check (2026-11-21) showed `fallbacks: "default"` is NOT validated
 * against the fallback model up front, so normal requests succeed. The residual
 * risk is a real fallback or a sticky-routed turn hitting Sonnet 5 and failing
 * with a 400. Mitigation: on a 400 from a fallback-enabled request, retry once
 * on Sonnet 5.5 alone (no `fallbacks`). A decline then surfaces as an ordinary
 * `refusal` stop reason, which the runner already handles with a scripted reply.
 */
export class AnthropicModelClient implements ModelClient {
  constructor(
    private readonly client: Anthropic = new Anthropic({ maxRetries: 2, timeout: 60_000 }),
  ) {}

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.client.beta.messages.create({
        ...request,
        model: AGENT_MODEL,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      });
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      return this.client.beta.messages.create({ ...request, model: AGENT_MODEL });
    }
  }
}

/** Used when no API key is configured: every call fails, and the Agent apologises. */
export const unconfiguredModelClient: ModelClient = {
  async createMessage() {
    throw new Error("ANTHROPIC_API_KEY is not set; the Agent cannot reach the model.");
  },
};
