import { londonInstant } from "@/domain/london-time";
import { fixedClock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import { createPGliteDatabase } from "@/server/db/pglite";
import { createDemoSessionService } from "@/server/demo-session";
import type { ModelClient } from "@/server/model-client";
import { ScriptedModelClient } from "./scripted-model-client";

// Booting PGlite takes seconds, so one migrated database is shared per test
// worker. Every test works in its own Demo Sessions, which are isolated by
// design (ADR-0001), so sharing also exercises session scoping.
let sharedDb: Promise<Database> | undefined;

/**
 * Seam 1 harness: the real Demo Session service over a real in-process
 * Postgres (PGlite), with a pinned clock. No repository mocks. The model is a
 * `ScriptedModelClient` (pass your own to script the Agent's turns).
 */
export async function createHarness(options: { now: Date; modelClient?: ModelClient }) {
  const clock = fixedClock(options.now);
  sharedDb ??= createPGliteDatabase();
  const db = await sharedDb;
  const service = createDemoSessionService({
    db,
    clock,
    modelClient: options.modelClient ?? new ScriptedModelClient(),
  });
  return { service, clock };
}

/** A London wall-clock instant, e.g. london("2026-11-18T11:30"). */
export function london(localDateTime: string): Date {
  const [date, time = "00:00"] = localDateTime.split("T") as [string, string?];
  return londonInstant(date, time);
}
