import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Migrate PGlite once; each test file boots from that snapshot.
    globalSetup: ["src/server/testing/global-setup.ts"],
    // Every test file holds its own in-process Postgres (PGlite, hundreds of
    // MB of wasm). Unbounded workers on a many-core machine run out of memory
    // or starve each other past the timeout, so cap them.
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
