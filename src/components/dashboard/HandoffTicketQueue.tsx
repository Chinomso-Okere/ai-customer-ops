import type { DashboardHandoffTicket } from "@/server/demo-session";
import { formatAge, slug } from "./format";

/** Handoff Tickets, already sorted by Urgency then age by the service. */
export function HandoffTicketQueue({ tickets }: { tickets: DashboardHandoffTicket[] }) {
  return (
    <section className="panel">
      <h3 className="panel__title">Handoff Tickets ({tickets.length})</h3>
      {tickets.length === 0 ? (
        <p className="muted">No Handoff Tickets.</p>
      ) : (
        <ul className="tickets">
          {tickets.map((t) => (
            <li key={t.id} className={`ticket ticket--${slug(t.urgency)}`}>
              <div className="ticket__head">
                <span className={`urgency urgency--${slug(t.urgency)}`}>{t.urgency}</span>
                <span className="mono">{t.ticketReference}</span>
                <span>{t.escalationReason}</span>
                <span className={`status status--${slug(t.status)}`}>{t.status}</span>
                <span className="muted ticket__age">{formatAge(t.createdAt)}</span>
              </div>
              <p className="ticket__summary">{t.summary}</p>
              <p className="ticket__meta">
                {t.customer ? `${t.customer.fullName} · ${t.customer.postcode}` : "Unknown Customer"}
                {t.jobReference ? ` · ${t.jobReference}` : ""}
                {t.timeline.length > 1 ? ` · ${t.timeline.length - 1} follow-up message(s)` : ""}
              </p>
              <p className="ticket__next">
                <strong>Next step:</strong> {t.recommendedNextStep}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
