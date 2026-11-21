import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { reply, text } from "@/server/testing/scripted-model-client";
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

  it("a repeat on the same reason appends to the open ticket; a different reason gets its own ticket", async () => {
    const h = await chatHarness(WEDNESDAY);
    const first = await toolTurn(h, "Your engineer was rude", "create_handoff_ticket", complaint);
    const repeat = await toolTurn(h, "And he left mud everywhere", "create_handoff_ticket", complaint);

    expect(repeat.ok && repeat.result).toMatchObject({
      ticketReference: first.ok && first.result.ticketReference,
      ticketAction: "appended",
    });
    const [ticket] = await ticketsOf(h);
    expect(ticket!.timeline.map((e) => e.kind)).toEqual(["created", "appended"]);
    expect(ticket!.timeline[1]!.text).toContain("mud everywhere");

    await toolTurn(h, "I want a refund", "create_handoff_ticket", {
      reason: "Out of Policy",
      summary: "Customer wants a refund for the call-out.",
      recommendedNextStep: "Review the refund request.",
    });
    expect((await ticketsOf(h)).map((t) => t.escalationReason).sort()).toEqual(["Complaint", "Out of Policy"]);
  });

  it("a refund after a gas Emergency creates its own ticket beside the Emergency one", async () => {
    const h = await chatHarness(WEDNESDAY);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");

    await toolTurn(h, "Will you refund my last Visit?", "create_handoff_ticket", {
      reason: "Out of Policy",
      summary: "Customer wants a refund.",
      recommendedNextStep: "Review the refund request.",
    });

    const tickets = await ticketsOf(h);
    expect(tickets.map((t) => [t.escalationReason, t.urgency])).toEqual([
      ["Emergency", "Critical"],
      ["Out of Policy", "Normal"],
    ]);
  });

  it("after escalating, the model is told the ticket is open and not to act on that topic", async () => {
    const h = await chatHarness(WEDNESDAY);
    const outcome = await toolTurn(h, "I want compensation", "create_handoff_ticket", {
      reason: "Out of Policy",
      summary: "Customer wants compensation.",
      recommendedNextStep: "Review.",
    });
    const reference = outcome.ok && outcome.result.ticketReference;

    h.model.script(reply([text("A boiler service is £89.")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "OK. Separately, how much is a boiler service?");
    const notes = JSON.stringify(h.model.requests.at(-1)!.messages.filter((m) => (m.role as string) === "system"));
    expect(notes).toContain(reference);
    expect(notes).toMatch(/do not/i);
  });
});
