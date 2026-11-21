import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";

// A Wednesday morning in November (GMT).
const WEDNESDAY = london("2026-11-18T09:15");

describe("seed world", () => {
  it("a new Demo Session is staffed by 5 Engineers", async () => {
    const { service } = await createHarness({ now: WEDNESDAY });

    const sessionId = await service.createDemoSession();
    const state = await service.getDashboardState(sessionId);

    expect(state.calendar.engineers).toHaveLength(5);
  });
});
