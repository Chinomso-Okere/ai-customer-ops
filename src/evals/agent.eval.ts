/**
 * The eval suite: every scenario in `scenarios.ts` against the REAL model
 * (Claude Sonnet 5.5). It costs money, so it is not part of `npm test`; run it
 * with `npm run eval` (see README "Eval suite").
 */
import { afterAll, describe, expect, it } from "vitest";
import { AnthropicModelClient } from "@/server/model-client";
import { MeteredModelClient, formatReport, requireApiKey, runScenario, type ScenarioResult } from "./scenario";
import { SCENARIOS } from "./scenarios";

requireApiKey(process.env);

const model = new MeteredModelClient(new AnthropicModelClient());
const results: ScenarioResult[] = [];

describe.concurrent("Agent eval (real model)", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const result = await runScenario(scenario, { modelClient: model });
      results.push(result);
      const failed = result.facts.filter((f) => !f.ok);
      expect(
        failed,
        `tool calls: ${result.toolCalls.join(" -> ") || "(none)"}\n` +
          failed.map((f) => `x ${f.fact}${f.observed ? `\n  observed: ${f.observed}` : ""}`).join("\n"),
      ).toEqual([]);
    });
  }
});

afterAll(() => {
  const order = new Map(SCENARIOS.map((s, i) => [s.id, i]));
  results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  process.stdout.write(`${formatReport(results, model)}\n`);
});
