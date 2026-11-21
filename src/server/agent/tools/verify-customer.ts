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
    "Verifies the Customer's identity before anything about their Jobs is shared. Call it when the Customer wants to look up, check, change or ask about an existing Job, Visit or Parts Order. Make ONE call with every detail the Customer has given in this conversation: jobReference with postcode and/or email (Path A), or fullName, postcode and email together (Path B, no Job Reference needed). As soon as the Customer has given either set, call it straight away: don't ask for a Job Reference first, and don't judge whether a name looks right (the tool decides). Pass details exactly as the Customer typed them and null for any they have not given. Never split one Customer's details across several calls. Only call it once the Customer has given a complete set.",
  // Every field is required but nullable: strict tool use emits optional
  // properties in schema order, so with optional fields a call that starts with
  // a later field (e.g. fullName) can't carry the earlier ones (eval run 1).
  inputSchema: {
    type: "object",
    properties: {
      jobReference: { type: ["string", "null"], description: "Job Reference, e.g. APX-10482; null if not given" },
      fullName: { type: ["string", "null"], description: "Full name as the Customer gave it; null if not given" },
      postcode: { type: ["string", "null"], description: "Postcode as the Customer gave it; null if not given" },
      email: { type: ["string", "null"], description: "Email as the Customer gave it; null if not given" },
    },
    required: ["jobReference", "fullName", "postcode", "email"],
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
