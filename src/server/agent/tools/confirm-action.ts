import { PENDING_ACTION_KINDS, confirmAction } from "../confirmation";
import type { AgentTool } from "../types";

/** The second phase of every write: carries out a proposal the Customer has agreed to. */
export const confirmActionTool: AgentTool = {
  name: "confirm_action",
  description:
    "Carries out an action you proposed earlier (a booking, reschedule or cancellation), using the pendingActionId from the proposal. Call it only when the Customer's latest message clearly agrees to the details you read back, in any words (\"yes\", \"yeah go ahead\", \"yep Friday AM works\"). Never call it in the same turn as the proposal: the Customer must reply first.",
  inputSchema: {
    type: "object",
    properties: {
      pendingActionId: { type: "string", description: "The pendingActionId returned by the proposal" },
    },
    required: ["pendingActionId"],
    additionalProperties: false,
  },
  promptGuidance:
    "Every write is two-phase. First call the propose_* tool and read the details back to the Customer, asking them to confirm. Only after they agree in a new message, call confirm_action. If they change something, propose again. Never say an action is done until confirm_action succeeds.",
  async run(input, ctx) {
    const id = typeof input.pendingActionId === "string" ? input.pendingActionId.trim() : "";
    return confirmAction(ctx, id, PENDING_ACTION_KINDS);
  },
};
