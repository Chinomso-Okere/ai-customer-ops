import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
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
});
