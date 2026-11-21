import type { DashboardPartsOrder } from "@/server/demo-session";
import { formatDay, slug } from "./format";

export function PartsOrdersList({ partsOrders }: { partsOrders: DashboardPartsOrder[] }) {
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
