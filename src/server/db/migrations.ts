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

      CREATE TABLE customer (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id    uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        full_name     text NOT NULL,
        postcode      text NOT NULL,
        email         text NOT NULL,
        phone         text,
        demo_friendly boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL
      );
      CREATE INDEX customer_session_idx ON customer (session_id);

      CREATE TABLE job (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id    uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        job_reference text NOT NULL,
        customer_id   uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
        issue_type    text NOT NULL,
        description   text NOT NULL,
        job_status    text NOT NULL,
        created_at    timestamptz NOT NULL,
        UNIQUE (session_id, job_reference)
      );

      CREATE TABLE visit (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id         uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        job_id             uuid NOT NULL REFERENCES job(id) ON DELETE CASCADE,
        engineer_id        uuid NOT NULL REFERENCES engineer(id) ON DELETE CASCADE,
        visit_date         date NOT NULL,
        time_window        text NOT NULL CHECK (time_window IN ('AM', 'PM')),
        is_emergency_visit boolean NOT NULL DEFAULT false
      );
      CREATE INDEX visit_session_idx ON visit (session_id, visit_date);
      -- An Engineer attends one Visit per Time Window; only an Emergency Visit
      -- may override a full calendar.
      CREATE UNIQUE INDEX visit_engineer_window_uniq
        ON visit (session_id, engineer_id, visit_date, time_window)
        WHERE NOT is_emergency_visit;

      CREATE TABLE parts_order (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id       uuid NOT NULL REFERENCES demo_session(id) ON DELETE CASCADE,
        job_id           uuid NOT NULL REFERENCES job(id) ON DELETE CASCADE,
        part_name        text NOT NULL,
        parts_status     text NOT NULL,
        expected_arrival date NOT NULL,
        created_at       timestamptz NOT NULL
      );
      CREATE INDEX parts_order_session_idx ON parts_order (session_id);
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
