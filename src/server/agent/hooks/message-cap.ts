import { MESSAGE_CAP_REPLY } from "../scripted-replies";
import type { PreModelHook } from "../types";

/** Cost guardrail: Customer messages the Agent answers per Demo Session, across all its conversations. */
export const MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION = 40;

/**
 * Refuses every Customer message past the cap without calling the model. The
 * current message is already stored, so it is counted. Runs after the
 * Emergency pre-filter, so a Safety Script still shows past the cap.
 */
export const messageCapHook: PreModelHook = async (ctx) => {
  const { rows } = await ctx.db.query<{ n: string }>(
    "SELECT count(*) AS n FROM chat_message WHERE session_id = $1 AND speaker = 'Customer'",
    [ctx.sessionId],
  );
  if (Number(rows[0]!.n) <= MAX_CUSTOMER_MESSAGES_PER_DEMO_SESSION) return undefined;
  return {
    replies: [{ kind: "message_cap", text: MESSAGE_CAP_REPLY }],
    historyNote: "[Demo message limit reached; the Customer was asked to start a new demo]",
  };
};
