import type { ModelRequest } from "@/server/model-client";

/**
 * The runner (`agent/runner.ts`) puts one system message after each Customer
 * message: the current-time note, then every queued note, joined with "\n".
 * This helper owns that format so tests never parse it themselves.
 *
 * Returns the queued notes (never the time note) in delivery order: those of
 * the request's last Customer turn, or of every turn with `"all-turns"`.
 * Queued notes are single lines. Assert on how many there are, or on a
 * structured fact in them such as a ticket reference, not on their wording.
 */
export function queuedNotes(request: ModelRequest, scope: "last-turn" | "all-turns" = "last-turn"): string[] {
  const { messages } = request;
  const from = scope === "all-turns" ? 0 : messages.findLastIndex((m) => m.role === "user" && typeof m.content === "string") + 1;
  return messages
    .slice(from)
    .filter((m) => (m.role as string) === "system")
    .flatMap((m) => String(m.content).split("\n").slice(1));
}
