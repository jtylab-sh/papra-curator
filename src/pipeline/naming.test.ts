import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { catalogueSchema } from "#~/pipeline/catalogue.ts";
import { composeName, slugify, splitExtension } from "#~/pipeline/naming.ts";
import { config } from "#~/test-helpers.ts";

describe("filenames", () => {
  const cfg = config();

  it("composes from fields", async () => {
    assert.equal(
      composeName(
        cfg,
        { date: "2024-10-26", party: "Air China", doctype: "carta imbarco", detail: "MXP-TFU" },
        ".pdf",
      ),
      "2024-10-26_air-china_carta-imbarco_mxp-tfu.pdf",
    );
  });

  it("leaves no dangling separator when a field is empty", async () => {
    assert.equal(
      composeName(
        cfg,
        { date: "2024-10-26", party: "Enel", doctype: "bolletta", detail: "" },
        ".pdf",
      ),
      "2024-10-26_enel_bolletta.pdf",
    );
  });

  it("cannot be made to produce a path or a traversal", async () => {
    const evil = composeName(
      cfg,
      { date: "../../etc", party: "a/b\\c", doctype: "x", detail: "" },
      ".pdf",
    );
    assert.ok(
      evil && !evil.includes("/") && !evil.includes("\\") && !evil.includes(".."),
      evil ?? "null",
    );
  });

  it("returns null when every field is empty rather than a bare extension", async () => {
    assert.equal(composeName(cfg, { date: "", party: "", doctype: "", detail: "" }, ".pdf"), null);
  });

  it("truncates without leaving a trailing separator", async () => {
    const tight = config((draft) => {
      draft.renaming.maxLength = 20;
    });
    const short = composeName(
      tight,
      { date: "2024-10-26", party: "Air China", doctype: "carta imbarco", detail: "" },
      ".pdf",
    );
    assert.ok(
      short && short.length <= 24 && !/[_-]$/.test(short.replace(".pdf", "")),
      short ?? "null",
    );
  });

  it("slugifies accents and punctuation", async () => {
    assert.equal(slugify("Enel Energia S.p.A."), "enel-energia-s-p-a");
    assert.equal(slugify("Città  di  Milano"), "citta-di-milano");
  });

  it("finds the extension, or reports none", async () => {
    assert.equal(splitExtension("Scan_2024.PDF"), ".PDF");
    assert.equal(splitExtension("noext"), "");
  });
});

describe("tag schema", () => {
  it("pins the vocabulary as an enum when new tags are not allowed", async () => {
    const schema = catalogueSchema(["a", "b"], false) as any;
    assert.deepEqual(schema.properties.tags.items.enum, ["a", "b"]);
  });

  it("leaves tags open when new ones are allowed", async () => {
    const schema = catalogueSchema(["a"], true) as any;
    assert.equal(schema.properties.tags.items.enum, undefined);
  });
});
