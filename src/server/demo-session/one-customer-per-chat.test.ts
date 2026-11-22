import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn, toolTurns, type ChatHarness } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

const HANNAH = {
  fullName: "Hannah Brooks",
  postcode: "SW4 9ZZ",
  email: "hannah.brooks@example.com",
  phone: null,
  issueType: "Boiler Service",
};

const pick = (w: { date?: string; timeWindow?: string }) => ({ date: w.date, timeWindow: w.timeWindow });

/** The Agent checks Availability and proposes the window at `index`, in one turn. */
async function propose(h: ChatHarness, details: Record<string, unknown>, index = 0) {
  const [, proposal] = await toolTurns(h, "Book me in please", [
    ["get_availability", { issueType: details.issueType, postcode: details.postcode }],
    ["propose_booking", (prev) => ({ ...details, ...pick(prev[0]!.ok ? prev[0]!.result.windows[index] : {}) })],
  ]);
  return proposal!;
}

/** Books a Job for `details` in this conversation: propose, then confirm after the Customer's reply. */
async function book(h: ChatHarness, details: Record<string, unknown>, index = 0) {
  const proposal = await propose(h, details, index);
  if (!proposal.ok) throw new Error(proposal.error);
  const confirmed = await toolTurn(h, "yes please", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
  if (!confirmed.ok) throw new Error(confirmed.error);
  return confirmed.result.jobReference as string;
}

async function setup() {
  const h = await chatHarness(WEDNESDAY_0930);
  const { demoCustomers } = await h.service.getDashboardState(h.sessionId);
  const customer = (name: string) => demoCustomers.find((c) => c.fullName === name)!;
  return { h, customer };
}

const pathA = (c: { jobReferences: string[]; postcode: string }) => ({
  jobReference: c.jobReferences[0],
  fullName: null,
  postcode: c.postcode,
  email: null,
});

describe("One Customer per chat: Verification", () => {
  it("after booking as Customer A, Customer B's correct details are refused and B's Job stays unavailable", async () => {
    const { h, customer } = await setup();
    const sarah = customer("Sarah Mitchell");
    await book(h, HANNAH);

    const refused = await toolTurn(h, "Actually check Sarah's job", "verify_customer", pathA(sarah));
    expect(refused).toMatchObject({ ok: false, code: "one_customer_per_chat" });

    const details = await toolTurn(h, "What's its status?", "get_job_details", { jobReference: sarah.jobReferences[0] });
    expect(details).toMatchObject({ ok: false, code: "not_verified" });
  });

  it("the refusal uses a failed attempt: the third one locks Verification", async () => {
    const { h, customer } = await setup();
    const sarah = customer("Sarah Mitchell");
    await book(h, HANNAH);

    for (let i = 0; i < 3; i++) {
      const refused = await toolTurn(h, "Try Sarah's job", "verify_customer", pathA(sarah));
      expect(refused).toMatchObject({ ok: false, code: "one_customer_per_chat" });
    }
    const afterLock = await toolTurn(h, "Try Sarah's job again", "verify_customer", pathA(sarah));
    expect(afterLock).toMatchObject({ ok: true, result: { verified: false, locked: true, attemptsRemaining: 0 } });
  });

  it("no oracle: another Customer's correct details and garbage details get the identical refusal", async () => {
    const { h, customer } = await setup();
    await book(h, HANNAH);

    const other = await toolTurn(h, "Check Sarah's job", "verify_customer", pathA(customer("Sarah Mitchell")));
    const garbage = await toolTurn(h, "Check this job", "verify_customer", {
      jobReference: "APX-99999",
      fullName: null,
      postcode: "ZZ99 9ZZ",
      email: null,
    });
    expect(other.ok).toBe(false);
    expect(garbage.content).toBe(other.content);
  });

  it("no oracle holds for Path B details too", async () => {
    const { h, customer } = await setup();
    const james = customer("James Patel");
    await book(h, HANNAH);

    const other = await toolTurn(h, "Check James", "verify_customer", {
      jobReference: null,
      fullName: james.fullName,
      postcode: james.postcode,
      email: james.email,
    });
    const garbage = await toolTurn(h, "Check someone", "verify_customer", {
      jobReference: null,
      fullName: "Nobody Here",
      postcode: "SW1A 1AA",
      email: "nobody@example.com",
    });
    expect(other).toMatchObject({ ok: false, code: "one_customer_per_chat" });
    expect(garbage.content).toBe(other.content);
  });

  it("the chat's own Customer can still verify after booking (Path B), and the Job details open up", async () => {
    const { h } = await setup();
    const jobReference = await book(h, HANNAH);

    const verified = await toolTurn(h, "Check my booking", "verify_customer", {
      jobReference: null,
      fullName: " hannah  BROOKS",
      postcode: "sw49zz",
      email: "Hannah.Brooks@example.com",
    });
    expect(verified).toMatchObject({ ok: true, result: { verified: true } });
    const details = await toolTurn(h, "Status?", "get_job_details", { jobReference });
    expect(details.ok).toBe(true);
  });

  it("after verifying as A, verifying as B is refused", async () => {
    const { h, customer } = await setup();
    const verified = await toolTurn(h, "Sarah here", "verify_customer", pathA(customer("Sarah Mitchell")));
    expect(verified).toMatchObject({ ok: true, result: { verified: true } });

    const refused = await toolTurn(h, "Now James", "verify_customer", pathA(customer("James Patel")));
    expect(refused).toMatchObject({ ok: false, code: "one_customer_per_chat" });
  });

  it("a chat with no Customer yet behaves as before: a wrong attempt is an ordinary failure", async () => {
    const { h } = await setup();
    const failed = await toolTurn(h, "Check this", "verify_customer", {
      jobReference: "APX-99999",
      fullName: null,
      postcode: "SW1A 1AA",
      email: null,
    });
    expect(failed).toMatchObject({ ok: true, result: { verified: false, locked: false, attemptsRemaining: 2 } });
  });
});

describe("One Customer per chat: Booking", () => {
  it("after verifying as A, proposing a Booking for B (name or email) is refused; a second Job for A is allowed", async () => {
    const { h, customer } = await setup();
    const sarah = customer("Sarah Mitchell");
    await toolTurn(h, "Sarah here", "verify_customer", pathA(sarah));
    const sarahDetails = { fullName: sarah.fullName, postcode: sarah.postcode, email: sarah.email, phone: null, issueType: "Boiler Service" };

    const otherName = await propose(h, { ...sarahDetails, fullName: "Hannah Brooks" });
    expect(otherName).toMatchObject({ ok: false, code: "one_customer_per_chat" });
    const otherEmail = await propose(h, { ...sarahDetails, email: "someone.else@example.com" });
    expect(otherEmail).toMatchObject({ ok: false, code: "one_customer_per_chat" });

    const same = await propose(h, { ...sarahDetails, fullName: ` ${sarah.fullName.toUpperCase()} `, email: sarah.email.toUpperCase() });
    expect(same.ok).toBe(true);
  });

  it("after booking as A, a second Job for A is allowed and a Booking for B is refused", async () => {
    const { h } = await setup();
    await book(h, HANNAH);

    const other = await propose(h, { ...HANNAH, fullName: "Jordan Lee", email: "jordan.lee@example.com" });
    expect(other).toMatchObject({ ok: false, code: "one_customer_per_chat" });

    const second = await propose(h, HANNAH, 1);
    expect(second.ok).toBe(true);
  });

  it("a Booking proposed before the chat's Customer was set cannot be confirmed for someone else", async () => {
    const { h, customer } = await setup();
    const proposal = await propose(h, HANNAH);
    if (!proposal.ok) throw new Error(proposal.error);
    await toolTurn(h, "Sarah here", "verify_customer", pathA(customer("Sarah Mitchell")));

    const confirmed = await toolTurn(h, "yes please", "confirm_action", { pendingActionId: proposal.result.pendingActionId });
    expect(confirmed).toMatchObject({ ok: false, code: "one_customer_per_chat" });
    const state = await h.service.getDashboardState(h.sessionId);
    expect(state.demoCustomers.map((c) => c.fullName)).not.toContain("Hannah Brooks");
  });
});

describe("New chat", () => {
  it("a fresh conversation in the same Demo Session has no Customer: verifying as B works there", async () => {
    const { h, customer } = await setup();
    await book(h, HANNAH);
    const oldRefusal = await toolTurn(h, "Sarah's job", "verify_customer", pathA(customer("Sarah Mitchell")));
    expect(oldRefusal).toMatchObject({ ok: false, code: "one_customer_per_chat" });

    const fresh = await h.service.openConversation(h.sessionId, undefined);
    expect(fresh).not.toBe(h.conversationId);
    const verified = await toolTurn({ ...h, conversationId: fresh }, "Sarah's job", "verify_customer", pathA(customer("Sarah Mitchell")));
    expect(verified).toMatchObject({ ok: true, result: { verified: true } });
  });
});
