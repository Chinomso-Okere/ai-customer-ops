import { attemptVerification } from "@/server/verification";
import type { AgentTool } from "../types";

const FAILED_GUIDANCE =
  "The details did not match. Do not say which detail was wrong. Remind the Customer to use their full name, postcode and email exactly as they were given when booking (no nicknames), or their Job Reference with postcode or email.";
const LOCKED_GUIDANCE =
  "Verification is locked for this conversation after 3 failed attempts. Do not ask for more details or call verify_customer again. Apologise and offer to pass the request to an Apex team member (Escalation).";

/** Verification (#6): the gate before any Job details are revealed. */
export const verifyCustomer: AgentTool = {
  name: "verify_customer",
  description:
    "Verifies the Customer's identity before anything about their Jobs is shared. Call it when the Customer wants to look up, check, change or ask about an existing Job, Visit or Parts Order. Pass either jobReference with postcode and/or email (Path A), or fullName, postcode and email (Path B, when the Job Reference is lost). Pass details exactly as the Customer typed them; omit fields they did not give. Only call it once the Customer has given a complete set.",
  inputSchema: {
    type: "object",
    properties: {
      jobReference: { type: "string", description: "Job Reference, e.g. APX-10482" },
      postcode: { type: "string", description: "Postcode as the Customer gave it" },
      email: { type: "string", description: "Email as the Customer gave it" },
      fullName: { type: "string", description: "Full name as the Customer gave it" },
    },
    required: [],
    additionalProperties: false,
  },
  promptGuidance:
    "Never reveal Job, Visit, Engineer or Parts Order details until verify_customer has succeeded in this conversation; Customers stay verified for the rest of the conversation. If the Customer has several Jobs and has not named one, list them by Job Reference and short description and ask which one they mean.",
  async run(input, ctx) {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const outcome = await attemptVerification(
      ctx.db,
      ctx,
      {
        jobReference: str(input.jobReference),
        postcode: str(input.postcode),
        email: str(input.email),
        fullName: str(input.fullName),
      },
      ctx.now,
    );
    switch (outcome.kind) {
      case "incomplete":
        return {
          ok: false,
          error: `Not enough details to verify yet: ask the Customer for their ${outcome.missing}. No attempt was used.`,
        };
      case "locked":
        return { ok: true, result: { verified: false, locked: true, attemptsRemaining: 0, guidance: LOCKED_GUIDANCE } };
      case "failed":
        if (outcome.locked) {
          await ctx.enqueueSystemNote(
            "Verification is locked for this conversation (3 failed attempts). Do not share any Job details; offer Escalation to an Apex team member instead.",
          );
        }
        return {
          ok: true,
          result: {
            verified: false,
            locked: outcome.locked,
            attemptsRemaining: outcome.attemptsRemaining,
            guidance: outcome.locked ? LOCKED_GUIDANCE : FAILED_GUIDANCE,
          },
        };
      case "verified": {
        const onlyJob = outcome.jobs.length === 1 ? outcome.jobs[0]!.jobReference : null;
        const jobReference = outcome.jobReference ?? onlyJob;
        return {
          ok: true,
          result: {
            verified: true,
            alreadyVerified: outcome.alreadyVerified,
            customerName: outcome.fullName,
            jobs: outcome.jobs,
            selectedJobReference: jobReference,
            guidance: jobReference
              ? `Call get_job_details for ${jobReference} to see its status.`
              : "The Customer has several Jobs: list them by Job Reference and short description and ask which one they mean.",
          },
        };
      }
    }
  },
};
