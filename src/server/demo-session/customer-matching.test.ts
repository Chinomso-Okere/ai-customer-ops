import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn, toolTurns, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

// A seeded, demo-friendly Customer.
const SARAH = { fullName: "Sarah Mitchell", postcode: "SW4 7AB", email: "sarah.mitchell@example.com" };

type BookingDetails = { fullName: string; postcode: string; email: string };

/** The Agent proposes the first available Boiler Service window, then the Customer confirms. */
async function bookFirstWindow(h: ChatHarness, details: BookingDetails) {
  const [, proposal] = await toolTurns(h, "Book me in for the earliest slot please", [
    ["get_availability", { issueType: "Boiler Service", postcode: details.postcode }],
    [
      "propose_booking",
      (prev) => {
        const w = prev[0]!.ok ? prev[0]!.result.windows[0] : {};
        return { ...details, issueType: "Boiler Service", date: w.date, timeWindow: w.timeWindow };
      },
    ],
  ]);
  if (!proposal!.ok) throw new Error(proposal!.error);
  const confirmed = await toolTurn(h, "yes please", "confirm_action", {
    pendingActionId: proposal!.result.pendingActionId,
  });
  if (!confirmed.ok) throw new Error(confirmed.error);
  return { proposal: proposal!, confirmed, jobReference: confirmed.result.jobReference as string };
}

describe("Booking with an email that is already on file", () => {
  it("a full match (email, name, postcode; ignoring case and spacing) attaches the new Job to the existing Customer", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);
    const sarahBefore = before.demoCustomers.find((c) => c.email === SARAH.email)!;

    const { jobReference } = await bookFirstWindow(h, {
      fullName: "  sarah   MITCHELL ",
      postcode: "sw47ab",
      email: " Sarah.Mitchell@Example.COM ",
    });

    const state = await h.service.getDashboardState(h.sessionId);
    const sarah = state.demoCustomers.find((c) => c.email === SARAH.email)!;
    expect(sarah.jobReferences).toEqual([...sarahBefore.jobReferences, jobReference].sort());
    expect(state.demoCustomers).toHaveLength(before.demoCustomers.length);
    expect(state.jobs.find((j) => j.jobReference === jobReference)!.customer).toEqual(SARAH);
  });
});
