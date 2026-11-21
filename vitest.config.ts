import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Each test boots its own in-process Postgres (PGlite); give it room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
