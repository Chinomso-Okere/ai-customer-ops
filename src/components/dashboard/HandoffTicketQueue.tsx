"use client";

import { useEffect, useState } from "react";
import type { ChatMessage, DashboardHandoffTicket } from "@/server/demo-session";
import { formatAge, slug } from "./format";

/** While a ticket's detail is open, its transcript is re-read this often. */
const TRANSCRIPT_POLL_MS = 3000;

/**
 * Handoff Tickets, already sorted by Urgency then age by the service. Click a
 * ticket to open its detail: timeline, full transcript, Acknowledge/Resolve.
 */
export function HandoffTicketQueue({
  tickets,
  onChanged,
}: {
  tickets: DashboardHandoffTicket[];
  /** Called after an Operator action, to re-read dashboard state now. */
  onChanged?: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section className="panel">
      <h3 className="panel__title">Handoff Tickets ({tickets.length})</h3>
      {tickets.length === 0 ? (
        <p className="muted">No Handoff Tickets.</p>
      ) : (
        <ul className="tickets">
          {tickets.map((t) => {
            const open = openId === t.id;
            return (
              <li key={t.id} className={`ticket ticket--${slug(t.urgency)}`}>
                <button
                  type="button"
                  className="ticket__toggle"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : t.id)}
                >
                  <span className="ticket__head">
                    <span className={`urgency urgency--${slug(t.urgency)}`}>{t.urgency}</span>
                    <span className="mono">{t.ticketReference}</span>
                    <span>{t.escalationReason}</span>
                    <span className={`status status--${slug(t.status)}`}>{t.status}</span>
                    <span className="muted ticket__age">{formatAge(t.createdAt)}</span>
                  </span>
                  <span className="ticket__summary">{t.summary}</span>
                  <span className="ticket__meta">
                    {t.customer ? `${t.customer.fullName} · ${t.customer.postcode}` : "Unknown Customer"}
                    {t.jobReference ? ` · ${t.jobReference}` : ""}
                    {appendedCount(t) > 0 ? ` · ${appendedCount(t)} follow-up message(s)` : ""}
                  </span>
                </button>
                <p className="ticket__next">
                  <strong>Next step:</strong> {t.recommendedNextStep}
                </p>
                {open && <TicketDetail ticket={t} onChanged={onChanged} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function appendedCount(t: DashboardHandoffTicket): number {
  return t.timeline.filter((e) => e.kind === "appended").length;
}

function TicketDetail({ ticket, onChanged }: { ticket: DashboardHandoffTicket; onChanged?: () => void }) {
  const [transcript, setTranscript] = useState<ChatMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch(`/api/handoff-tickets/${ticket.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Transcript unavailable (${response.status})`);
      const body = (await response.json()) as { transcript: ChatMessage[] };
      if (!cancelled) setTranscript(body.transcript);
    };
    const tick = () => load().catch((e: unknown) => !cancelled && setError(String(e)));
    void tick();
    const timer = ticket.conversationId ? setInterval(tick, TRANSCRIPT_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [ticket.id, ticket.conversationId]);

  const act = async (action: "acknowledge" | "resolve") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/handoff-tickets/${ticket.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Could not ${action} (${response.status})`);
      }
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ticket__detail">
      <div className="ticket__actions">
        <button
          type="button"
          className="button"
          disabled={busy || ticket.status !== "Open"}
          onClick={() => act("acknowledge")}
        >
          Acknowledge
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || ticket.status === "Resolved"}
          onClick={() => act("resolve")}
        >
          Resolve
        </button>
      </div>
      {error && <p className="banner banner--error">{error}</p>}

      <h4 className="ticket__subtitle">Timeline</h4>
      {ticket.timeline.length === 0 ? (
        <p className="muted">No timeline entries.</p>
      ) : (
        <ol className="ticket__timeline">
          {ticket.timeline.map((e, i) => (
            <li key={i}>
              <span className="muted">
                {formatAge(e.at)} · {e.kind}
              </span>{" "}
              {e.text}
            </li>
          ))}
        </ol>
      )}

      <h4 className="ticket__subtitle">Conversation transcript</h4>
      {transcript === null ? (
        <p className="muted">Loading…</p>
      ) : transcript.length === 0 ? (
        <p className="muted">No chat transcript (this ticket was not raised in chat).</p>
      ) : (
        <div className="ticket__transcript">
          {transcript.map((m) => (
            <p
              key={m.id}
              className={`bubble bubble--${m.speaker === "Customer" ? "customer" : "agent"} bubble--${m.kind}`}
            >
              {m.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
