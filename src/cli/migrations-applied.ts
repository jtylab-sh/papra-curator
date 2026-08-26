/**
 * Exit 0 when the state DB already has every migration applied, 1 otherwise.
 *
 * The entrypoint uses this to skip `prisma migrate deploy` on ordinary starts:
 * the deploy's schema engine opens the DB without a busy timeout, so it dies
 * with "database is locked" whenever another container (--serve) holds the
 * file. A plain read-only check coexists with WAL writers just fine.
 */

import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { env } from "#~/config/env.ts";

const wanted = readdirSync(new URL("../../prisma/migrations/", import.meta.url)).filter((name) =>
  /^\d/.test(name),
);

let applied: Set<string>;
try {
  const db = new DatabaseSync(env.databaseUrl.replace(/^file:/, ""), { readOnly: true });
  try {
    const rows = db
      .prepare("select migration_name from _prisma_migrations where finished_at is not null")
      .all() as { migration_name: string }[];
    applied = new Set(rows.map((row) => row.migration_name));
  } finally {
    db.close();
  }
} catch {
  // Missing file, missing table, unreadable: let `prisma migrate deploy` decide.
  process.exit(1);
}

process.exit(wanted.every((name) => applied.has(name)) ? 0 : 1);
