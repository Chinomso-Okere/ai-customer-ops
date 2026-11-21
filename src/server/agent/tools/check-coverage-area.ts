import { isInCoverageArea, normalisePostcode, outwardCode } from "@/domain/coverage-area";
import type { AgentTool } from "../types";

/** Read-only: does Apex serve this postcode? */
export const checkCoverageArea: AgentTool = {
  name: "check_coverage_area",
  description:
    "Checks whether Apex serves a UK postcode (its Coverage Area). Call this whenever the Customer asks whether Apex covers their area, or gives a postcode for work. Accepts any spacing or case.",
  inputSchema: {
    type: "object",
    properties: {
      postcode: { type: "string", description: "The UK postcode exactly as the Customer gave it" },
    },
    required: ["postcode"],
    additionalProperties: false,
  },
  async run(input) {
    const postcode = typeof input.postcode === "string" ? normalisePostcode(input.postcode) : "";
    if (postcode.length < 2) {
      return { ok: false, error: "No postcode given. Ask the Customer for their full postcode." };
    }
    return {
      ok: true,
      result: {
        postcode,
        outwardCode: outwardCode(postcode),
        inCoverageArea: isInCoverageArea(postcode),
      },
    };
  },
};
