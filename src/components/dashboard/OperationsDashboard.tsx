import type { DashboardState } from "@/server/demo-session";
import { AgentTracePanel } from "./AgentTracePanel";
import { HandoffTicketQueue } from "./HandoffTicketQueue";
import { JobsList } from "./JobsList";
import { PartsOrdersList } from "./PartsOrdersList";
import { VisitCalendar } from "./VisitCalendar";

/** The Operator's view of the Demo Session: a thin render of live state. */
export function OperationsDashboard({ state }: { state: DashboardState }) {
  return (
    <div className="ops">
      <h2 className="ops__title">Operations Dashboard</h2>
      <HandoffTicketQueue tickets={state.handoffTickets} />
      <AgentTracePanel entries={state.agentTrace} />
      <VisitCalendar calendar={state.calendar} />
      <div className="ops__lists">
        <JobsList jobs={state.jobs} />
        <PartsOrdersList partsOrders={state.partsOrders} />
      </div>
    </div>
  );
}
