import type { Database } from "./database";

/**
 * The one per-Demo-Session write lock: a row lock on the session's
 * `demo_session` row, held until the transaction ends. Every write that must be
 * serialised within a session (scheduling a Visit, numbering a Handoff Ticket)
 * takes this same lock, so nested writes (e.g. a late reschedule that raises a
 * ticket) re-enter it instead of taking a second lock in another order. Call
 * inside a transaction.
 */
export async function lockDemoSession(tx: Database, sessionId: string): Promise<void> {
  await tx.query("SELECT 1 FROM demo_session WHERE id = $1 FOR UPDATE", [sessionId]);
}
