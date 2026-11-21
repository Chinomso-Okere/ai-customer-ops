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

/**
 * A migrated, in-memory Postgres. Used by tests and local dev. `loadDataDir`
 * starts from a dumped data directory (tests boot from one migrated snapshot);
 * migrations still run, and are a no-op when the snapshot is up to date.
 */
export async function createPGliteDatabase(
  options: { loadDataDir?: Blob } = {},
): Promise<Database> {
  const pg = await PGlite.create(
    options.loadDataDir ? { loadDataDir: options.loadDataDir } : undefined,
  );
  const db = wrap(pg, pg);
  await migrate(db);
  return db;
}

/** Boots PGlite, runs every migration, and returns the data directory as a tarball. */
export async function dumpMigratedPGliteDataDir(): Promise<Blob> {
  const pg = await PGlite.create();
  await migrate(wrap(pg, pg));
  const dump = await pg.dumpDataDir("none");
  await pg.close();
  return dump;
}
