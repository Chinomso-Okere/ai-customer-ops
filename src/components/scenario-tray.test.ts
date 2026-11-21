import { describe, expect, it } from "vitest";
import { createHarness, london } from "@/server/testing/harness";
import { trayCustomers } from "./scenario-tray";

async function seededState() {
  const { service } = await createHarness({ now: london("2026-11-18T09:15") });
  return service.getDashboardState(await service.createDemoSession());
}

describe("scenario tray", () => {
  it("lists each demo-friendly Customer's lookup details from the current Demo Session", async () => {
    const state = await seededState();

    const sarah = trayCustomers(state).find((c) => c.fullName === "Sarah Mitchell");

    expect(sarah).toMatchObject({ postcode: "SW4 7AB", email: "sarah.mitchell@example.com" });
    expect(sarah?.jobReferences).toEqual(
      state.demoCustomers.find((d) => d.fullName === "Sarah Mitchell")?.jobReferences,
    );
  });

  it("points visitors at the Customer whose part is on its way for \"Where's my part?\"", async () => {
    const state = await seededState();

    const withParts = trayCustomers(state).filter((c) => c.partsOrders.length > 0);

    const sarah = withParts.find((c) => c.fullName === "Sarah Mitchell");
    expect(sarah?.partsOrders).toEqual([
      expect.objectContaining({ partName: "Diverter valve", partsStatus: "Dispatched" }),
    ]);
    // Only parts still awaited are hints; Fitted parts on old Jobs are not.
    for (const c of withParts) {
      for (const p of c.partsOrders) expect(["Ordered", "Dispatched", "Arrived"]).toContain(p.partsStatus);
    }
  });
});
