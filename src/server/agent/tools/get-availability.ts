import { formatPostcode, isInCoverageArea, normalisePostcode, outwardCode } from "@/domain/coverage-area";
import { escalateCapacity } from "../out-of-policy";
import { ISSUE_TYPES, parseIssueType } from "@/domain/vocabulary";
import {
  OFFERED_WINDOWS,
  availabilityHorizon,
  findAvailability,
  windowForModel,
} from "@/server/scheduling/availability";
import { TOOL_ERRORS, type AgentTool } from "../types";

/** Read-only: the earliest Time Windows an Engineer skilled for the Issue Type can attend. */
export const getAvailability: AgentTool = {
  name: "get_availability",
  description:
    "Finds the earliest 3 Time Windows (AM 08:00-12:00 or PM 12:00-17:00, weekdays) in which an Engineer skilled for the Issue Type can visit, within the next 10 weekdays, starting from fromDate if given. Call this before offering any date or Time Window to a Customer, once you know their postcode and Issue Type. When the Customer has named a day (e.g. \"Friday morning\"), pass that day as fromDate to see whether it is free, rather than telling them it isn't. Also tells you if the postcode is outside the Coverage Area.",
  inputSchema: {
    type: "object",
    properties: {
      issueType: { type: "string", enum: [...ISSUE_TYPES], description: "The Customer's Issue Type" },
      postcode: { type: "string", description: "The Customer's full UK postcode, as they gave it" },
      // Required but nullable (not optional): see verify_customer.
      fromDate: {
        type: ["string", "null"],
        description: "YYYY-MM-DD: only windows on or after this day, when the Customer named one; null for the earliest",
      },
    },
    required: ["issueType", "postcode", "fromDate"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const issueType = parseIssueType(input.issueType);
    if (!issueType) return { ok: false, error: `Unknown Issue Type. Use one of: ${ISSUE_TYPES.join(", ")}.` };
    const postcode = typeof input.postcode === "string" ? normalisePostcode(input.postcode) : "";
    if (postcode.length < 5) return { ok: false, error: "Ask the Customer for their full postcode." };
    if (!isInCoverageArea(postcode)) {
      return TOOL_ERRORS.outsideCoverageArea(outwardCode(postcode));
    }
    let fromDate: string | undefined;
    if (typeof input.fromDate === "string" && input.fromDate.trim() !== "") {
      fromDate = input.fromDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return { ok: false, error: "Give fromDate as YYYY-MM-DD, or null." };
    }
    const find = (from?: string) =>
      findAvailability(ctx.db, ctx.sessionId, issueType, ctx.now, { limit: OFFERED_WINDOWS, fromDate: from });
    const windows = await find(fromDate);
    const { until } = availabilityHorizon(ctx.now);
    // Escalate for capacity only when nothing at all is free, not just nothing after fromDate.
    const noCapacity = windows.length === 0 && (!fromDate || (await find()).length === 0);
    return {
      ok: true,
      result: {
        issueType,
        postcode,
        windows: windows.map(windowForModel),
        searchedUntil: until,
        ...(noCapacity && { escalation: await escalateCapacity(ctx, issueType, formatPostcode(postcode), until) }),
      },
    };
  },
};
