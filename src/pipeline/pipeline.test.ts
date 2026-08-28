import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { State, createSchema } from "#~/state/index.ts";
import { applyPendingRenames, processDocument } from "#~/pipeline/index.ts";
import type { Config } from "#~/config/index.ts";
import { FakePorts, catalogueAnswer, config, document, segment } from "#~/testing/helpers.ts";

describe("pipeline", () => {
  let state: State;
  let ports: FakePorts;

  beforeEach(async () => {
    state = await State.open("file::memory:");
    await createSchema(state);
    ports = new FakePorts();
  });

  const run = (cfg: Config, doc = document(), options = {}) =>
    processDocument(cfg, state, ports, doc.id, doc, options);

  it("touches nothing at all while [model] spend is false", async () => {
    await run(
      config((draft) => {
        draft.model.spend = false;
      }),
    );
    assert.deepEqual(ports.modelCalls, [], "spend = false must mean no model call");
    assert.deepEqual(ports.appliedTags, []);
    assert.equal(
      await state.stageRow("doc1", "tagging"),
      null,
      "no attempt may be recorded, or documents park before they are ever tried",
    );
  });

  it("notifies tagging and renaming when their switches are on", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(
      config((draft) => {
        draft.flights.enabled = false;
      }),
    );
    assert.deepEqual(
      ports.notifications.map((n) => n.title),
      ["Tagged scan_001.pdf", "Renamed"],
    );
  });

  it("sends nothing when every notification switch is off", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.answers["flights"] = { flights: [segment()] };
    await run(
      config((draft) => {
        draft.notify.onTagged = false;
        draft.notify.onRenamed = false;
        draft.notify.onFlights = false;
        draft.notify.onError = false;
      }),
    );
    assert.equal(ports.savedFlights.length, 1, "the work itself must still happen");
    assert.deepEqual(ports.notifications, []);
  });

  it("notifies a failed stage with high priority when on_error is set", async () => {
    ports.failOn["catalogue"] = "429 rate limited";
    await run(config());
    assert.deepEqual(ports.notifications, [{ title: "papra-curator error", priority: "high" }]);
  });

  it("costs exactly one model call for a non-travel document", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config());
    assert.deepEqual(ports.modelCalls, ["catalogue"], "the flights gate must hold");
    assert.deepEqual(ports.appliedTags, ["t-banca"]);
    assert.equal(ports.savedFlights.length, 0);
  });

  it("tells the model today's date, in both prompts", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.answers["flights"] = { flights: [] };
    await run(config());
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(ports.systemPrompts[0].includes(today), "catalogue prompt must state today");
    assert.ok(ports.systemPrompts[1].includes(today), "flights prompt must state today");
  });

  it("makes the second call only for a travel document", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.answers["flights"] = { flights: [segment()] };
    await run(config());
    assert.deepEqual(ports.modelCalls, ["catalogue", "flights"]);
    assert.equal(ports.savedFlights.length, 1);
  });

  it("never pushes a flight the owner did not fly", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.answers["flights"] = {
      flights: [segment({ ownerIsAboard: false, guests: ["Someone Else"] })],
    };
    await run(config());
    assert.equal(ports.savedFlights.length, 0, "a family booking must never be filed");
  });

  it("drops a tag outside the vocabulary instead of creating it", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi", "Real Estate Price: EUR 295,000"]);
    ports.answers["flights"] = { flights: [] };
    await run(config());
    assert.deepEqual(ports.appliedTags, ["t-viaggi"]);
    assert.deepEqual(ports.createdTags, [], "allow_new_tags is false");
  });

  it("creates a new tag only when allow_new_tags is on", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["nuovo"]);
    await run(
      config((draft) => {
        draft.tagging.allowNewTags = true;
        draft.flights.enabled = false;
      }),
    );
    assert.deepEqual(ports.createdTags, ["nuovo"]);
  });

  it("changes nothing and persists nothing on a dry run", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.answers["flights"] = { flights: [segment()] };
    await run(config(), document(), { dryRun: true });
    assert.equal(ports.appliedTags.length, 0);
    assert.equal(ports.renames.length, 0);
    assert.equal(ports.savedFlights.length, 0);
    assert.equal(
      await state.stageRow("doc1", "tagging"),
      null,
      "a dry run must not mark work done",
    );
    assert.equal(await state.stageRow("doc1", "renaming"), null);
    assert.deepEqual(ports.notifications, [], "a dry run must not notify");
  });

  it("is a no-op on the second run", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config());
    await run(config());
    assert.deepEqual(ports.modelCalls, ["catalogue"], "already-done work must not be repeated");
  });

  it("reports whether the document needed work, which is what --limit counts", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    assert.equal(await run(config()), true, "a fresh document needs work");
    assert.equal(await run(config()), false, "a settled document must not count");
    assert.equal(
      await run(config(), document({ id: "doc2", content: "  " })),
      false,
      "no content, no work",
    );
  });

  it("reprocesses when the prompt version is bumped", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config());
    await run(
      config((draft) => {
        draft.tagging.promptVersion = "2";
      }),
    );
    assert.deepEqual(ports.modelCalls, ["catalogue", "catalogue"]);
  });

  it("keeps the tags when AirTrail fails", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.failOn["flights"] = "airtrail is down";
    await run(config());
    assert.equal(
      (await state.stageRow("doc1", "tagging"))?.status,
      "done",
      "one failure must not cost the tags",
    );
    assert.equal((await state.stageRow("doc1", "flights"))?.status, "error");
  });

  it("records an error for the catalogue stages when the model fails", async () => {
    ports.failOn["catalogue"] = "429 rate limited";
    await run(config());
    assert.equal((await state.stageRow("doc1", "tagging"))?.status, "error");
    assert.equal((await state.stageRow("doc1", "renaming"))?.status, "error");
    assert.match(String((await state.stageRow("doc1", "tagging"))?.result ?? ""), /^$|null/);
  });

  it("skips a document with no extracted content, recording nothing", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config(), document({ content: "   " }));
    assert.deepEqual(ports.modelCalls, [], "no content means nothing to classify");
    assert.equal(await state.stageRow("doc1", "tagging"), null);
  });

  it("preserves the uploaded filename as a custom property on rename, creating it once", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config(), document({ originalName: "IMG_2043 scan.pdf" }));
    assert.deepEqual(ports.createdProperties, ["Original name"]);
    assert.deepEqual(ports.setProperties, [
      { docId: "doc1", propertyId: "cp-Original name", value: "IMG_2043 scan.pdf" },
    ]);

    // Second document: the definition already exists and is only reused.
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config(), document({ id: "doc2", name: "b.pdf", originalName: "b.pdf" }));
    assert.deepEqual(ports.createdProperties, ["Original name"], "created exactly once");
    assert.equal(ports.setProperties.length, 2);
  });

  it("touches no custom property when original_name_property is empty or nothing renamed", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(
      config((draft) => {
        draft.renaming.originalNameProperty = "";
      }),
    );
    assert.deepEqual(ports.createdProperties, []);
    assert.deepEqual(ports.setProperties, []);
  });

  it("skips the rename call when renaming.dry_run is on but stores the proposal", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"], { party: "Enel", doctype: "bolletta" });
    await run(
      config((draft) => {
        draft.renaming.dryRun = true;
        draft.flights.enabled = false;
      }),
    );
    assert.equal(ports.renames.length, 0);
    const row = await state.stageRow("doc1", "renaming");
    assert.equal(row?.status, "skipped");
    assert.equal((row?.result as any).to, "2024-10-26_enel_bolletta.pdf");
  });

  it("applies stored renames with no model call at all", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"], { party: "Enel", doctype: "bolletta" });
    const cfg = config((draft) => {
      draft.renaming.dryRun = true;
      draft.flights.enabled = false;
    });
    await run(cfg);
    ports.modelCalls.length = 0;
    ports.notifications.length = 0;

    const applied = await applyPendingRenames(cfg, state, ports);
    assert.equal(applied, 1);
    assert.deepEqual(ports.modelCalls, [], "the names were already decided and paid for");
    assert.deepEqual(ports.renames, [{ docId: "doc1", name: "2024-10-26_enel_bolletta.pdf" }]);
    assert.equal((await state.stageRow("doc1", "renaming"))?.status, "done");
    assert.deepEqual(
      ports.notifications.map((n) => n.title),
      ["Renamed"],
      "an applied stored rename notifies like a live one",
    );
    assert.deepEqual(
      await state.pendingRenames(),
      [],
      "an applied rename must not be offered twice",
    );
  });

  it("does not mark a rename done when Papra rejects it", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    const cfg = config((draft) => {
      draft.renaming.dryRun = true;
      draft.flights.enabled = false;
    });
    await run(cfg);
    ports.failOn["rename"] = "409 conflict";
    await applyPendingRenames(cfg, state, ports);
    assert.equal(
      (await state.stageRow("doc1", "renaming"))?.status,
      "skipped",
      "a failed rename stays pending",
    );
  });
});

