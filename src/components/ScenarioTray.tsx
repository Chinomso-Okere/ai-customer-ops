import type { DashboardState } from "@/server/demo-session";
import { SCENARIOS, trayCustomers } from "./scenario-tray";

/**
 * "Try a scenario": starter-message buttons plus the demo-friendly Customers'
 * lookup details, so a prospect can try Verification without guessing.
 */
export function ScenarioTray({
  state,
  onSend,
  disabled,
}: {
  state: DashboardState | null;
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const customers = state ? trayCustomers(state) : [];
  return (
    <section className="tray" aria-label="Try a scenario">
      <h2 className="tray__title">Try a scenario</h2>
      <div className="tray__buttons">
        {SCENARIOS.map((s) => (
          <button
            key={s.label}
            type="button"
            className="tray__button"
            onClick={() => onSend(s.message)}
            disabled={disabled}
            title={s.message}
          >
            {s.label}
          </button>
        ))}
      </div>
      {customers.length > 0 && (
        <details className="tray__customers" open>
          <summary>Demo Customers you can be (the Agent will ask to verify you)</summary>
          <ul className="tray__list">
            {customers.map((c) => (
              <li key={c.email} className="tray__customer">
                <strong>{c.fullName}</strong>
                <span>
                  Job Reference{c.jobReferences.length > 1 ? "s" : ""}:{" "}
                  <span className="mono">{c.jobReferences.join(", ")}</span>
                </span>
                <span>
                  Postcode <span className="mono">{c.postcode}</span> · {c.email}
                </span>
                {c.partsOrders.map((p) => (
                  <span key={p.id} className="tray__hint">
                    {p.partName} ({p.partsStatus}) on <span className="mono">{p.jobReference}</span>: try
                    &ldquo;Where&rsquo;s my part?&rdquo;
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
