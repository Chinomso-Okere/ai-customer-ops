import type { DashboardState } from "@/server/demo-session";
import { AgentTracePanel } from "./AgentTracePanel";
import { HandoffTicketQueue } from "./HandoffTicketQueue";
import { JobsList } from "./JobsList";
import { PartsOrdersList } from "./PartsOrdersList";
import { PossibleDuplicatesPanel } from "./PossibleDuplicatesPanel";
import { VisitCalendar } from "./VisitCalendar";

/**
 * The Operator's view of the Demo Session: a thin render of live state.
 * `onChanged`: the Operator changed something (e.g. advanced a status); re-read the state now.
 */
export function OperationsDashboard({ state, onChanged }: { state: DashboardState; onChanged?: () => void }) {
  return (
    <div className="ops">
      <h2 className="ops__title">Operations Dashboard</h2>
      <HandoffTicketQueue tickets={state.handoffTickets} onChanged={onChanged} />
      <PossibleDuplicatesPanel duplicates={state.possibleDuplicateCustomers} />
      <AgentTracePanel entries={state.agentTrace} />
      <VisitCalendar calendar={state.calendar} />
      <div className="ops__lists">
        <JobsList jobs={state.jobs} onChanged={onChanged} />
        <PartsOrdersList partsOrders={state.partsOrders} onChanged={onChanged} />
      </div>
    </div>
  );
}
