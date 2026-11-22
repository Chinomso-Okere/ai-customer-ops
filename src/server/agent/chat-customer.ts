import type { Database } from "@/server/db/database";
import { isOtherThanChatCustomer } from "@/server/verification";
import { TOOL_ERRORS, type AgentTurnContext, type ToolOutcome } from "./types";

/**
 * One chat is about one Customer (#27). The refusal for a Booking that names
 * someone other than the chat's Customer, or undefined when the conversation
 * has no Customer yet or the details are theirs. Checked when proposing and
 * again when confirming, since the chat's Customer may be set in between.
 */
export async function oneCustomerPerChatBlock(
  db: Database,
  ctx: AgentTurnContext,
  who: { fullName: string; email: string },
): Promise<Extract<ToolOutcome, { ok: false }> | undefined> {
  return (await isOtherThanChatCustomer(db, ctx, who)) ? TOOL_ERRORS.oneCustomerPerChat : undefined;
}
