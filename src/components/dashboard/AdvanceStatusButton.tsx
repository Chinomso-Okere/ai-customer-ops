"use client";

import { useState } from "react";

/**
 * Presenter control: moves a Job or Parts Order one status step forward.
 * Hidden at terminal statuses (`next` undefined).
 */
export function AdvanceStatusButton({
  target,
  id,
  from,
  next,
  onAdvanced,
}: {
  target: "job" | "parts_order";
  id: string;
  from: string;
  next: string | undefined;
  onAdvanced?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!next) return null;

  const advance = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const response = await fetch("/api/dashboard/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, id, from }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setFailed(body?.message ?? `Couldn't advance (${response.status})`);
      }
      onAdvanced?.();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="advance-button"
      onClick={advance}
      disabled={busy}
      title={failed ?? `Advance to ${next}`}
      aria-label={`Advance ${from} to ${next}`}
    >
      {busy ? "…" : `→ ${next}`}
    </button>
  );
}
