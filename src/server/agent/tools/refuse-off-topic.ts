import { OFF_TOPIC_REFUSAL } from "../scripted-replies";
import type { AgentTool } from "../types";

/**
 * Off-topic guardrail: the model decides a request is off-topic, and the runner
 * shows the fixed refusal (so the demo can't be used as free general-purpose AI).
 */
export const refuseOffTopic: AgentTool = {
  name: "refuse_off_topic",
  description:
    "Call this when the Customer asks for something unrelated to Apex Heating & Cooling (e.g. poems, stories, code, homework, general knowledge, other companies). The Customer is shown a fixed, polite refusal; do not write a reply of your own.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run() {
    return {
      ok: true,
      result: { shownToCustomer: "off-topic refusal" },
      endTurn: { kind: "off_topic_refusal", text: OFF_TOPIC_REFUSAL },
    };
  },
};
