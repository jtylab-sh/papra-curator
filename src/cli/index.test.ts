import assert from "node:assert/strict";
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
