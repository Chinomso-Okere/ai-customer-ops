import { describe, expect, it } from "vitest";
import { sharedTestDatabase } from "@/server/testing/harness";
import type { Database } from "./database";
import { migrations } from "./migrations";

/**
 * Schema invariants that used to be enforced only through merger prompts.
 *
 * 1. Migration ids are unique and strictly increasing (they collided twice
 *    during spec #1: 0005 for #4 and #5, 0008 for #13 and #14).
 * 2. Every table except `demo_session` is scoped to a Demo Session: it has a
 *    `session_id` column with a foreign key to `demo_session(id) ON DELETE
 *    CASCADE` (ADR-0001). Expired-session cleanup depends on this.
 */

/** Tables that are deliberately not session-scoped. */
const NOT_SESSION_SCOPED = new Set([
  "demo_session", // the root every other table cascades from
  "schema_migration", // migration bookkeeping, written by `migrate`
]);

function migrationNumber(id: string): number | undefined {
  const match = /^(\d+)_/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/** One message per problem; empty when the ids are unique and strictly increasing. */
function migrationIdProblems(ids: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let previous: { id: string; n: number } | undefined;
  for (const id of ids) {
    if (seen.has(id)) {
      problems.push(`migration id "${id}" is duplicated`);
      continue;
    }
    seen.add(id);
    const n = migrationNumber(id);
    if (n === undefined) {
      problems.push(`migration id "${id}" does not start with a number and underscore (e.g. 0010_name)`);
      continue;
    }
    if (previous && n === previous.n) {
      problems.push(`migration "${id}" has the same number as "${previous.id}"`);
    } else if (previous && n < previous.n) {
      problems.push(`migration "${id}" is out of order: it comes after "${previous.id}"`);
    }
    previous = { id, n };
  }
  return problems;
}

/** One message per table in the public schema that breaks the session-scoping rule. */
async function sessionScopeProblems(db: Database): Promise<string[]> {
  const { rows } = await db.query<{
    table_name: string;
    has_session_id: boolean;
    has_cascading_fk: boolean;
  }>(`
    SELECT
      c.relname AS table_name,
      EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'session_id'
          AND a.attnum > 0 AND NOT a.attisdropped
      ) AS has_session_id,
      EXISTS (
        SELECT 1
        FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
        WHERE k.conrelid = c.oid
          AND k.contype = 'f'
          AND array_length(k.conkey, 1) = 1
          AND a.attname = 'session_id'
          AND k.confrelid = 'public.demo_session'::regclass
          AND k.confdeltype = 'c'
      ) AS has_cascading_fk
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `);
  const problems: string[] = [];
  for (const row of rows) {
    if (NOT_SESSION_SCOPED.has(row.table_name)) continue;
    if (!row.has_session_id) {
      problems.push(`table "${row.table_name}" has no session_id column`);
    } else if (!row.has_cascading_fk) {
      problems.push(
        `table "${row.table_name}" has no foreign key from session_id to demo_session(id) ON DELETE CASCADE`,
      );
    }
  }
  return problems;
}

/** Runs `sql` in a transaction, collects the problems, then rolls it back. */
async function sessionScopeProblemsWith(db: Database, sql: string): Promise<string[]> {
  const rollback = new Error("rollback");
  let problems: string[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      problems = await sessionScopeProblems(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return problems;
}

describe("migration ids", () => {
  it("are unique and strictly increasing", () => {
    expect(migrationIdProblems(migrations.map((m) => m.id))).toEqual([]);
  });

  it("flag a duplicated id", () => {
    expect(migrationIdProblems(["0001_a", "0002_b", "0002_b"])).toEqual([
      'migration id "0002_b" is duplicated',
    ]);
  });

  it("flag two migrations that share a number", () => {
    expect(migrationIdProblems(["0004_a", "0005_t4_x", "0005_t5_y"])).toEqual([
      'migration "0005_t5_y" has the same number as "0005_t4_x"',
    ]);
  });

  it("flag an id that is out of order", () => {
    expect(migrationIdProblems(["0001_a", "0003_c", "0002_b"])).toEqual([
      'migration "0002_b" is out of order: it comes after "0003_c"',
    ]);
  });
});

describe("session scoping (ADR-0001)", () => {
  it("every table except demo_session has a session_id with a cascading foreign key", async () => {
    const db = await sharedTestDatabase();
    expect(await sessionScopeProblems(db)).toEqual([]);
  });

  it("flags a table with no session_id column", async () => {
    const db = await sharedTestDatabase();
    const problems = await sessionScopeProblemsWith(
      db,
      "CREATE TABLE throwaway_no_session (id uuid PRIMARY KEY)",
    );
    expect(problems).toEqual(['table "throwaway_no_session" has no session_id column']);
  });

  it("flags a session_id with no foreign key", async () => {
    const db = await sharedTestDatabase();
    const problems = await sessionScopeProblemsWith(
      db,
      "CREATE TABLE throwaway_no_fk (id uuid PRIMARY KEY, session_id uuid NOT NULL)",
    );
    expect(problems).toEqual([
      'table "throwaway_no_fk" has no foreign key from session_id to demo_session(id) ON DELETE CASCADE',
    ]);
  });

  it("flags a session_id foreign key that does not cascade", async () => {
    const db = await sharedTestDatabase();
    const problems = await sessionScopeProblemsWith(
      db,
      "CREATE TABLE throwaway_no_cascade (id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES demo_session(id))",
    );
    expect(problems).toEqual([
      'table "throwaway_no_cascade" has no foreign key from session_id to demo_session(id) ON DELETE CASCADE',
    ]);
  });

  it("leaves no throwaway tables behind", async () => {
    const db = await sharedTestDatabase();
    expect(await sessionScopeProblems(db)).toEqual([]);
  });
});
