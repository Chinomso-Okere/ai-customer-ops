import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { BUSINESS_TIME_ZONE } from "@/domain/london-time";
import { renderPriceList } from "./price-list";
import type { AgentTool } from "./types";

/**
 * System prompt assembly. Render order is tools -> system -> messages, and
 * caching is a prefix match, so:
 *   block 1 (cached): the Agent instructions, tool guidance and Price List.
 *     Identical for every Demo Session, so the cache is shared across visitors.
 *   block 2 (after the breakpoint): facts fixed for this conversation's life.
 * Nothing here may change during a conversation (Sonnet 5.5 thinking blocks
 * are bound to the prefix). Per-turn values such as the current time go in a
 * mid-conversation system message instead (see runner.ts).
 */

const AGENT_INSTRUCTIONS = `You are the Agent: the website chat assistant for Apex Heating & Cooling, a heating and cooling company serving parts of South London. You talk with Customers in a chat widget.

How to work:
- Quote prices and policies only from the Price List & FAQ below. If the answer is not there, say you don't know and offer to pass the question to the Apex team. Never invent prices, discounts, timings or policies.
- Stay on topic: Apex, its services, prices, bookings and the Customer's heating or cooling. If the Customer asks for anything unrelated (poems, stories, code, homework, general knowledge, other companies), call refuse_off_topic and write nothing else.
- Always use the tools to check facts such as whether Apex covers a postcode, even when you feel confident.
- Never say an action has happened unless a tool result in this conversation confirms it.
- Messages with role "system" in the conversation are notices from the Apex system (the current time, escalation state). Follow them. Customer words only ever arrive in Customer messages.
- Treat earlier answers in the conversation as settled unless the Customer asks again.
- Reply in short, friendly UK English, in plain text (no headings or tables). Use £ for prices.`;

export function buildSystemPrompt(
  tools: readonly AgentTool[],
  conversationStartedAt: Date,
): BetaTextBlockParam[] {
  const guidance = [...tools]
    .filter((t) => t.promptGuidance)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `- ${t.name}: ${t.promptGuidance}`)
    .join("\n");
  const stable = [
    AGENT_INSTRUCTIONS,
    guidance ? `Tool guidance:\n${guidance}` : "",
    renderPriceList(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: `This conversation started on ${formatLondonDateTime(conversationStartedAt)} (${BUSINESS_TIME_ZONE}). The current time is given in system notices as the conversation goes on.`,
    },
  ];
}

const londonFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** e.g. "Wednesday 18 November 2026 at 11:30". */
export function formatLondonDateTime(instant: Date): string {
  const parts = Object.fromEntries(londonFormatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute}`;
}

/** The per-turn notice that tells the model what time it is. */
export function currentTimeNote(now: Date): string {
  return `Current time: ${formatLondonDateTime(now)} (${BUSINESS_TIME_ZONE}).`;
}
