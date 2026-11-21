import { londonInstant } from "@/domain/london-time";
import type { AgentTool, PreModelHook } from "@/server/agent";
import { fixedClock } from "@/server/clock";
import type { Database } from "@/server/db/database";
import { createPGliteDatabase } from "@/server/db/pglite";
import { createDemoSessionService } from "@/server/demo-session";
import type { ModelClient } from "@/server/model-client";
import { loadMigratedSnapshot } from "./migrated-snapshot";
import { ScriptedModelClient } from "./scripted-model-client";

// Booting PGlite takes seconds, so one database is shared per test file
// (Vitest isolates modules per file). It starts from the snapshot that
// global-setup.ts migrated once, so no file migrates inside a test's timeout.
// Every test works in its own Demo Sessions, which are isolated by design
// (ADR-0001), so sharing also exercises session scoping.
let sharedDb: Promise<Database> | undefined;

/** The shared database for this test file, booted on first use. */
export function sharedTestDatabase(): Promise<Database> {
  sharedDb ??= loadMigratedSnapshot().then((loadDataDir) =>
    createPGliteDatabase({ loadDataDir }),
  );
  return sharedDb;
}

/**
 * Seam 1 harness: the real Demo Session service over a real in-process
 * Postgres (PGlite), with a pinned clock. No repository mocks. The model is a
 * `ScriptedModelClient`: script the Agent's turns with `model.script(...)`.
 * Domain tools and pre-model hooks come from the real registries unless
 * overridden (only for tests of the runner's own mechanics).
 */
export async function createHarness(options: {
  now: Date;
  modelClient?: ModelClient;
  agentTools?: readonly AgentTool[];
  preModelHooks?: readonly PreModelHook[];
}) {
  const clock = fixedClock(options.now);
  const db = await sharedTestDatabase();
  const model = options.modelClient ?? new ScriptedModelClient();
  const service = createDemoSessionService({
    db,
    clock,
    modelClient: model,
    agentTools: options.agentTools,
    preModelHooks: options.preModelHooks,
  });
  // `db` is for checks the service cannot make by design (e.g. that cleanup left no rows).
  return { service, clock, model, db };
}

/** A London wall-clock instant, e.g. london("2026-11-18T11:30"). */
export function london(localDateTime: string): Date {
  const [date, time = "00:00"] = localDateTime.split("T") as [string, string?];
  return londonInstant(date, time);
}
