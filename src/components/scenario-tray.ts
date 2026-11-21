import type { DashboardPartsOrder, DashboardState, DemoCustomer } from "@/server/demo-session";

/** Starter messages for the "Try a scenario" tray. Buttons only send this text. */
export const SCENARIOS = [
  { label: "Book a boiler service", message: "Hi, I'd like to book my annual boiler service please." },
  { label: "Where's my part?", message: "Hi, I'm waiting on a part for my boiler repair. Where's my part?" },
  { label: "I smell gas", message: "I can smell gas in my kitchen, what should I do?" },
  { label: "I want a refund", message: "I'm not happy with the last repair and I want a refund." },
] as const;

export interface TrayCustomer extends DemoCustomer {
  /** Parts still awaited on this Customer's Jobs (not yet Fitted). */
  partsOrders: DashboardPartsOrder[];
}

/** The demo-friendly Customers the tray shows, with hints drawn from the live Demo Session. */
export function trayCustomers(state: DashboardState): TrayCustomer[] {
  return state.demoCustomers.map((customer) => ({
    ...customer,
    partsOrders: state.partsOrders.filter(
      (p) => p.partsStatus !== "Fitted" && customer.jobReferences.includes(p.jobReference),
    ),
  }));
}
