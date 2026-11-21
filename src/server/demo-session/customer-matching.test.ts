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

  it("an email-only match books under a new Customer, flagged on the dashboard as a possible duplicate", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const before = await h.service.getDashboardState(h.sessionId);
    const sarahBefore = before.demoCustomers.find((c) => c.email === SARAH.email)!;
    expect(before.possibleDuplicateCustomers).toEqual([]);

    const { jobReference } = await bookFirstWindow(h, {
      fullName: "Sarah Mitchell",
      postcode: "SW11 2PL",
      email: "SARAH.MITCHELL@example.com",
    });

    const state = await h.service.getDashboardState(h.sessionId);
    // The existing Customer is untouched.
    expect(state.demoCustomers.find((c) => c.email === SARAH.email)!.jobReferences).toEqual(
      sarahBefore.jobReferences,
    );
    expect(state.jobs.find((j) => j.jobReference === jobReference)!.customer).toEqual({
      fullName: "Sarah Mitchell",
      postcode: "SW11 2PL",
      email: "sarah.mitchell@example.com",
    });
    expect(state.possibleDuplicateCustomers).toEqual([
      {
        customer: { fullName: "Sarah Mitchell", postcode: "SW11 2PL", email: "sarah.mitchell@example.com" },
        jobReferences: [jobReference],
        possibleDuplicateOf: { ...SARAH, jobReferences: sarahBefore.jobReferences },
      },
    ]);
  });

  it("a different name with the same email and postcode is also only a possible duplicate", async () => {
    const h = await chatHarness(WEDNESDAY_0930);
    const { jobReference } = await bookFirstWindow(h, { ...SARAH, fullName: "Sara Mitchel" });

    const state = await h.service.getDashboardState(h.sessionId);
    expect(state.possibleDuplicateCustomers.map((d) => [d.customer.fullName, d.jobReferences])).toEqual([
      ["Sara Mitchel", [jobReference]],
    ]);
  });

  it("the Agent's tool results never reveal whether the email was on file", async () => {
    const asAgentSeesIt = async (details: BookingDetails) => {
      const h = await chatHarness(WEDNESDAY_0930);
      const { proposal, confirmed } = await bookFirstWindow(h, details);
      return [proposal.result, confirmed.result].map((r) => shape(r));
    };

    const brandNew = await asAgentSeesIt({ fullName: "Hannah Brooks", postcode: "SW4 7AB", email: "hannah.brooks@example.com" });
    const fullMatch = await asAgentSeesIt(SARAH);
    const emailOnly = await asAgentSeesIt({ ...SARAH, postcode: "SW11 2PL" });

    expect(fullMatch).toEqual(brandNew);
    expect(emailOnly).toEqual(brandNew);
  });
});

/** A tool result with the Customer-specific values blanked, leaving only its structure and fixed wording. */
function shape(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => shape(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  }
  if (typeof value === "string" && key !== "guidance") return typeof value;
  return value;
}
