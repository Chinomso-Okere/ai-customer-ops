import { afterEach, describe, expect, it, vi } from "vitest";

// `server-only` throws outside a server bundle; the runtime is server code.
vi.mock("server-only", () => ({}));

describe("runtime model selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { apexDemoSessionService?: unknown }).apexDemoSessionService;
  });

  it("refuses AGENT_MODEL=scripted in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENT_MODEL", "scripted");
    vi.stubEnv("DATABASE_URL", "");
    const { getDemoSessionService, ScriptedModelRefusedInProductionError } = await import("./runtime");

    await expect(getDemoSessionService()).rejects.toBeInstanceOf(ScriptedModelRefusedInProductionError);
    // It stays refused on the next request: nothing is cached.
    await expect(getDemoSessionService()).rejects.toBeInstanceOf(ScriptedModelRefusedInProductionError);
  });
});
