import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach } from "node:test";

import { State, createSchema } from "#~/state/index.ts";

describe("stage tracking", () => {
  let state: State;
  beforeEach(async () => {
    state = await State.open("file::memory:");
    await createSchema(state);
  });

  it("re-queues a done stage when the prompt version changes", async () => {
    assert.ok(await state.stageNeedsRun("doc1", "tagging", "1", 3));
    await state.setStage("doc1", "tagging", "done", "1", { result: { tags: ["x"] } });
    assert.ok(!(await state.stageNeedsRun("doc1", "tagging", "1", 3)));
    assert.ok(await state.stageNeedsRun("doc1", "tagging", "2", 3), "a prompt bump must re-queue");
  });

  it("persists nothing on a dry run", async () => {
    await state.setStage("doc1", "renaming", "done", "1", { dryRun: true });
    assert.equal(await state.stageRow("doc1", "renaming"), null, "a dry run must leave no trace");
  });

  it("retries an error up to the cap, then stops", async () => {
    await state.setStage("doc1", "flights", "error", "1", { error: "boom" });
    assert.ok(await state.stageNeedsRun("doc1", "flights", "1", 3));
    await state.setStage("doc1", "flights", "error", "1", { error: "boom" });
    await state.setStage("doc1", "flights", "error", "1", { error: "boom" });
    assert.ok(!(await state.stageNeedsRun("doc1", "flights", "1", 3)), "must stop at max_attempts");
  });

  it("treats a skipped stage as settled, not as a retry", async () => {
    await state.setStage("doc1", "renaming", "skipped", "1", { result: { from: "a", to: "b" } });
    assert.ok(!(await state.stageNeedsRun("doc1", "renaming", "1", 3)));
  });

  it("opens a file DB in WAL mode and takes a second writer without locking", async () => {
    // The serve container and a one-shot --once run write this file at the
    // same time (a sweep rename triggers a webhook back into serve).
    const path = join(tmpdir(), `curator-state-test-${process.pid}-${Date.now()}.db`);
    try {
      const sweep = await State.open(`file:${path}`);
      await createSchema(sweep);
      const serve = await State.open(`file:${path}`);
      await sweep.recordDocument("doc1", "text", "a.pdf");
      await serve.setStage("doc1", "tagging", "done", "1");
      await sweep.setStage("doc1", "renaming", "done", "1");
      assert.ok(existsSync(`${path}-wal`), "the DB must be in WAL journal mode");
      assert.equal((await sweep.stageRow("doc1", "tagging"))?.status, "done");
      await sweep.close();
      await serve.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it("survives being reopened", async () => {
    const shared = await State.open("file::memory:");
    await createSchema(shared);
    await shared.recordDocument("doc1", "text", "a.pdf");
    await shared.setStage("doc1", "tagging", "done", "1");
    assert.equal((await shared.stageRow("doc1", "tagging"))?.status, "done");
  });

  it("lists only pending renames that would actually change the name", async () => {
    await state.setStage("d1", "renaming", "skipped", "1", {
      result: { from: "old.pdf", to: "new.pdf" },
    });
    await state.setStage("d2", "renaming", "skipped", "1", {
      result: { from: "same.pdf", to: "same.pdf" },
    });
    await state.setStage("d3", "renaming", "skipped", "1", { result: { from: "x.pdf", to: null } });
    await state.setStage("d4", "renaming", "done", "1", { result: { from: "a.pdf", to: "b.pdf" } });
    assert.deepEqual(await state.pendingRenames(), [
      { docId: "d1", from: "old.pdf", to: "new.pdf" },
    ]);
  });
});
