import { describeWindow } from "@/server/scheduling/availability";
import { proposeAction } from "../confirmation";
import { cancellationAction, type CancellationPayload } from "../confirmation/visit-changes";
import type { AgentTool } from "../types";
import { visitChangeableInChat } from "../visit-change-checks";

/** First phase of cancelling a Visit (#14): checks the 24h policy, records a pending action. */
export const proposeCancellation: AgentTool = {
  name: "propose_cancellation",
  description:
    "Proposes cancelling one of a verified Customer's upcoming Visits (visitId from get_job_details). Visits within 24 hours can't be cancelled in chat: the request is escalated automatically and the result says so. Nothing changes yet: it returns a pendingActionId and the details to read back.",
  inputSchema: {
    type: "object",
    properties: {
      visitId: { type: "string", description: "The Visit to cancel: a visitId from get_job_details upcomingVisits" },
    },
    required: ["visitId"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const check = await visitChangeableInChat(ctx, input.visitId, "cancellation");
    if (check.refused) return check.refused;
    const { visit } = check;
    const payload: CancellationPayload = { visitId: visit.visitId };
    const readBack = {
      jobReference: visit.jobReference,
      issueType: visit.issueType,
      date: visit.date,
      timeWindow: visit.timeWindow,
      label: describeWindow(visit),
    };
    return proposeAction(ctx, cancellationAction, {
      payload,
      readBack,
      guidance:
        "Nothing has changed yet. Read back the Visit being cancelled and ask the Customer to confirm. Call confirm_action only after they agree.",
    });
  },
};
