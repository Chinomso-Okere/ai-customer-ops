import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database } from "./database";
import { migrate } from "./migrations";

type PGliteLike = Pick<PGlite, "query" | "exec"> | Transaction;

function wrap(conn: PGliteLike, root: PGlite): Database {
  return {
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      const result = await conn.query<Row>(sql, [...params]);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await conn.exec(sql);
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      if (conn !== root) {
        // Already inside a transaction: PGlite has no nested transactions.
        return fn(wrap(conn, root));
      }
      return root.transaction((tx) => fn(wrap(tx, root)));
    },
  };
}

/** A fresh, migrated, in-memory Postgres. Used by tests and local dev. */
export async function createPGliteDatabase(): Promise<Database> {
  const pg = await PGlite.create();
  const db = wrap(pg, pg);
  await migrate(db);
  return db;
}
