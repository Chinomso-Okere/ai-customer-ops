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

/** `AGENT_MODEL=scripted` was set in a production build. */
export class ScriptedModelRefusedInProductionError extends Error {
  constructor() {
    super("AGENT_MODEL=scripted is a dev-only setting and is refused when NODE_ENV=production. Unset it.");
    this.name = "ScriptedModelRefusedInProductionError";
  }
}

/**
 * The real model when ANTHROPIC_API_KEY is set; otherwise the Agent apologises
 * on every turn. `AGENT_MODEL=scripted` (dev only) swaps in the scripted model
 * so the chat UI can be driven without the paid key.
 */
async function createModelClient(): Promise<ModelClient> {
  if (process.env.AGENT_MODEL === "scripted") {
    // The NODE_ENV test is inlined at build time, so a production build drops
    // this import (and the scripted model with it) and keeps only the refusal.
    if (process.env.NODE_ENV !== "production") {
      const { DevScriptedModelClient } = await import("./testing/dev-scripted-model");
      return new DevScriptedModelClient();
    }
    throw new ScriptedModelRefusedInProductionError();
  }
  return process.env.ANTHROPIC_API_KEY ? new AnthropicModelClient() : unconfiguredModelClient;
}

export function getDemoSessionService(): Promise<DemoSessionService> {
  globalForRuntime.apexDemoSessionService ??= (async () => {
    const modelClient = await createModelClient();
    const db = await createDatabase();
    return createDemoSessionService({ db, clock: systemClock, modelClient });
  })().catch((error: unknown) => {
    globalForRuntime.apexDemoSessionService = undefined; // retry on the next request
    throw error;
  });
  return globalForRuntime.apexDemoSessionService;
}
