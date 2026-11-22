import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { reply, text } from "@/server/testing/scripted-model-client";
import { queuedNotes } from "@/server/testing/queued-notes";
import { chatHarness, toolTurn, toolTurns, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_1130 = london("2026-11-18T11:30");

const CONTACT = { customerName: "Hannah Brooks", customerPhone: "07700 900123" };

/** The Customer's latest Emergency ticket in the conversation, as the Dashboard shows it. */
async function emergencyTicket(h: ChatHarness) {
  const state = await h.service.getDashboardState(h.sessionId);
  return state.handoffTickets.find((t) => t.conversationId === h.conversationId && t.escalationReason === "Emergency")!;
}

/** The Agent attaches what the Customer gave to the open Emergency ticket. */
const attachContact = (h: ChatHarness, customerText: string, contact: Record<string, unknown> = CONTACT) =>
  toolTurn(h, customerText, "create_handoff_ticket", {
    reason: "Emergency",
    summary: "Customer gave contact details for the callback.",
    recommendedNextStep: "Call the Customer now.",
    jobReference: null,
    ...contact,
  });

const noticeOf = (replies: { kind: string; payload: unknown }[]) => replies.find((r) => r.kind === "handoff_notice")!;

describe("Emergency tickets collect the Customer's name and phone", () => {
  it("a new Emergency ticket's notice asks for contact details, for gas and for flooding alike", async () => {
    for (const message of ["I think I smell gas in the hallway", "water is pouring out of my boiler"]) {
      const h = await chatHarness(WEDNESDAY_1130);
      const { replies } = await h.service.sendCustomerMessage(h.sessionId, h.conversationId, message);
      expect(noticeOf(replies).payload).toMatchObject({ isNewTicket: true, contactNeeded: true });
    }
  });

  it("the model is sent one system note about the new Emergency ticket, to collect the contact details", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");
    h.model.script(reply([text("(scripted Agent reply)")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "what happens now?");

    // The note is queued by the pre-filter and delivered with the next model request.
    expect(queuedNotes(h.model.requests.at(-1)!)).toHaveLength(1);
  });

  it("the open ticket carries the contact once the Customer gives it, with an appended event", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");
    const before = await emergencyTicket(h);
    expect(before).toMatchObject({ contactName: null, contactPhone: null });

    const result = await attachContact(h, "I'm Hannah Brooks, 07700 900123");

    expect(result.ok && result.result).toMatchObject({ ticketAction: "appended", contactStillNeeded: false });
    const after = await emergencyTicket(h);
    expect(after).toMatchObject({ id: before.id, contactName: "Hannah Brooks", contactPhone: "+447700900123" });
    expect(after.timeline.map((e) => e.kind)).toEqual(["created", "appended"]);
    const tickets = (await h.service.getDashboardState(h.sessionId)).handoffTickets.filter(
      (t) => t.conversationId === h.conversationId,
    );
    expect(tickets).toHaveLength(1);
  });

  it("a name alone and a phone alone can arrive in separate turns", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");

    const first = await attachContact(h, "It's Hannah Brooks", { customerName: "Hannah Brooks", customerPhone: null });
    expect(first.ok && first.result).toMatchObject({ contactStillNeeded: true });
    expect(await emergencyTicket(h)).toMatchObject({ contactName: "Hannah Brooks", contactPhone: null });

    const second = await attachContact(h, "my number is 020 7946 0018", { customerName: null, customerPhone: "020 7946 0018" });
    expect(second.ok && second.result).toMatchObject({ contactStillNeeded: false });
    expect(await emergencyTicket(h)).toMatchObject({ contactName: "Hannah Brooks", contactPhone: "+442079460018" });
  });

  it("a junk phone number is refused with a code and nothing is stored", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");

    const result = await attachContact(h, "my number is 12345", { customerName: "Hannah Brooks", customerPhone: "12345" });

    expect(result).toMatchObject({ ok: false, code: "invalid_phone" });
    expect(await emergencyTicket(h)).toMatchObject({ contactName: null, contactPhone: null });
  });

  it("an international number written with a leading + is accepted and stored in international form", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");

    const result = await attachContact(h, "I'm Hannah, +1 (415) 555-0132", { customerName: "Hannah Brooks", customerPhone: "+1 (415) 555-0132" });

    expect(result.ok && result.result).toMatchObject({ contactStillNeeded: false });
    expect(await emergencyTicket(h)).toMatchObject({ contactName: "Hannah Brooks", contactPhone: "+14155550132" });
  });

  it("works outside the Coverage Area: no postcode is needed and none is checked", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    const { replies } = await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas, I'm in Aberdeen AB10 1AA");
    expect(noticeOf(replies).payload).toMatchObject({ contactNeeded: true });

    const result = await attachContact(h, "Hannah Brooks, 07700 900123");

    expect(result.ok).toBe(true);
    expect(await emergencyTicket(h)).toMatchObject({ contactName: "Hannah Brooks", contactPhone: "+447700900123" });
  });

  it("a repeat Emergency message asks again while contact is missing, and stops once it is known", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");

    const stillMissing = await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "the CO alarm is going off too");
    expect(noticeOf(stillMissing.replies).payload).toMatchObject({ isNewTicket: false, contactNeeded: true });

    await attachContact(h, "Hannah Brooks, 07700 900123");
    const known = await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "the CO alarm is still going off");
    expect(noticeOf(known.replies).payload).toMatchObject({ isNewTicket: false, contactNeeded: false });
  });

  it("gas/CO: the booking block still holds after the contact details are added", async () => {
    const h = await chatHarness(WEDNESDAY_1130);
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "I smell gas");
    await attachContact(h, "Hannah Brooks, 07700 900123");

    const [availability, proposal] = await toolTurns(h, "can you book me a boiler repair?", [
      ["get_availability", { issueType: "Boiler Repair", postcode: "SW4 9ZZ" }],
      [
        "propose_booking",
        {
          fullName: "Hannah Brooks",
          postcode: "SW4 9ZZ",
          email: "hannah.brooks@example.com",
          issueType: "Boiler Repair",
          phone: null,
          date: null,
          timeWindow: null,
        },
      ],
    ]);

    expect(availability!.ok).toBe(false);
    expect(proposal!.ok).toBe(false);
    expect((await emergencyTicket(h)).status).toBe("Open");
  });
});
