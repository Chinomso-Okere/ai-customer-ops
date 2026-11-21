import type { AgentTool } from "../types";
import { checkCoverageArea } from "./check-coverage-area";
import { confirmActionTool } from "./confirm-action";
import { getAvailability } from "./get-availability";
import { proposeBooking } from "./propose-booking";
import { refuseOffTopic } from "./refuse-off-topic";

/**
 * The tool registry: every domain tool the Agent can call. One tool per file in
 * this directory; add yours with one import and one line below. Order doesn't
 * matter (the runner sends them sorted by name, for prompt caching).
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  checkCoverageArea,
  refuseOffTopic,
  getAvailability,
  proposeBooking,
  confirmActionTool,
];
