import type { TimeWindow } from "@/domain/time-window";
import type { IssueType } from "@/domain/vocabulary";
import { describeWindow } from "@/server/scheduling/availability";
import { bookJob } from "@/server/scheduling/booking";
import { setChatCustomerIfUnset } from "@/server/verification";
import { oneCustomerPerChatBlock } from "../chat-customer";
import type { PendingActionKind } from "./pending-actions";

/** What `propose_booking` stores, already validated. */
export interface BookingPayload {
  fullName: string;
  /** Display form, e.g. "SW4 9ZZ". */
  postcode: string;
  email: string;
  phone: string | null;
  issueType: IssueType;
  description: string;
  date: string;
  timeWindow: TimeWindow;
}

/** Book: a new Customer, a Scheduled Job and its first Visit. */
export const bookingAction: PendingActionKind<BookingPayload> = {
  kind: "booking",
  async execute(tx, ctx, p) {
    // The chat's Customer may have been set since the proposal (e.g. by Verification).
    const otherCustomer = await oneCustomerPerChatBlock(tx, ctx, p);
    if (otherCustomer) return otherCustomer;
    const window = { date: p.date, timeWindow: p.timeWindow };
    const booked = await bookJob(tx, ctx.sessionId, {
      customer: { fullName: p.fullName, postcode: p.postcode, email: p.email, phone: p.phone },
      issueType: p.issueType,
      description: p.description,
      window,
      now: ctx.now,
    });
    if (!booked) {
      return {
        ok: false,
        error: `Not booked: ${describeWindow(window)} is no longer available. Apologise, call get_availability and offer new windows.`,
      };
    }
    await setChatCustomerIfUnset(tx, ctx, booked.customerId);
    return {
      ok: true,
      result: {
        booked: true,
        jobReference: booked.jobReference,
        issueType: p.issueType,
        postcode: p.postcode,
        date: p.date,
        timeWindow: p.timeWindow,
        label: describeWindow(window),
        guidance: "Give the Customer their Job Reference and the confirmed date and Time Window.",
      },
    };
  },
};
