import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@/server/model-client";
import { queuedNotes } from "./queued-notes";

/** A request as the runner builds it: each Customer turn is the text, then one system message (time note, then queued notes). */
function request(...turns: Array<{ customer: string; systemMessage: string }>): ModelRequest {
  const messages = turns.flatMap((t) => [
    { role: "user", content: t.customer },
    { role: "system", content: t.systemMessage },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  return { max_tokens: 1, messages } as unknown as ModelRequest;
}

const TIME = "Current time: Wednesday 18 November 2026, 11:30 (Europe/London).";

describe("queuedNotes", () => {
  it("is empty when the turn carries only the time note", () => {
    expect(queuedNotes(request({ customer: "hi", systemMessage: TIME }))).toEqual([]);
  });

  it("returns each queued note of the last Customer turn, in order, without the time note", () => {
    const r = request(
      { customer: "one", systemMessage: `${TIME}\nold note` },
      { customer: "two", systemMessage: `${TIME}\nnote a\nnote b` },
    );
    expect(queuedNotes(r)).toEqual(["note a", "note b"]);
  });

  it("with scope 'all-turns' returns the notes of every turn in the history", () => {
    const r = request(
      { customer: "one", systemMessage: `${TIME}\nold note` },
      { customer: "two", systemMessage: TIME },
      { customer: "three", systemMessage: `${TIME}\nnote a` },
    );
    expect(queuedNotes(r, "all-turns")).toEqual(["old note", "note a"]);
  });
});
