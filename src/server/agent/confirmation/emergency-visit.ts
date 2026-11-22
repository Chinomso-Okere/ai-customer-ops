import { timeWindowEnd } from "@/domain/time-window";
import { describeWindow } from "@/server/scheduling/availability";
import { EMERGENCY_VISIT_MIN_REMAINING_MS, bookEmergencyVisit } from "@/server/scheduling/emergency-visit";
import { setChatCustomerIfUnset } from "@/server/verification";
import { oneCustomerPerChatBlock } from "../chat-customer";
import type { BookingPayload } from "./booking";
import type { PendingActionKind } from "./pending-actions";

/** What `propose_emergency_visit` stores, already validated. Same shape as a Booking. */
export type EmergencyVisitPayload = BookingPayload;

/** Books a Job and its Emergency Visit (flood/sparks), even over normal capacity. */
export const emergencyVisitAction: PendingActionKind<EmergencyVisitPayload> = {
  kind: "emergency_visit",
  async execute(tx, ctx, p) {
    // The chat's Customer may have been set since the proposal (e.g. by Verification).
    const otherCustomer = await oneCustomerPerChatBlock(tx, ctx, p);
    if (otherCustomer) return otherCustomer;
    const window = { date: p.date, timeWindow: p.timeWindow };
    if (timeWindowEnd(window.date, window.timeWindow).getTime() < ctx.now.getTime() + EMERGENCY_VISIT_MIN_REMAINING_MS) {
      return {
        ok: false,
        error: `Not booked: ${describeWindow(window)} is too close to its end now. Call propose_emergency_visit again for the next window.`,
      };
    }
    const booked = await bookEmergencyVisit(tx, ctx.sessionId, {
      customer: { fullName: p.fullName, postcode: p.postcode, email: p.email, phone: p.phone },
      issueType: p.issueType,
      description: p.description,
      window,
      now: ctx.now,
    });
    if (!booked) return { ok: false, error: `No Engineer is skilled for ${p.issueType}. Tell the Customer the team will call them.` };
    await setChatCustomerIfUnset(tx, ctx, booked.customerId);
    return {
      ok: true,
      result: {
        booked: true,
        emergencyVisit: true,
        jobReference: booked.jobReference,
        issueType: p.issueType,
        postcode: p.postcode,
        date: p.date,
        timeWindow: p.timeWindow,
        label: describeWindow(window),
        engineerFirstName: booked.visit.engineerName.split(" ")[0],
        guidance: "Give the Customer their Job Reference and the Emergency Visit's date and Time Window. Remind them to stay safe until the Engineer arrives.",
      },
    };
  },
};