describe("untagged marker", () => {
  let state: State;
  let ports: FakePorts;

  beforeEach(async () => {
    state = await State.open("file::memory:");
    await createSchema(state);
    ports = new FakePorts();
  });

  const run = (cfg = config(), doc = document(), options = {}) =>
    processDocument(cfg, state, ports, doc.id, doc, options);

  it("marks a document the model could not place", async () => {
    ports.answers["catalogue"] = catalogueAnswer([]);
    await run();
    assert.deepEqual(ports.createdTags, ["untagged"], "created on first use");
    assert.deepEqual(ports.appliedTags, ["t-untagged"]);
    const row = await state.stageRow("doc1", "tagging");
    assert.deepEqual((row?.result as any).tags, ["untagged"]);
  });

  it("reuses the existing untagged tag instead of creating it", async () => {
    ports.tags.push({ id: "t-untagged", name: "untagged", description: "" });
    ports.answers["catalogue"] = catalogueAnswer([]);
    await run();
    assert.deepEqual(ports.createdTags, []);
    assert.deepEqual(ports.appliedTags, ["t-untagged"]);
  });

  it("never offers untagged to the model", async () => {
    ports.tags.push({ id: "t-untagged", name: "untagged", description: "" });
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run();
    assert.equal(ports.systemPrompts.length, 1);
    assert.ok(!ports.systemPrompts[0].includes("untagged"), "must not appear in the vocabulary");
  });

  it("leaves a hand-tagged document alone when the model finds nothing", async () => {
    ports.existingDocumentTags = ["cheatsheet"];
    ports.answers["catalogue"] = catalogueAnswer([]);
    await run();
    assert.deepEqual(ports.appliedTags, [], "already tagged by hand is not untagged");
  });

  it("does not mark when the model found tags", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run();
    assert.deepEqual(ports.appliedTags, ["t-banca"]);
    assert.deepEqual(ports.createdTags, []);
  });

  it("writes nothing at all on a dry run", async () => {
    ports.answers["catalogue"] = catalogueAnswer([]);
    await run(config(), document(), { dryRun: true });
    assert.deepEqual(ports.appliedTags, []);
    assert.deepEqual(ports.createdTags, [], "a dry run must not even create the tag");
    assert.equal(await state.stageRow("doc1", "tagging"), null, "dry runs persist nothing");
  });

  it("only logs when the tag cannot be created", async () => {
    ports.createTag = async () => {
      throw new Error("401 from papra: unauthorized");
    };
    ports.answers["catalogue"] = catalogueAnswer([]);
    await run();
    const row = await state.stageRow("doc1", "tagging");
    assert.equal(row?.status, "done", "a missing permission must not park the document");
    assert.deepEqual((row?.result as any).tags, []);
    assert.ok(ports.logs.some((line) => line.includes("could not apply untagged")));
  });
});
