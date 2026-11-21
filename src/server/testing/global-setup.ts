import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dumpMigratedPGliteDataDir } from "@/server/db/pglite";
import { MIGRATED_PGDATA_ENV } from "./migrated-snapshot";

/**
 * Vitest globalSetup (vitest.config.ts): boots PGlite and runs every migration
 * once, before any test file starts, and leaves the data directory in a temp
 * file. Each test file then loads that snapshot instead of migrating from
 * scratch inside its first test's timeout. Workers are forked after this runs,
 * so they inherit the environment variable.
 */
export default async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "apex-pgdata-"));
  const file = path.join(dir, "migrated.tar");
  const dump = await dumpMigratedPGliteDataDir();
  await writeFile(file, Buffer.from(await dump.arrayBuffer()));
  process.env[MIGRATED_PGDATA_ENV] = file;
  return async () => {
    await rm(dir, { recursive: true, force: true });
  };
}
