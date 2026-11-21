import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
import { queuedNotes } from "@/server/testing/queued-notes";
import {
  ScriptedModelClient,
  lastToolResults,
  reply,
  text,
  toolCall,
} from "@/server/testing/scripted-model-client";

const WEDNESDAY = london("2026-11-18T11:30");

async function chatHarness() {
  const model = new ScriptedModelClient();
  const harness = await createHarness({ now: WEDNESDAY, modelClient: model });
  const sessionId = await harness.service.createDemoSession();
  const conversationId = await harness.service.openConversation(sessionId, undefined);
  const { demoCustomers } = await harness.service.getDashboardState(sessionId);
  const customer = (name: string) => demoCustomers.find((c) => c.fullName === name)!;
  return { ...harness, model, sessionId, conversationId, customer };
}

/** Sends one Customer message in which the Agent calls `toolName` once, and returns the parsed tool result. */
async function callTool(
  h: Awaited<ReturnType<typeof chatHarness>>,
  toolName: string,
  input: Record<string, unknown>,
  customerText = "Here are my details",
) {
  h.model.script(reply([toolCall(toolName, input)]), reply([text("OK.")]));
  await h.service.sendCustomerMessage(h.sessionId, h.conversationId, customerText);
  const [result] = lastToolResults(h.model.requests.at(-1)!);
  const content = result!.content as string;
  return { isError: result!.is_error ?? false, content, json: result!.is_error ? null : JSON.parse(content) };
}

