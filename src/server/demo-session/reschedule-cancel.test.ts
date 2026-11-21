import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");
// The Visit under test: Friday 20 November, AM (starts 08:00).
const FRIDAY_AM = { date: "2026-11-20", timeWindow: "AM" } as const;

const CUSTOMER = {
  fullName: "Hannah Brooks",
  postcode: "SW4 9ZZ",
  email: "hannah.brooks@example.com",
  phone: "07700 900999",
  issueType: "Boiler Service",
};

/**
 * A new Customer Books a Boiler Service on Friday AM, then (in a fresh
 * conversation) verifies with the Job Reference, and looks the Job up.
 */
async function bookedAndVerified(window: { date: string; timeWindow: string } = FRIDAY_AM) {
  const h = await chatHarness(WEDNESDAY_0930);
  const proposal = await toolTurn(h, "Book me in", "propose_booking", { ...CUSTOMER, ...window });
  if (!proposal.ok) throw new Error(proposal.error);
  const confirmed = await toolTurn(h, "yes", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
  if (!confirmed.ok) throw new Error(confirmed.error);
  const jobReference: string = confirmed.result.jobReference;

  const c: ChatHarness = { ...h, conversationId: await h.service.openConversation(h.sessionId, undefined) };
  const verified = await toolTurn(c, "Hi, about my booking", "verify_customer", { jobReference, postcode: CUSTOMER.postcode });
  if (!verified.ok || !verified.result.verified) throw new Error("verification failed");
  const visit = await upcomingVisit(c, jobReference);
  return { h: c, jobReference, visit };
}

async function upcomingVisit(h: ChatHarness, jobReference: string) {
  const details = await toolTurn(h, "When is it?", "get_job_details", { jobReference });
  if (!details.ok) throw new Error(details.error);
  return details.result.upcomingVisits[0] as { visitId: string; date: string; timeWindow: string };
}

async function jobOnDashboard(h: ChatHarness, jobReference: string) {
  const state = await h.service.getDashboardState(h.sessionId);
  return { state, job: state.jobs.find((j) => j.jobReference === jobReference)! };
}

describe("Reschedule a Visit more than 24h away", () => {
  it("proposes with a read-back, then moves the existing Visit on confirm (no new Job)", async () => {
    const { h, jobReference, visit } = await bookedAndVerified();
    expect(visit).toMatchObject({ visitId: expect.any(String), ...FRIDAY_AM });
    const jobsBefore = (await h.service.getDashboardState(h.sessionId)).jobs.length;

    const proposal = await toolTurn(h, "Can we move it to Monday afternoon?", "propose_reschedule", {
      visitId: visit.visitId,
      date: "2026-11-23",
      timeWindow: "PM",
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.result.readBack).toMatchObject({
      jobReference,
      from: { date: FRIDAY_AM.date, timeWindow: "AM" },
      to: { date: "2026-11-23", timeWindow: "PM" },
    });
    // Nothing moves until the Customer agrees.
    expect((await jobOnDashboard(h, jobReference)).job.visits[0]).toMatchObject({ date: FRIDAY_AM.date });

    const confirmed = await toolTurn(h, "yep that works", "confirm_action", { pendingActionId: proposal.result.pendingActionId });

    expect(confirmed.ok).toBe(true);
    const { state, job } = await jobOnDashboard(h, jobReference);
    expect(state.jobs).toHaveLength(jobsBefore);
    expect(job.jobStatus).toBe("Scheduled");
    expect(job.visits).toHaveLength(1);
    expect(job.visits[0]).toMatchObject({ id: visit.visitId, date: "2026-11-23", timeWindow: "PM" });
    expect(state.calendar.visits.filter((v) => v.jobReference === jobReference)).toEqual([
      expect.objectContaining({ visitId: visit.visitId, date: "2026-11-23", timeWindow: "PM" }),
    ]);
  });
});
