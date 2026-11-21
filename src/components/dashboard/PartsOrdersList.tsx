import { PARTS_STATUSES, nextStatus } from "@/domain/vocabulary";
import type { DashboardPartsOrder } from "@/server/demo-session";
import { AdvanceStatusButton } from "./AdvanceStatusButton";
import { formatDay, slug } from "./format";

export function PartsOrdersList({
  partsOrders,
  onChanged,
}: {
  partsOrders: DashboardPartsOrder[];
  onChanged?: () => void;
}) {
  return (
    <section className="panel">
      <h3 className="panel__title">Parts Orders ({partsOrders.length})</h3>
      <div className="panel__scroll">
        <table className="list">
          <thead>
            <tr>
              <th>Job Reference</th>
              <th>Part</th>
              <th>Parts Status</th>
              <th>Arrival</th>
              <th>Advance</th>
            </tr>
          </thead>
          <tbody>
            {partsOrders.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.jobReference}</td>
                <td>{p.partName}</td>
                <td>
                  <span className={`status status--${slug(p.partsStatus)}`}>{p.partsStatus}</span>
                </td>
                <td>{formatDay(p.expectedArrival)}</td>
                <td>
                  <AdvanceStatusButton
                    target="parts_order"
                    id={p.id}
                    from={p.partsStatus}
                    next={nextStatus(PARTS_STATUSES, p.partsStatus)}
                    onAdvanced={onChanged}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
