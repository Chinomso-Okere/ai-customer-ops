import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/components/scenario-tray";
import { createHarness, london } from "@/server/testing/harness";
import { DevScriptedModelClient } from "@/server/testing/dev-scripted-model";

// Seam: the Demo Session service, driven by the dev-only scripted model
// (what `AGENT_MODEL=scripted npm run dev` runs), through the real Agent.
// Assertions are on facts (tools called, Jobs, Handoff Tickets, tool results),
// not on the router's own phrasing.
const WEDNESDAY = london("2026-11-18T11:30");

async function chat() {
  const h = await createHarness({ now: WEDNESDAY, modelClient: new DevScriptedModelClient() });
  const sessionId = await h.service.createDemoSession();
  const conversationId = await h.service.openConversation(sessionId, undefined);
  const send = (message: string) => h.service.sendCustomerMessage(sessionId, conversationId, message);
  const say = async (message: string) => (await send(message)).replies.map((r) => r.text).join("\n");
  const dashboard = () => h.service.getDashboardState(sessionId);
  const toolsCalled = async () => (await dashboard()).agentTrace.flatMap((t) => (t.toolName ? [t.toolName] : []));
  /** The successful results of one tool, parsed, from the Agent Trace. */
  const resultsOf = async (toolName: string) =>
    (await dashboard()).agentTrace
      .filter((t) => t.toolName === toolName && !t.isError && t.result)
      .map((t) => JSON.parse(t.result!) as Record<string, any>);
  const inputsOf = async (toolName: string) =>
    (await dashboard()).agentTrace.filter((t) => t.toolName === toolName).map((t) => t.input as Record<string, any>);
  return { conversationId, send, say, dashboard, toolsCalled, resultsOf, inputsOf };
}

const scenario = (label: string) => SCENARIOS.find((s) => s.label === label)!.message;

describe("dev scripted model", () => {
  it("answers a Price List question from the Price List", async () => {
    const c = await chat();
    expect(await c.say("How much is a boiler service?")).toContain("£89");
    expect(await c.say("What does an AC service cost?")).toContain("£120");
    expect(await c.toolsCalled()).toEqual([]);
  });

  it("checks Availability, proposes and confirms a Job that shows up on the dashboard", async () => {
    const c = await chat();
    const patJob = async () => (await c.dashboard()).jobs.find((j) => j.customer.fullName === "Pat Example");

    await c.say(scenario("Book a boiler service"));
    expect(await c.toolsCalled()).toEqual([]); // the postcode is still missing

    await c.say("My postcode is SW4 7AB");
    expect(await c.toolsCalled()).toEqual(["get_availability"]);
    const [availability] = await c.resultsOf("get_availability");
    const windows: Array<{ date: string; timeWindow: string }> = availability!.windows;
    expect(windows.length).toBeGreaterThan(1);

    await c.say("the second one please");
    expect(await c.toolsCalled()).toEqual(["get_availability"]); // name and email are still missing

    await c.say("Pat Example, pat.example@example.com");
    expect(await c.toolsCalled()).toEqual(["get_availability", "propose_booking"]);
    const [proposal] = await c.resultsOf("propose_booking");
    expect(proposal!.pendingActionId).toBeDefined();
    // Nothing is booked until the Customer agrees.
    expect(await patJob()).toBeUndefined();

    await c.say("Yes please");
    expect(await c.toolsCalled()).toEqual(["get_availability", "propose_booking", "confirm_action"]);
    expect((await c.inputsOf("confirm_action")).map((i) => i.pendingActionId)).toEqual([proposal!.pendingActionId]);
    const job = await patJob();
    expect(job).toMatchObject({ issueType: "Boiler Service", jobStatus: "Scheduled" });
    expect(job!.visits).toMatchObject([{ date: windows[1]!.date, timeWindow: windows[1]!.timeWindow }]);

    // A finished Job is not re-proposed by later chat.
    const jobCount = (await c.dashboard()).jobs.length;
    expect(await c.say("How much is an annual boiler service?")).toContain("£89");
    await c.say("thanks");
    expect(await c.toolsCalled()).toEqual(["get_availability", "propose_booking", "confirm_action"]);
    expect((await c.dashboard()).jobs).toHaveLength(jobCount);
  });

  it("looks up a Job only after verifying a demo-friendly Customer", async () => {
    const c = await chat();

    await c.say(scenario("Where's my part?"));
    expect(await c.toolsCalled()).toEqual([]); // nothing revealed or attempted yet

    const answer = await c.say("Sarah Mitchell, SW4 7AB, sarah.mitchell@example.com");
    expect(await c.toolsCalled()).toEqual(["verify_customer", "get_job_details"]);
    expect(await c.resultsOf("verify_customer")).toMatchObject([{ verified: true }]);
    expect(answer).toContain("Diverter valve");
    expect(answer).toContain("Awaiting Parts");
  });

  it("reveals nothing when the details do not match", async () => {
    const c = await chat();
    await c.say(scenario("Where's my part?"));
    const answer = await c.say("Sarah Mitchell, SW4 7AB, wrong.email@example.com");
    expect(await c.toolsCalled()).toEqual(["verify_customer"]);
    expect(await c.resultsOf("verify_customer")).toMatchObject([{ verified: false, locked: false }]);
    expect(answer).not.toContain("Diverter valve");
  });

  it("escalates a refund request as a Handoff Ticket", async () => {
    const c = await chat();
    const answer = await c.say(scenario("I want a refund"));
    expect(await c.toolsCalled()).toEqual(["create_handoff_ticket"]);
    const tickets = (await c.dashboard()).handoffTickets.filter(
      (t) => t.conversationId === c.conversationId && t.escalationReason === "Out of Policy",
    );
    expect(tickets).toHaveLength(1);
    expect(answer).toContain(tickets[0]!.ticketReference);
  });

  it("leaves the gas Safety Script to the pre-model hook", async () => {
    const c = await chat();
    const { replies } = await c.send(scenario("I smell gas"));
    expect(replies[0]!.kind).toBe("safety_script");
    expect(await c.toolsCalled()).toEqual([]);
  });

  it("answers small talk without calling any tool", async () => {
    const c = await chat();
    const { replies } = await c.send("Hello there");
    expect(replies.map((r) => r.kind)).toEqual(["text"]);
    expect(await c.toolsCalled()).toEqual([]);
  });
});
