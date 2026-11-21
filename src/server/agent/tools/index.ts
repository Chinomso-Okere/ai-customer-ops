import { blockedDuringGasEmergency } from "../emergency";
import type { AgentTool } from "../types";
import { checkCoverageArea } from "./check-coverage-area";
import { confirmActionTool } from "./confirm-action";
import { createHandoffTicket } from "./create-handoff-ticket";
import { getAvailability } from "./get-availability";
import { proposeBooking } from "./propose-booking";
import { proposeEmergencyVisit } from "./propose-emergency-visit";
import { proposeFittingVisit } from "./propose-fitting-visit";
import { proposeCancellation } from "./propose-cancellation";
import { proposeReschedule } from "./propose-reschedule";
import { refuseOffTopic } from "./refuse-off-topic";
import { getJobDetails } from "./get-job-details";
import { verifyCustomer } from "./verify-customer";

/**
 * The tool registry: every domain tool the Agent can call. One tool per file in
 * this directory; add yours with one import and one line below. Order doesn't
 * matter (the runner sends them sorted by name, for prompt caching).
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  checkCoverageArea,
  refuseOffTopic,
  // Booking tools refuse during an unresolved gas/CO Emergency (#13).
  blockedDuringGasEmergency(getAvailability),
  blockedDuringGasEmergency(proposeBooking),
  confirmActionTool,
  verifyCustomer,
  getJobDetails,
  createHandoffTicket,
  blockedDuringGasEmergency(proposeFittingVisit),
  blockedDuringGasEmergency(proposeReschedule),
  proposeCancellation,
  blockedDuringGasEmergency(proposeEmergencyVisit),
];
