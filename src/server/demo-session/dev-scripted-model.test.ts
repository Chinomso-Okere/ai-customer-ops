import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/components/scenario-tray";
import { createHarness, london } from "@/server/testing/harness";
import { DevScriptedModelClient } from "@/server/testing/dev-scripted-model";

// Seam: the Demo Session service, driven by the dev-only scripted model
// (what `AGENT_MODEL=scripted npm run dev` runs), through the real Agent.
const WEDNESDAY = london("2026-11-18T11:30");

async function chat() {
  const h = await createHarness({ now: WEDNESDAY, modelClient: new DevScriptedModelClient() });
  const sessionId = await h.service.createDemoSession();
  const conversationId = await h.service.openConversation(sessionId, undefined);
  const send = (message: string) => h.service.sendCustomerMessage(sessionId, conversationId, message);
  const say = async (message: string) => (await send(message)).replies.map((r) => r.text).join("\n");
  const dashboard = () => h.service.getDashboardState(sessionId);
  const toolsCalled = async () => (await dashboard()).agentTrace.flatMap((t) => (t.toolName ? [t.toolName] : []));
  return { send, say, dashboard, toolsCalled };
}

const scenario = (label: string) => SCENARIOS.find((s) => s.label === label)!.message;

describe("dev scripted model", () => {
  it("answers a Price List question from the Price List", async () => {
    const c = await chat();
    expect(await c.say("How much is a boiler service?")).toContain("£89");
    expect(await c.say("What does an AC service cost?")).toContain("£120");
    expect(await c.toolsCalled()).toEqual([]);
  });

  it("checks Availability, proposes and confirms a Booking that shows up on the dashboard", async () => {
    const c = await chat();

    expect(await c.say(scenario("Book a boiler service"))).toMatch(/postcode/i);

    const offered = await c.say("My postcode is SW4 7AB");
    expect(offered).toMatch(/1\) .*(AM|PM)/);
    expect(offered).toMatch(/full name/i);

    expect(await c.say("the second one please")).toMatch(/full name and email/i);

    expect(await c.say("Pat Example, pat.example@example.com")).toMatch(/Shall I go ahead/);
    // Nothing is booked until the Customer agrees.
    expect((await c.dashboard()).jobs.some((j) => j.customer.fullName === "Pat Example")).toBe(false);

    const confirmed = await c.say("Yes please");
    const jobReference = /APX-\d+/.exec(confirmed)?.[0];
    expect(jobReference).toBeDefined();
    const job = (await c.dashboard()).jobs.find((j) => j.jobReference === jobReference);
    expect(job).toMatchObject({ issueType: "Boiler Service", jobStatus: "Scheduled", customer: { fullName: "Pat Example" } });
    expect(await c.toolsCalled()).toEqual(["get_availability", "propose_booking", "confirm_action"]);

    // A finished Booking is not re-proposed by later chat.
    expect(await c.say("How much is an annual boiler service?")).toContain("£89");
    expect(await c.say("thanks")).toMatch(/anything else/i);
    expect(await c.toolsCalled()).toEqual(["get_availability", "propose_booking", "confirm_action"]);
  });

  it("looks up a Job only after verifying a demo-friendly Customer", async () => {
    const c = await chat();

    expect(await c.say(scenario("Where's my part?"))).toMatch(/Job Reference|full name/i);
    expect(await c.toolsCalled()).toEqual([]); // nothing revealed or attempted yet

    const answer = await c.say("Sarah Mitchell, SW4 7AB, sarah.mitchell@example.com");
    expect(answer).toContain("Diverter valve");
    expect(answer).toContain("Awaiting Parts");
    expect(await c.toolsCalled()).toEqual(["verify_customer", "get_job_details"]);
  });

  it("reveals nothing when the details do not match", async () => {
    const c = await chat();
    await c.say(scenario("Where's my part?"));
    const answer = await c.say("Sarah Mitchell, SW4 7AB, wrong.email@example.com");
    expect(answer).toMatch(/didn't match/);
    expect(answer).not.toContain("Diverter valve");
    expect(await c.toolsCalled()).toEqual(["verify_customer"]);
  });

  it("escalates a refund request as a Handoff Ticket", async () => {
    const c = await chat();
    const answer = await c.say(scenario("I want a refund"));
    const { handoffTickets } = await c.dashboard();
    const ticket = handoffTickets.find((t) => t.escalationReason === "Out of Policy" && t.summary.includes("refund"));
    expect(ticket).toBeDefined();
    expect(answer).toContain(ticket!.ticketReference);
  });

  it("leaves the gas Safety Script to the pre-model hook", async () => {
    const c = await chat();
    const { replies } = await c.send(scenario("I smell gas"));
    expect(replies[0]!.kind).toBe("safety_script");
    expect(await c.toolsCalled()).toEqual([]);
  });

  it("falls back to a help message for small talk", async () => {
    const c = await chat();
    expect(await c.say("Hello there")).toMatch(/prices|availability/i);
  });
});
