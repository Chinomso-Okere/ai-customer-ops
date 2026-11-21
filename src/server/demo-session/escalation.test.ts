import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn, type ChatHarness } from "@/server/testing/tool-turns";

const WEDNESDAY = london("2026-11-18T11:30");

async function ticketsOf(h: ChatHarness) {
  return (await h.service.getDashboardState(h.sessionId)).handoffTickets.filter(
    (t) => t.conversationId === h.conversationId,
  );
}

async function verifyAsSarah(h: ChatHarness) {
  const sarah = (await h.service.getDashboardState(h.sessionId)).demoCustomers.find(
    (c) => c.fullName === "Sarah Mitchell",
  )!;
  await toolTurn(h, `My reference is ${sarah.jobReferences[0]}, postcode ${sarah.postcode}`, "verify_customer", {
    jobReference: sarah.jobReferences[0],
    postcode: sarah.postcode,
  });
  return sarah;
}

const complaint = {
  reason: "Complaint",
  summary: "Customer is angry the engineer missed Tuesday's Visit.",
  recommendedNextStep: "Call the Customer today to apologise and rebook.",
};

describe("Complaint and Out of Policy escalations (create_handoff_ticket)", () => {
  it("a Complaint creates a High ticket with the verified Customer's details, summary and next step", async () => {
    const h = await chatHarness(WEDNESDAY);
    const sarah = await verifyAsSarah(h);

    const outcome = await toolTurn(h, "This is a disgrace, nobody turned up!", "create_handoff_ticket", {
      ...complaint,
      jobReference: sarah.jobReferences[0],
    });

    expect(outcome.ok).toBe(true);
    const [ticket] = await ticketsOf(h);
    expect(ticket).toMatchObject({
      escalationReason: "Complaint",
      urgency: "High",
      status: "Open",
      summary: complaint.summary,
      recommendedNextStep: complaint.recommendedNextStep,
      customer: { fullName: "Sarah Mitchell", postcode: sarah.postcode },
      jobReference: sarah.jobReferences[0],
    });
    // The Agent is given the ticket ID to quote.
    expect(outcome.ok && outcome.result.ticketReference).toBe(ticket!.ticketReference);
    expect(ticket!.timeline[0]!.text).toContain("nobody turned up");
  });

  it("an Out of Policy request defaults to Normal Urgency", async () => {
    const h = await chatHarness(WEDNESDAY);
    await toolTurn(h, "Can I get 50% off?", "create_handoff_ticket", {
      reason: "Out of Policy",
      summary: "Customer asked for a 50% discount.",
      recommendedNextStep: "Decide whether any goodwill discount applies.",
    });
    expect((await ticketsOf(h)).map((t) => [t.escalationReason, t.urgency])).toEqual([["Out of Policy", "Normal"]]);
  });

  it("the Agent may raise Urgency, but setting it below the reason's default is rejected and no ticket is raised", async () => {
    const h = await chatHarness(WEDNESDAY);

    const lowered = await toolTurn(h, "I'm furious", "create_handoff_ticket", { ...complaint, urgency: "Normal" });
    expect(lowered.ok).toBe(false);
    expect(await ticketsOf(h)).toHaveLength(0);

    const raised = await toolTurn(h, "I'm furious", "create_handoff_ticket", { ...complaint, urgency: "Critical" });
    expect(raised.ok).toBe(true);
    expect((await ticketsOf(h)).map((t) => t.urgency)).toEqual(["Critical"]);
  });
});
