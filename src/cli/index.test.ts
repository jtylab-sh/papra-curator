import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { parseArgs } from "#~/cli/index.ts";

describe("cli", () => {
  it("has no default action", async () => {
    const args = parseArgs([]);
    assert.ok(!args.once && !args.serve && !args.applyRenames && args.doc === null);
  });

  it("parses --limit, the bound on how many documents a run touches", async () => {
    assert.equal(parseArgs(["--once", "--limit", "5"]).limit, 5);
    assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["--limit", "all"]), /positive integer/);
  });
});

describe("migrations-applied check", () => {
  const script = new URL("./migrations-applied.ts", import.meta.url).pathname;
  const check = (dbPath: string) =>
    spawnSync(process.execPath, [script], {
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    }).status;

  it("reports not-applied for a missing DB and applied for a migrated one", async () => {
    const path = join(tmpdir(), `curator-migcheck-${process.pid}-${Date.now()}.db`);
    try {
      assert.equal(check(path), 1, "a missing DB must run migrate deploy");

      // A DB whose Prisma ledger lists every shipped migration as finished.
      const migrations = readdirSync(new URL("../../prisma/migrations/", import.meta.url)).filter(
        (name) => /^\d/.test(name),
      );
      const db = new DatabaseSync(path);
      db.exec("create table _prisma_migrations (migration_name text, finished_at datetime)");
      const insert = db.prepare("insert into _prisma_migrations values (?, datetime('now'))");
      for (const name of migrations) insert.run(name);
      db.close();
      assert.equal(check(path), 0, "a fully migrated DB must skip migrate deploy");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
