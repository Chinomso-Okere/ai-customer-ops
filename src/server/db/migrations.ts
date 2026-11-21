import type { Database } from "./database";

/**
 * Ordered, append-only schema migrations. Never edit a migration that has been
 * deployed; add a new entry instead.
 */
export const migrations: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "0001_demo_session",
    sql: `
      CREATE TABLE demo_session (
        id          uuid PRIMARY KEY,
        created_at  timestamptz NOT NULL,
        expires_at  timestamptz NOT NULL
      );

      CREATE TABLE engineer (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        name        text NOT NULL,
        skills      text[] NOT NULL,
        sort_order  int NOT NULL
      );
      CREATE INDEX engineer_session_idx ON engineer (session_id);
    `,
  },
];

// Arbitrary constant key so concurrent cold starts don't migrate twice.
const MIGRATION_LOCK_KEY = 4_177_301;

export async function migrate(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id          text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM schema_migration");
    const applied = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_migration (id) VALUES ($1)", [m.id]);
    }
  });
}
