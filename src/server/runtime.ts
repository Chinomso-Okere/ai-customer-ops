import "server-only";
import { systemClock } from "./clock";
import type { Database } from "./db/database";
import { createDemoSessionService, type DemoSessionService } from "./demo-session";
import { placeholderModelClient } from "./model-client";

/**
 * Wires the Demo Session service for the running app: Postgres from
 * DATABASE_URL (Neon), or an in-memory PGlite for local dev when it is unset.
 * Cached on globalThis so dev hot reloads keep the same database.
 */
const globalForRuntime = globalThis as unknown as {
  apexDemoSessionService?: Promise<DemoSessionService>;
};

async function createDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { createPostgresDatabase } = await import("./db/postgres");
    return createPostgresDatabase(url);
  }
  const { createPGliteDatabase } = await import("./db/pglite");
  return createPGliteDatabase();
}

export function getDemoSessionService(): Promise<DemoSessionService> {
  globalForRuntime.apexDemoSessionService ??= createDatabase().then(
    (db) => createDemoSessionService({ db, clock: systemClock, modelClient: placeholderModelClient }),
    (error: unknown) => {
      globalForRuntime.apexDemoSessionService = undefined; // retry on the next request
      throw error;
    },
  );
  return globalForRuntime.apexDemoSessionService;
}
