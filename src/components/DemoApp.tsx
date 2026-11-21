"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardState } from "@/server/demo-session";
import { ApexWebsite } from "./ApexWebsite";
import { OperationsDashboard } from "./dashboard/OperationsDashboard";

/** How often the Operations Dashboard re-reads live state. */
const POLL_INTERVAL_MS = 1500;
/** While rate limited, retry opening a Demo Session this rarely. */
const RATE_LIMITED_RETRY_MS = 60_000;

/** Too many new Demo Sessions from this IP: a friendly "try again later", not a failure. */
class RateLimitedError extends Error {}

async function openDemoSession(reset: boolean): Promise<void> {
  const response = await fetch(reset ? "/api/demo-session/reset" : "/api/demo-session", {
    method: "POST",
  });
  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new RateLimitedError(body?.message ?? "You've started a lot of demos recently. Please try again later.");
  }
  if (!response.ok) throw new Error(`Could not open a Demo Session (${response.status})`);
}

/** The split-screen demo: fake Apex website on the left, Operations Dashboard on the right. */
export function DemoApp() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A friendly notice (e.g. "try again later"), shown instead of an error. */
  const [notice, setNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  /** Which pane shows on narrow (mobile) screens; both show side by side on wider ones. */
  const [mobileTab, setMobileTab] = useState<"site" | "ops">("site");
  const refresh = useCallback(async function load(reopen = true): Promise<void> {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (response.status === 404 && reopen) {
      // Session missing or expired: start a new one, then read it once more.
      await openDemoSession(false);
      setNotice(null);
      return load(false);
    }
    if (!response.ok) throw new Error(`Dashboard unavailable (${response.status})`);
    setState((await response.json()) as DashboardState);
    setError(null);
  }, []);

  const showFailure = useCallback((e: unknown) => {
    if (e instanceof RateLimitedError) setNotice(e.message);
    else setError(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The first tick opens the Demo Session: the dashboard 404s without one.
    const tick = async () => {
      let delay = POLL_INTERVAL_MS;
      if (!document.hidden) {
        try {
          await refresh();
        } catch (e) {
          if (e instanceof RateLimitedError) delay = RATE_LIMITED_RETRY_MS;
          if (!cancelled) showFailure(e);
        }
      }
      if (!cancelled) timer = setTimeout(tick, delay);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, showFailure]);

  const reset = async () => {
    setResetting(true);
    try {
      await openDemoSession(true);
      setNotice(null);
      await refresh();
    } catch (e) {
      showFailure(e);
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
      <nav className="demo-tabs" role="tablist" aria-label="Demo views">
        {(
          [
            ["site", "Chat"],
            ["ops", "Dashboard"],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab}
            className={`demo-tabs__tab${mobileTab === tab ? " demo-tabs__tab--active" : ""}`}
            onClick={() => setMobileTab(tab)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className={`demo-split demo-split--show-${mobileTab}`}>
        <section className="demo-split__pane demo-split__pane--site" aria-label="Apex website">
          <ApexWebsite
            sessionId={state?.sessionId ?? null}
            state={state}
            onStartNewDemo={reset}
            startingNewDemo={resetting}
            notice={notice}
          />
        </section>
        <section className="demo-split__pane demo-split__pane--ops" aria-label="Operations Dashboard">
          {notice && (
            <p className="banner banner--notice" role="status">
              {notice}
            </p>
          )}
          {error && <p className="banner banner--error">{error}</p>}
          {state ? (
            <OperationsDashboard state={state} onChanged={() => void refresh().catch(showFailure)} />
          ) : (
            !notice && <p className="muted">Starting your Demo Session…</p>
          )}
        </section>
      </main>
    </div>
  );
}
