import { formatPostcode, isInCoverageArea, normalisePostcode, outwardCode } from "@/domain/coverage-area";
import { escalateCapacity } from "../out-of-policy";
import { ISSUE_TYPES, parseIssueType } from "@/domain/vocabulary";
import {
  OFFERED_WINDOWS,
  availabilityHorizon,
  findAvailability,
  windowForModel,
} from "@/server/scheduling/availability";
import type { AgentTool } from "../types";

/** Read-only: the earliest Time Windows an Engineer skilled for the Issue Type can attend. */
export const getAvailability: AgentTool = {
  name: "get_availability",
  description:
    "Finds the earliest 3 Time Windows (AM 08:00-12:00 or PM 12:00-17:00, weekdays) in which an Engineer skilled for the Issue Type can visit, within the next 10 weekdays. Call this before offering any date or Time Window to a Customer, once you know their postcode and Issue Type. Also tells you if the postcode is outside the Coverage Area.",
  inputSchema: {
    type: "object",
    properties: {
      issueType: { type: "string", enum: [...ISSUE_TYPES], description: "The Customer's Issue Type" },
      postcode: { type: "string", description: "The Customer's full UK postcode, as they gave it" },
    },
    required: ["issueType", "postcode"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const issueType = parseIssueType(input.issueType);
    if (!issueType) return { ok: false, error: `Unknown Issue Type. Use one of: ${ISSUE_TYPES.join(", ")}.` };
    const postcode = typeof input.postcode === "string" ? normalisePostcode(input.postcode) : "";
    if (postcode.length < 5) return { ok: false, error: "Ask the Customer for their full postcode." };
    if (!isInCoverageArea(postcode)) {
      return {
        ok: false,
        error: `${outwardCode(postcode)} is outside the Apex Coverage Area, so it can't be booked. Politely tell the Customer Apex doesn't cover their postcode. This is not an Escalation.`,
      };
    }
    const windows = await findAvailability(ctx.db, ctx.sessionId, issueType, ctx.now, { limit: OFFERED_WINDOWS });
    const { until } = availabilityHorizon(ctx.now);
    return {
      ok: true,
      result: {
        issueType,
        postcode,
        windows: windows.map(windowForModel),
        searchedUntil: until,
        ...(windows.length === 0 && { escalation: await escalateCapacity(ctx, issueType, formatPostcode(postcode), until) }),
      },
    };
  },
};
