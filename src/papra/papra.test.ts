/**
 * Regression test for "database is locked": Papra commits in
 * journal_mode=delete take an exclusive lock, and a reader without a busy
 * timeout dies with SQLITE_BUSY the moment they overlap. `openReadOnly` must
 * wait the lock out instead.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openReadOnly } from "#~/papra/index.ts";

describe("openReadOnly", () => {
  it("waits out a writer's exclusive lock instead of throwing SQLITE_BUSY", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "papra-test-")), "db.sqlite");
    const setup = new DatabaseSync(dbPath);
    setup.exec("pragma journal_mode=delete; create table t (id integer); insert into t values (1)");
    setup.close();

    // A separate process holds an exclusive lock for ~300ms, like Papra
    // mid-commit. Same-process connections cannot contend, hence the spawn.
    const writer = spawn(process.execPath, [
      "-e",
      `const {DatabaseSync}=require("node:sqlite");
       const db=new DatabaseSync(${JSON.stringify(dbPath)});
       db.exec("begin exclusive; insert into t values (2)");
       console.log("locked");
       setTimeout(()=>{db.exec("commit");db.close();},300);`,
    ]);
    await new Promise<void>((resolve, reject) => {
      writer.stdout.once("data", () => resolve());
      writer.once("error", reject);
      writer.once("exit", (code) => reject(new Error(`writer exited early (${code})`)));
    });

    const reader = openReadOnly(dbPath);
    try {
      // Throws "database is locked" here if openReadOnly loses its timeout.
      const row = reader.prepare("select count(*) as n from t").get() as { n: number };
      assert.equal(row.n, 2);
    } finally {
      reader.close();
      writer.kill();
    }
  });
});
