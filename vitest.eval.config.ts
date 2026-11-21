import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The real-model eval suite (`npm run eval`). Separate from vitest.config.ts,
 * whose `src/**\/*.test.ts` pattern never picks up `*.eval.ts` files, so
 * `npm test` never calls the paid API.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file); // never overrides variables already set in the shell
  } catch {
    // no such file
  }
}
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error(
    "\nnpm run eval calls the real Claude API and needs ANTHROPIC_API_KEY.\n" +
      "Set it in your shell or in .env.local and run it again. A full run costs roughly $1-2.\n",
  );
  process.exit(1);
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/evals/**/*.eval.ts"],
    environment: "node",
    // A scenario is several real model round trips per Customer turn.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Scenarios share one in-process database but run in separate Demo Sessions.
    maxConcurrency: 4,
    fileParallelism: false,
  },
});
