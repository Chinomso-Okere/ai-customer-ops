import type { PreModelHook } from "../types";
import { messageCapHook } from "./message-cap";

/**
 * Pre-model hooks run in this order on every Customer message, before the model
 * is called. The first one that returns an outcome handles the turn and the
 * model is not called. Add hooks with one import and one line below, e.g. the
 * Emergency pre-filter (#4, ADR-0002) and the message cap (#7).
 */
export const PRE_MODEL_HOOKS: readonly PreModelHook[] = [
  // Keep last: Emergency handling must still run past the cap.
  messageCapHook,
];
