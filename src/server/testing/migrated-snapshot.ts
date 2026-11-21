import { readFile } from "node:fs/promises";

/** Path of the migrated PGlite data directory dumped by global-setup.ts. */
export const MIGRATED_PGDATA_ENV = "APEX_TEST_MIGRATED_PGDATA";

/** The migrated snapshot, or undefined when no globalSetup made one (e.g. `npm run eval`). */
export async function loadMigratedSnapshot(): Promise<Blob | undefined> {
  const file = process.env[MIGRATED_PGDATA_ENV];
  if (!file) return undefined;
  return new Blob([await readFile(file)]);
}
