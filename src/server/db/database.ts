/**
 * The minimal Postgres surface the app depends on. Two adapters implement it:
 * PGlite (in-process; tests and local dev) and `pg` (Neon in production).
 *
 * Every domain table carries a `session_id`, and every query must be scoped by
 * it (ADR-0001).
 */
export interface Database {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
  /** Runs one or more statements without parameters (e.g. migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction; commits on resolve, rolls back on throw. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
