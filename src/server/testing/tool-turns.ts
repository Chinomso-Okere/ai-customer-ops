import { createHarness } from "./harness";
import { lastToolResults, reply, text, toolCall } from "./scripted-model-client";

export type ChatHarness = Awaited<ReturnType<typeof chatHarness>>;

/** A harness with a fresh Demo Session and an open conversation in it. */
export async function chatHarness(now: Date) {
  const harness = await createHarness({ now });
  const sessionId = await harness.service.createDemoSession();
  const conversationId = await harness.service.openConversation(sessionId, undefined);
  return { ...harness, sessionId, conversationId };
}

/** What a domain tool sent back to the model. */
export type ToolTurnResult =
  | { ok: true; result: any; content: string }
  | { ok: false; error: string; content: string };

/**
 * Runs one Customer turn in which the (scripted) model calls `toolName` with
 * `input`, then replies with text. Returns what the tool sent back.
 */
export async function toolTurn(
  h: ChatHarness,
  customerText: string,
  toolName: string,
  input: unknown,
): Promise<ToolTurnResult> {
  const [result] = await toolTurns(h, customerText, [[toolName, input]]);
  return result!;
}

/**
 * Runs one Customer turn in which the model makes the given tool calls one
 * after another (each in its own model call, so a later input may depend on
 * an earlier result), then replies with text.
 */
export async function toolTurns(
  h: ChatHarness,
  customerText: string,
  calls: ReadonlyArray<readonly [string, unknown | ((previous: ToolTurnResult[]) => unknown)]>,
): Promise<ToolTurnResult[]> {
  const results: ToolTurnResult[] = [];
  const collect = (request: Parameters<typeof lastToolResults>[0]) => {
    const [block] = lastToolResults(request);
    const content = typeof block!.content === "string" ? block!.content : JSON.stringify(block!.content);
    results.push(block!.is_error ? { ok: false, error: content, content } : { ok: true, result: JSON.parse(content), content });
  };
  calls.forEach(([name, input], i) => {
    h.model.script((request) => {
      if (i > 0) collect(request);
      const resolved = typeof input === "function" ? (input as (p: ToolTurnResult[]) => unknown)(results) : input;
      return reply([toolCall(name, resolved)]);
    });
  });
  h.model.script((request) => {
    collect(request);
    return reply([text("(scripted Agent reply)")]);
  });
  await h.service.sendCustomerMessage(h.sessionId, h.conversationId, customerText);
  return results;
}
