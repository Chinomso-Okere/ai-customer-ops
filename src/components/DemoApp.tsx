"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardState } from "@/server/demo-session";
import { ApexWebsite } from "./ApexWebsite";
import { OperationsDashboard } from "./dashboard/OperationsDashboard";

/** How often the Operations Dashboard re-reads live state. */
const POLL_INTERVAL_MS = 1500;

async function openDemoSession(reset: boolean): Promise<void> {
  const response = await fetch(reset ? "/api/demo-session/reset" : "/api/demo-session", {
    method: "POST",
  });
  if (!response.ok) throw new Error(`Could not open a Demo Session (${response.status})`);
}

/** The split-screen demo: fake Apex website on the left, Operations Dashboard on the right. */
export function DemoApp() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const refresh = useCallback(async function load(reopen = true): Promise<void> {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (response.status === 404 && reopen) {
      // Session missing or expired: start a new one, then read it once more.
      await openDemoSession(false);
      return load(false);
    }
    if (!response.ok) throw new Error(`Dashboard unavailable (${response.status})`);
    setState((await response.json()) as DashboardState);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (!document.hidden) {
        try {
          await refresh();
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    openDemoSession(false)
      .then(tick)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const reset = async () => {
    setResetting(true);
    try {
      await openDemoSession(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="demo">
      <header className="demo-bar">
        <span className="demo-bar__title">Agentic Customer Operations — live demo</span>
        <span className="demo-bar__note">Apex Heating &amp; Cooling is a fictional company.</span>
        <button className="button" onClick={reset} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset demo"}
        </button>
      </header>
      <main className="demo-split">
        <section className="demo-split__pane demo-split__pane--site" aria-label="Apex website">
          <ApexWebsite />
        </section>
        <section className="demo-split__pane demo-split__pane--ops" aria-label="Operations Dashboard">
          {error && <p className="banner banner--error">{error}</p>}
          {state ? <OperationsDashboard state={state} /> : <p className="muted">Starting your Demo Session…</p>}
        </section>
      </main>
    </div>
  );
}
