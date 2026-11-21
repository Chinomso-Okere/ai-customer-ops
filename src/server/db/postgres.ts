import pg from "pg";
import type { Database } from "./database";
import { migrate } from "./migrations";

type Queryable = pg.Pool | pg.PoolClient;

function wrap(conn: Queryable, pool: pg.Pool): Database {
  return {
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      const result = await conn.query(sql, [...params]);
      return { rows: result.rows as Row[] };
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      if (conn !== pool) return fn(wrap(conn, pool)); // already in a transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client, pool));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Postgres over `pg` (Neon in production), migrated on first use. */
export async function createPostgresDatabase(connectionString: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const db = wrap(pool, pool);
  await migrate(db);
  return db;
}
