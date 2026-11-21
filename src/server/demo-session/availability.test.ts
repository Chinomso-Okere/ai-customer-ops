import { describe, expect, it } from "vitest";
import { london } from "@/server/testing/harness";
import { chatHarness, toolTurn } from "@/server/testing/tool-turns";

// 2026-11-18 is a Wednesday (GMT).
const WEDNESDAY_0930 = london("2026-11-18T09:30");

describe("Availability (get_availability)", () => {
  it("a postcode outside the Coverage Area is declined, without an Escalation", async () => {
    const h = await chatHarness(WEDNESDAY_0930);

    const res = await toolTurn(h, "Can you service my boiler? I'm in M1 1AE", "get_availability", {
      issueType: "Boiler Service",
      postcode: "M1 1AE",
    });

    expect(res).toMatchObject({ ok: false, code: "outside_coverage_area" });
    const state = await h.service.getDashboardState(h.sessionId);
    expect(state.handoffTickets.filter((t) => t.status === "Open")).toHaveLength(2); // only the seeded ones
  });
});

const windowsAt = async (now: Date, issueType = "Boiler Service", postcode = "SW4 7AB") => {
  const h = await chatHarness(now);
  const res = await toolTurn(h, "When can you come?", "get_availability", { issueType, postcode });
  if (!res.ok) throw new Error(res.error);
  return res.result as { windows: { date: string; timeWindow: string }[]; searchedUntil: string };
};
const slots = (r: { windows: { date: string; timeWindow: string }[] }) =>
  r.windows.map((w) => `${w.date} ${w.timeWindow}`);

describe("Availability: lead time, earliest 3 and rollover", () => {
  it("offers the earliest 3 Time Windows, in date order", async () => {
    expect(slots(await windowsAt(WEDNESDAY_0930))).toEqual([
      "2026-11-18 PM",
      "2026-11-19 AM",
      "2026-11-19 PM",
    ]);
  });

  it("a window starting in under 2 hours is never offered: at 11:30 today's AM (and PM) are out", async () => {
    const offered = slots(await windowsAt(london("2026-11-18T11:30")));
    expect(offered).toHaveLength(3);
    expect(offered.filter((s) => s.startsWith("2026-11-18"))).toEqual([]);
    expect(offered[0]).toBe("2026-11-19 AM");
  });

  it("a window starting exactly 2 hours from now is bookable; a minute later it is not", async () => {
    expect(slots(await windowsAt(london("2026-11-18T06:00")))[0]).toBe("2026-11-18 AM");
    expect(slots(await windowsAt(london("2026-11-18T06:01")))[0]).toBe("2026-11-18 PM");
    expect(slots(await windowsAt(london("2026-11-18T10:00")))[0]).toBe("2026-11-18 PM");
    expect(slots(await windowsAt(london("2026-11-18T10:01")))[0]).toBe("2026-11-19 AM");
  });

  it("on Friday afternoon it rolls over the weekend to Monday", async () => {
    const offered = slots(await windowsAt(london("2026-11-20T16:30")));
    expect(offered[0]).toBe("2026-11-23 AM");
    expect(offered.every((s) => s >= "2026-11-23")).toBe(true);
  });

  it("at the weekend it offers weekdays only", async () => {
    const offered = slots(await windowsAt(london("2026-11-21T10:00")));
    expect(offered[0]).toBe("2026-11-23 AM");
  });

  it("searches 10 weekdays, today included", async () => {
    expect((await windowsAt(WEDNESDAY_0930)).searchedUntil).toBe("2026-12-01");
    expect((await windowsAt(london("2026-11-21T10:00"))).searchedUntil).toBe("2026-12-04");
  });

  it("accepts the Issue Type in any casing", async () => {
    expect(slots(await windowsAt(WEDNESDAY_0930, "boiler service"))).toHaveLength(3);
  });
});
