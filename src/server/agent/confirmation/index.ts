import { bookingAction } from "./booking";
import { emergencyVisitAction } from "./emergency-visit";
import { fittingVisitAction } from "./fitting-visit";
import type { AnyPendingActionKind } from "./pending-actions";

export { confirmAction, proposeAction, type PendingActionKind } from "./pending-actions";

/**
 * Every kind of write that goes through two-phase Confirmation. Add yours
 * (reschedule, cancellation, fitting Visit...) with one import and one line.
 */
export const PENDING_ACTION_KINDS: readonly AnyPendingActionKind[] = [
  bookingAction,
  fittingVisitAction,
  emergencyVisitAction,
];