describe("Verification and Job lookup", () => {
  it("Path A: Job Reference + postcode verifies the Customer, then Job details are available", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");
    const [jobReference] = sarah.jobReferences;

    const verified = await callTool(h, "verify_customer", { jobReference, postcode: sarah.postcode });
    expect(verified.json).toMatchObject({ verified: true });
    expect(verified.json.jobs.map((j: { jobReference: string }) => j.jobReference)).toEqual([jobReference]);

    const details = await callTool(h, "get_job_details", { jobReference });
    expect(details.isError).toBe(false);
    expect(details.json).toMatchObject({
      jobReference,
      jobStatus: "Awaiting Parts",
      partsOrders: [{ partName: "Diverter valve", partsStatus: "Dispatched", expectedArrival: "2026-11-19" }],
    });
  });

  it("Path A: Job Reference + email (any case or spacing) verifies, and upcoming Visits show date, Time Window and Engineer first name", async () => {
    const h = await chatHarness();
    const james = h.customer("James Patel");
    const [jobReference] = james.jobReferences;

    const verified = await callTool(h, "verify_customer", {
      jobReference: ` ${jobReference!.toLowerCase()} `,
      email: `  ${james.email.toUpperCase()}`,
    });
    expect(verified.json).toMatchObject({ verified: true, selectedJobReference: jobReference });

    const details = await callTool(h, "get_job_details", { jobReference });
    expect(details.json).toMatchObject({ jobStatus: "Scheduled", partsOrders: [] });
    // James's annual service is 3 weekdays out: Monday 23 November, AM.
    expect(details.json.upcomingVisits).toHaveLength(1);
    expect(details.json.upcomingVisits[0]).toMatchObject({ date: "2026-11-23", timeWindow: "AM" });
    expect(details.json.upcomingVisits[0].engineerFirstName).toMatch(/^[A-Z][a-z]+$/);
    expect(details.json.assignedEngineerFirstName).toBe(details.json.upcomingVisits[0].engineerFirstName);
  });

  it("Path B: full name + postcode + email verifies a Customer who lost their Job Reference", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");

    const verified = await callTool(h, "verify_customer", {
      fullName: "sarah  mitchell",
      postcode: sarah.postcode,
      email: sarah.email,
    });

    expect(verified.json).toMatchObject({ verified: true, selectedJobReference: sarah.jobReferences[0] });
    expect((await callTool(h, "get_job_details", { jobReference: sarah.jobReferences[0] })).isError).toBe(false);
  });

  it("verify_customer asks the model for every detail in one call (string or null), so the strict grammar can't cut a Path B call short", async () => {
    // Strict tool use emits optional properties in schema order: with optional
    // fields, a call that starts with fullName (listed last) could hold nothing else.
    const h = await chatHarness();
    h.model.script(reply([text("Hi!")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "Hello");

    const tool = h.model.requests[0]!.tools!.find((t) => "name" in t && t.name === "verify_customer")!;
    const schema = (tool as { input_schema: { properties: Record<string, { type: unknown }>; required: string[] } }).input_schema;
    expect([...schema.required].sort()).toEqual(["email", "fullName", "jobReference", "postcode"]);
    for (const field of schema.required) expect(schema.properties[field]!.type).toEqual(["string", "null"]);
  });

  it("Path B with the details the Customer didn't give sent as null verifies", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");

    const verified = await callTool(h, "verify_customer", {
      jobReference: null,
      fullName: sarah.fullName,
      postcode: sarah.postcode,
      email: sarah.email,
    });

    expect(verified.json).toMatchObject({ verified: true, selectedJobReference: sarah.jobReferences[0] });
  });

  it("an unnormalised postcode (no space, lower case) still matches", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");
    const squashed = sarah.postcode.replace(/\s/g, "").toLowerCase();

    const verified = await callTool(h, "verify_customer", { jobReference: sarah.jobReferences[0], postcode: squashed });

    expect(squashed).not.toBe(sarah.postcode);
    expect(verified.json).toMatchObject({ verified: true });
  });

  it("a nickname fails Verification and uses an attempt, and no Job details become available", async () => {
    const h = await chatHarness();
    const james = h.customer("James Patel");

    const failed = await callTool(h, "verify_customer", { fullName: "Jim Patel", postcode: james.postcode, email: james.email });

    expect(failed.json).toMatchObject({ verified: false, locked: false, attemptsRemaining: 2 });
    expect((await callTool(h, "get_job_details", { jobReference: james.jobReferences[0] })).isError).toBe(true);
  });

  it("after 3 failed attempts Verification locks for the conversation, even for correct details, and the Agent is sent a system note about the lock", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");
    const wrong = { jobReference: sarah.jobReferences[0], postcode: "SE1 1AA" };
    const notesDelivered = () => queuedNotes(h.model.requests.at(-1)!, "all-turns");

    expect((await callTool(h, "verify_customer", wrong)).json).toMatchObject({ attemptsRemaining: 2 });
    expect((await callTool(h, "verify_customer", wrong)).json).toMatchObject({ attemptsRemaining: 1 });
    expect(notesDelivered()).toHaveLength(0);
    const third = await callTool(h, "verify_customer", wrong);
    expect(third.json).toMatchObject({ verified: false, locked: true, attemptsRemaining: 0 });

    const correct = await callTool(h, "verify_customer", { jobReference: sarah.jobReferences[0], postcode: sarah.postcode });
    expect(correct.json).toMatchObject({ verified: false, locked: true });
    expect((await callTool(h, "get_job_details", { jobReference: sarah.jobReferences[0] })).isError).toBe(true);

    // The lock queues exactly one system note, delivered with the next Customer message.
    expect(notesDelivered()).toHaveLength(1);

    // A fresh conversation in the same Demo Session is not locked.
    const other = await h.service.openConversation(h.sessionId, undefined);
    const fresh = await callTool({ ...h, conversationId: other }, "verify_customer", {
      jobReference: sarah.jobReferences[0],
      postcode: sarah.postcode,
    });
    expect(fresh.json).toMatchObject({ verified: true });
  });

  it("incomplete details are sent back to the model without using an attempt", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");

    for (let i = 0; i < 4; i++) {
      expect((await callTool(h, "verify_customer", { fullName: sarah.fullName, postcode: sarah.postcode })).isError).toBe(true);
    }
    expect((await callTool(h, "verify_customer", { fullName: sarah.fullName, postcode: sarah.postcode, email: sarah.email })).json)
      .toMatchObject({ verified: true });
  });

  it("Path B for a Customer with several Jobs lists them by Job Reference and short description without picking one", async () => {
    const h = await chatHarness();
    const emma = h.customer("Emma Clarke");
    expect(emma.jobReferences.length).toBeGreaterThan(1);

    const verified = await callTool(h, "verify_customer", { fullName: emma.fullName, postcode: emma.postcode, email: emma.email });

    expect(verified.json).toMatchObject({ verified: true, selectedJobReference: null });
    expect(verified.json.jobs.map((j: { jobReference: string }) => j.jobReference).sort()).toEqual([...emma.jobReferences].sort());
    for (const job of verified.json.jobs) expect(job.description.length).toBeGreaterThan(0);

    // Any of Emma's Jobs can then be looked up.
    for (const jobReference of emma.jobReferences) {
      expect((await callTool(h, "get_job_details", { jobReference })).isError).toBe(false);
    }
  });

  it("the Customer stays verified for the conversation, but only for their own Jobs", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");
    const james = h.customer("James Patel");
    await callTool(h, "verify_customer", { jobReference: sarah.jobReferences[0], email: sarah.email });

    h.model.script(reply([text("You're welcome!")]));
    await h.service.sendCustomerMessage(h.sessionId, h.conversationId, "thanks");
    // Later lookups need no new Verification...
    expect((await callTool(h, "get_job_details", { jobReference: sarah.jobReferences[0] }, "Any update?")).isError).toBe(false);
    // ...but someone else's Job Reference is refused.
    const other = await callTool(h, "get_job_details", { jobReference: james.jobReferences[0] });
    expect(other.isError).toBe(true);
    expect(other.content).not.toMatch(/James|Scheduled/);
  });

  it("Job details are refused before Verification", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");

    const details = await callTool(h, "get_job_details", { jobReference: sarah.jobReferences[0] });

    expect(details.isError).toBe(true);
    expect(details.content).not.toMatch(/Diverter|Awaiting/);
  });

  it("Verification in one Demo Session doesn't verify another session's conversations", async () => {
    const a = await chatHarness();
    const sarah = a.customer("Sarah Mitchell");
    await callTool(a, "verify_customer", { jobReference: sarah.jobReferences[0], postcode: sarah.postcode });
    const b = await chatHarness();

    expect((await callTool(b, "get_job_details", { jobReference: sarah.jobReferences[0] })).isError).toBe(true);
  });

  it("Verification attempts and Job lookups appear in the Agent Trace", async () => {
    const h = await chatHarness();
    const sarah = h.customer("Sarah Mitchell");
    await callTool(h, "verify_customer", { jobReference: sarah.jobReferences[0], postcode: "SE1 1AA" });
    await callTool(h, "verify_customer", { jobReference: sarah.jobReferences[0], postcode: sarah.postcode });
    await callTool(h, "get_job_details", { jobReference: sarah.jobReferences[0] });

    const { agentTrace } = await h.service.getDashboardState(h.sessionId);
    expect(agentTrace.map((e) => e.toolName)).toEqual(["verify_customer", "verify_customer", "get_job_details"]);
    expect(JSON.parse(agentTrace[0]!.result!)).toMatchObject({ verified: false });
    expect(JSON.parse(agentTrace[1]!.result!)).toMatchObject({ verified: true });
    expect(JSON.parse(agentTrace[2]!.result!)).toMatchObject({ jobStatus: "Awaiting Parts" });
  });
});
