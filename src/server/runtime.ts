import "server-only";
import { systemClock } from "./clock";
import type { Database } from "./db/database";
import { createDemoSessionService, type DemoSessionService } from "./demo-session";
import { AnthropicModelClient, unconfiguredModelClient, type ModelClient } from "./model-client";

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

/** The real model when ANTHROPIC_API_KEY is set; otherwise the Agent apologises on every turn. */
function createModelClient(): ModelClient {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicModelClient() : unconfiguredModelClient;
}

export function getDemoSessionService(): Promise<DemoSessionService> {
  globalForRuntime.apexDemoSessionService ??= createDatabase().then(
    (db) => createDemoSessionService({ db, clock: systemClock, modelClient: createModelClient() }),
    (error: unknown) => {
      globalForRuntime.apexDemoSessionService = undefined; // retry on the next request
      throw error;
    },
  );
  return globalForRuntime.apexDemoSessionService;
}
