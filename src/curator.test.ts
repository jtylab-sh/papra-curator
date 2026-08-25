/**
 * Tests for papra-curator. `node --test src/`
 *
 * Weighted toward the invariants whose failure costs money or data, not toward
 * coverage:
 *
 *   - a document the owner did not fly must never reach AirTrail
 *   - a non-travel document must never cost a second model call
 *   - a dry run must change nothing and persist nothing
 *   - an unsigned webhook must be rejected
 *   - a model must not be able to invent tags, or emit a filename that is a path
 *   - a sweep must never start on its own
 *
 * Nothing here touches the network, Papra, or a real config: the Ports
 * interface is faked, and the state DB is in-memory.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, beforeEach } from "node:test";

import { parseToml } from "./toml.ts";
import { parseConfig, type Config } from "./config.ts";
import { State } from "./state.ts";
import { composeName, slugify, splitExtension } from "./naming.ts";
import { catalogueSchema } from "./catalogue.ts";
import {
  checkFlight, icaoFor, keyOf, nearDuplicate, normFlightNumber, toAirtrail, type Segment,
} from "./flights.ts";
import { verifySignature, documentIdFrom } from "./server.ts";
import { applyPendingRenames, processDocument } from "./pipeline.ts";
import { createPorts, SpendBlockedError, type AirtrailFlight, type Ports } from "./ports.ts";
import type { Document, Tag } from "./papra.ts";
import { parseArgs } from "./main.ts";

// --------------------------------------------------------------------------- //
// fixtures
// --------------------------------------------------------------------------- //

const CONFIG_TOML = `
[papra]
db_path = "/papra-db/db.sqlite"
api_url = "http://papra:1221"
organization_id = "org_test"
content_limit = 30000

[trigger]
listen_host = "0.0.0.0"
listen_port = 8099
reconcile_interval_seconds = 0
content_settle_seconds = 20

[model]
name = "mistral-medium-latest"
spend = true
temperature = 0.0
max_attempts = 3
retry_backoff_seconds = 20

[tagging]
enabled = true
prompt_version = "1"
max_tags = 8
allow_new_tags = false

[renaming]
enabled = true
prompt_version = "1"
template = "{date}_{party}_{doctype}_{detail}"
slugify_fields = true
max_length = 120
dry_run = false

[handlers.flights]
enabled = true
prompt_version = "1"
tags = ["viaggi"]
airtrail_url = "https://fly.example.com"
owner_names = ["Test Owner", "OWNER/TEST"]
near_duplicate_days = 2
dry_run = false

[notify]
url = "http://ntfy:80"
topic = "papra-curator"
on_success = true
`;

const OWNER = "u-owner";

function config(overrides: (draft: Config) => void = () => {}): Config {
  const parsed = parseConfig(CONFIG_TOML, {});
  overrides(parsed);
  return parsed;
}

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc1",
    name: "scan_001.pdf",
    originalName: "scan_001.pdf",
    content: "some extracted text",
    notes: "",
    ...overrides,
  };
}

/** A Ports fake that records every outward effect, so tests can assert on cost. */
class FakePorts implements Ports {
  modelCalls: string[] = [];
  appliedTags: string[] = [];
  createdTags: string[] = [];
  renames: { docId: string; name: string }[] = [];
  savedFlights: unknown[] = [];
  notifications: string[] = [];
  logs: string[] = [];

  tags: Tag[] = [
    { id: "t-viaggi", name: "viaggi", description: "travel" },
    { id: "t-banca", name: "banca", description: "banking" },
  ];
  existingDocumentTags: string[] = [];
  existingFlights: AirtrailFlight[] = [];
  answers: Record<string, unknown> = {};
  failOn: Record<string, string> = {};

  async askModel(label: string): Promise<any> {
    this.modelCalls.push(label);
    if (this.failOn[label]) throw new Error(this.failOn[label]);
    return this.answers[label] ?? {};
  }
  listTags(): Tag[] {
    return this.tags;
  }
  documentTags(): string[] {
    return this.existingDocumentTags;
  }
  async applyTag(_docId: string, tagId: string): Promise<void> {
    this.appliedTags.push(tagId);
  }
  async createTag(name: string): Promise<string | null> {
    this.createdTags.push(name);
    return `t-${name}`;
  }
  async renameDocument(docId: string, newName: string): Promise<void> {
    if (this.failOn["rename"]) throw new Error(this.failOn["rename"]);
    this.renames.push({ docId, name: newName });
  }
  async listFlights(): Promise<AirtrailFlight[]> {
    return this.existingFlights;
  }
  async saveFlight(body: unknown): Promise<void> {
    this.savedFlights.push(body);
  }
  async notify(title: string): Promise<void> {
    this.notifications.push(title);
  }
  log(message: string): void {
    this.logs.push(message);
  }
}

function catalogueAnswer(tags: string[], fields: Partial<Record<string, string>> = {}) {
  return {
    tags,
    date: fields.date ?? "2024-10-26",
    party: fields.party ?? "Air China",
    doctype: fields.doctype ?? "carta imbarco",
    detail: fields.detail ?? "",
  };
}

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    from: "mxp",
    to: "otp",
    departure: "2024-07-14",
    departureTime: "11:30",
    flightNumber: "W6 4312",
    guests: [],
    ownerIsAboard: true,
    evidence: "passenger list",
    ...overrides,
  };
}

// --------------------------------------------------------------------------- //

describe("toml", () => {
  it("reads the shapes the config actually uses", () => {
    const parsed = parseToml(`
# comment
[a]
s = "hello"
n = 42
f = 0.5
flag = true
list = ["x", "y"]
multi = [
  "one",   # trailing comment
  "two",
]

[a.sub]
nested = "deep"
`);
    assert.deepEqual(parsed, {
      a: {
        s: "hello",
        n: 42,
        f: 0.5,
        flag: true,
        list: ["x", "y"],
        multi: ["one", "two"],
        sub: { nested: "deep" },
      },
    });
  });

  it("refuses to shadow a scalar with a table of the same name", () => {
    assert.throws(() => parseToml("[a]\nb = true\n[a.b]\nx = 1"), /b is a value, not a table/);
  });

  it("keeps a # that is inside a string", () => {
    assert.deepEqual(parseToml('[a]\nk = "we#ird"'), { a: { k: "we#ird" } });
  });

  it("throws rather than silently skipping a line it cannot parse", () => {
    // The dangerous failure mode: a config parser that ignores what it does not
    // understand can turn dry_run = true into an unset (live) run.
    assert.throws(() => parseToml("[a]\nk = nonsense"), /line 2/);
    assert.throws(() => parseToml("[a]\nthis line has no equals"), /line 2/);
    assert.throws(() => parseToml("[a]\nk = { inline = 1 }"), /inline tables/);
    assert.throws(() => parseToml("[a]\nk = 1\nk = 2"), /duplicate key/);
    assert.throws(() => parseToml("[a]\nk = ["), /unterminated array/);
  });
});

describe("config", () => {
  it("rejects a flights handler that cannot enforce the owner rule", () => {
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace('owner_names = ["Test Owner", "OWNER/TEST"]', "owner_names = []"), {}),
      /owner_names must not be empty/,
    );
  });

  it("rejects an enabled flights handler with no trigger tags", () => {
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace('tags = ["viaggi"]', "tags = []"), {}),
      /tags must not be empty/,
    );
  });

  it("defaults renaming.dry_run to true when the key is absent", () => {
    const parsed = parseConfig(CONFIG_TOML.replace("dry_run = false\n\n[handlers.flights]", "\n[handlers.flights]"), {});
    assert.equal(parsed.renaming.dryRun, true, "an unset dry_run must not mean rename everything");
  });

  it("defaults the flights handler off", () => {
    const parsed = parseConfig(CONFIG_TOML.replace("enabled = true\nprompt_version = \"1\"\ntags", "prompt_version = \"1\"\ntags"), {});
    assert.equal(parsed.flights.enabled, false);
  });

  it("takes identity from the environment so config.toml carries none", () => {
    // config.toml ships with these blank; compose supplies them.
    const blank = CONFIG_TOML
      .replace('organization_id = "org_test"', 'organization_id = ""')
      .replace('airtrail_url = "https://fly.example.com"', 'airtrail_url = ""')
      .replace('owner_names = ["Test Owner", "OWNER/TEST"]', "owner_names = []");
    const parsed = parseConfig(blank, {
      PAPRA_ORGANIZATION_ID: "org_from_env",
      AIRTRAIL_URL: "https://fly.env.example",
      AIRTRAIL_OWNER_NAMES: "Jane Doe|DOE, JANE|DOE/JANE",
    });
    assert.equal(parsed.papra.organizationId, "org_from_env");
    assert.equal(parsed.flights.airtrailUrl, "https://fly.env.example");
    // Split on `|`, never `,` — airlines print "DOE, JANE".
    assert.deepEqual(parsed.flights.ownerNames, ["Jane Doe", "DOE, JANE", "DOE/JANE"]);
  });

  it("lets the environment win over a value in the file", () => {
    const parsed = parseConfig(CONFIG_TOML, { PAPRA_ORGANIZATION_ID: "org_override" });
    assert.equal(parsed.papra.organizationId, "org_override");
  });

  it("ignores an unset or blank variable rather than blanking the file value", () => {
    const parsed = parseConfig(CONFIG_TOML, { PAPRA_ORGANIZATION_ID: "   ", AIRTRAIL_URL: undefined });
    assert.equal(parsed.papra.organizationId, "org_test");
    assert.equal(parsed.flights.airtrailUrl, "https://fly.example.com");
  });

  it("names both places when an identity value is missing everywhere", () => {
    const blank = CONFIG_TOML.replace('organization_id = "org_test"', 'organization_id = ""');
    assert.throws(() => parseConfig(blank, {}), /organization_id is required.*PAPRA_ORGANIZATION_ID/s);
  });

  it("accepts a numeric prompt_version so it cannot silently fail to match", () => {
    const parsed = parseConfig(CONFIG_TOML.replace('[tagging]\nenabled = true\nprompt_version = "1"', "[tagging]\nenabled = true\nprompt_version = 2"), {});
    assert.equal(parsed.tagging.promptVersion, "2");
  });
});

describe("filenames", () => {
  const cfg = config();

  it("composes from fields", () => {
    assert.equal(
      composeName(cfg, { date: "2024-10-26", party: "Air China", doctype: "carta imbarco", detail: "MXP-TFU" }, ".pdf"),
      "2024-10-26_air-china_carta-imbarco_mxp-tfu.pdf",
    );
  });

  it("leaves no dangling separator when a field is empty", () => {
    assert.equal(
      composeName(cfg, { date: "2024-10-26", party: "Enel", doctype: "bolletta", detail: "" }, ".pdf"),
      "2024-10-26_enel_bolletta.pdf",
    );
  });

  it("cannot be made to produce a path or a traversal", () => {
    const evil = composeName(cfg, { date: "../../etc", party: "a/b\\c", doctype: "x", detail: "" }, ".pdf");
    assert.ok(evil && !evil.includes("/") && !evil.includes("\\") && !evil.includes(".."), evil ?? "null");
  });

  it("returns null when every field is empty rather than a bare extension", () => {
    assert.equal(composeName(cfg, { date: "", party: "", doctype: "", detail: "" }, ".pdf"), null);
  });

  it("truncates without leaving a trailing separator", () => {
    const tight = config((draft) => {
      draft.renaming.maxLength = 20;
    });
    const short = composeName(tight, { date: "2024-10-26", party: "Air China", doctype: "carta imbarco", detail: "" }, ".pdf");
    assert.ok(short && short.length <= 24 && !/[_-]$/.test(short.replace(".pdf", "")), short ?? "null");
  });

  it("slugifies accents and punctuation", () => {
    assert.equal(slugify("Enel Energia S.p.A."), "enel-energia-s-p-a");
    assert.equal(slugify("Città  di  Milano"), "citta-di-milano");
  });

  it("finds the extension, or reports none", () => {
    assert.equal(splitExtension("Scan_2024.PDF"), ".PDF");
    assert.equal(splitExtension("noext"), "");
  });
});

describe("tag schema", () => {
  it("pins the vocabulary as an enum when new tags are not allowed", () => {
    const schema = catalogueSchema(["a", "b"], false) as any;
    assert.deepEqual(schema.properties.tags.items.enum, ["a", "b"]);
  });

  it("leaves tags open when new ones are allowed", () => {
    const schema = catalogueSchema(["a"], true) as any;
    assert.equal(schema.properties.tags.items.enum, undefined);
  });
});

describe("webhook signature", () => {
  const secret = "s3cr3t";
  const webhookId = "wbh_1";
  const timestamp = "1700000000";
  const body = '{"event":"document:created"}';
  const good =
    "v1," + createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${body}`).digest("base64");

  it("accepts Papra's scheme", () => {
    assert.ok(verifySignature(secret, webhookId, timestamp, body, good));
  });

  it("rejects a tampered body, a wrong secret, and swapped headers", () => {
    assert.ok(!verifySignature(secret, webhookId, timestamp, body + " ", good));
    assert.ok(!verifySignature("wrong", webhookId, timestamp, body, good));
    assert.ok(!verifySignature(secret, "wbh_2", timestamp, body, good));
    assert.ok(!verifySignature(secret, webhookId, "1700000001", body, good));
  });

  it("rejects an unknown version, garbage, and an empty secret", () => {
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, "v2," + good.split(",")[1]));
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, "garbage"));
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, ""));
    // No secret must never mean "accept anything".
    assert.ok(!verifySignature("", webhookId, timestamp, body, good));
  });

  it("finds the document id in both payload shapes", () => {
    assert.equal(documentIdFrom({ payload: { document: { id: "d1" } } }), "d1");
    assert.equal(documentIdFrom({ payload: { documentId: "d2" } }), "d2");
    assert.equal(documentIdFrom({ payload: {} }), null);
  });
});

describe("stage tracking", () => {
  let state: State;
  beforeEach(() => {
    state = new State(":memory:");
  });

  it("re-queues a done stage when the prompt version changes", () => {
    assert.ok(state.stageNeedsRun("doc1", "tagging", "1", 3));
    state.setStage("doc1", "tagging", "done", "1", { result: { tags: ["x"] } });
    assert.ok(!state.stageNeedsRun("doc1", "tagging", "1", 3));
    assert.ok(state.stageNeedsRun("doc1", "tagging", "2", 3), "a prompt bump must re-queue");
  });

  it("persists nothing on a dry run", () => {
    state.setStage("doc1", "renaming", "done", "1", { dryRun: true });
    assert.equal(state.stageRow("doc1", "renaming"), null, "a dry run must leave no trace");
  });

  it("retries an error up to the cap, then stops", () => {
    state.setStage("doc1", "flights", "error", "1", { error: "boom" });
    assert.ok(state.stageNeedsRun("doc1", "flights", "1", 3));
    state.setStage("doc1", "flights", "error", "1", { error: "boom" });
    state.setStage("doc1", "flights", "error", "1", { error: "boom" });
    assert.ok(!state.stageNeedsRun("doc1", "flights", "1", 3), "must stop at max_attempts");
  });

  it("treats a skipped stage as settled, not as a retry", () => {
    state.setStage("doc1", "renaming", "skipped", "1", { result: { from: "a", to: "b" } });
    assert.ok(!state.stageNeedsRun("doc1", "renaming", "1", 3));
  });

  it("survives being reopened", () => {
    const shared = new State(":memory:");
    shared.recordDocument("doc1", "text", "a.pdf");
    shared.setStage("doc1", "tagging", "done", "1");
    assert.equal(shared.stageRow("doc1", "tagging")?.status, "done");
  });

  it("lists only pending renames that would actually change the name", () => {
    state.setStage("d1", "renaming", "skipped", "1", { result: { from: "old.pdf", to: "new.pdf" } });
    state.setStage("d2", "renaming", "skipped", "1", { result: { from: "same.pdf", to: "same.pdf" } });
    state.setStage("d3", "renaming", "skipped", "1", { result: { from: "x.pdf", to: null } });
    state.setStage("d4", "renaming", "done", "1", { result: { from: "a.pdf", to: "b.pdf" } });
    assert.deepEqual(state.pendingRenames(), [{ docId: "d1", from: "old.pdf", to: "new.pdf" }]);
  });
});

describe("flight conversion", () => {
  it("normalises flight numbers and airlines", () => {
    assert.equal(normFlightNumber("BR 0096"), "BR96");
    assert.equal(icaoFor("W6 4312"), "WZZ");
    assert.equal(icaoFor("CA446"), "CCA");
    assert.equal(icaoFor("ZZ9"), undefined);
    assert.equal(keyOf("2024-07-14T10:00", "mxp", "otp"), "2024-07-14|MXP|OTP");
  });

  it("gives a guest an explicit null userId", () => {
    // AirTrail 400s with invalid_type on an omitted userId key.
    const body = toAirtrail(segment({ guests: ["sara capogreco"] }), OWNER);
    const guest = body.passengers.find((p) => p.guestName)!;
    assert.equal(guest.userId, null);
    assert.equal(guest.guestName, "Sara Capogreco");
    assert.equal(body.airline, "WZZ");
    assert.equal(body.flightNumber, "W64312");
    assert.deepEqual(checkFlight(body, OWNER), []);
  });

  it("rejects a flight the owner is not a passenger on", () => {
    const body = toAirtrail(segment({ guests: ["someone else"] }), OWNER);
    body.passengers = body.passengers.filter((p) => p.guestName); // owner removed
    assert.ok(checkFlight(body, OWNER).length > 0, "owner-absent flight must be rejected");
  });

  it("rejects malformed routes", () => {
    const body = toAirtrail(segment(), OWNER);
    assert.ok(checkFlight({ ...body, from: "Milan" }, OWNER).length > 0);
    assert.ok(checkFlight({ ...body, to: body.from }, OWNER).length > 0);
    assert.ok(checkFlight({ ...body, departure: "26/10/2024" }, OWNER).length > 0);
  });

  it("drops an invalid seat class instead of sending it", () => {
    const body = toAirtrail(segment({ seatClass: "coach" }), OWNER);
    assert.equal(body.passengers[0].seatClass, undefined);
    assert.equal(toAirtrail(segment({ seatClass: "business" }), OWNER).passengers[0].seatClass, "business");
  });

  it("catches a one-day model date slip on the same flight number", () => {
    const logged = [
      { flightNumber: "TK1895", date: "2026-10-31" },
      { flightNumber: "FR4475", date: "2022-06-24" },
    ];
    assert.equal(nearDuplicate({ flightNumber: "TK1895", departure: "2026-10-30" }, logged, 2), "2026-10-31");
    assert.equal(nearDuplicate({ flightNumber: "TK1895", departure: "2026-12-25" }, logged, 2), null);
    assert.equal(nearDuplicate({ flightNumber: "TK197", departure: "2026-10-31" }, logged, 2), null);
    assert.equal(nearDuplicate({ departure: "2026-10-31" }, logged, 2), null);
  });
});

describe("pipeline", () => {
  let state: State;
  let ports: FakePorts;

  beforeEach(() => {
    state = new State(":memory:");
    ports = new FakePorts();
  });

  const run = (cfg: Config, doc = document(), options = {}) =>
    processDocument(cfg, state, ports, doc.id, doc, { ownerUserId: OWNER, ...options });

  it("touches nothing at all while [model] spend is false", async () => {
    await run(config((draft) => { draft.model.spend = false; }));
    assert.deepEqual(ports.modelCalls, [], "spend = false must mean no model call");
    assert.deepEqual(ports.appliedTags, []);
    assert.equal(
      state.stageRow("doc1", "tagging"),
      null,
      "no attempt may be recorded, or documents park before they are ever tried",
    );
  });

  it("costs exactly one model call for a non-travel document", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config());
    assert.deepEqual(ports.modelCalls, ["catalogue"], "the flights gate must hold");
    assert.deepEqual(ports.appliedTags, ["t-banca"]);
    assert.equal(ports.savedFlights.length, 0);
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
    await run(config((draft) => {
      draft.tagging.allowNewTags = true;
      draft.flights.enabled = false;
    }));
    assert.deepEqual(ports.createdTags, ["nuovo"]);
  });

  it("changes nothing and persists nothing on a dry run", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.answers["flights"] = { flights: [segment()] };
    await run(config(), document(), { dryRun: true });
    assert.equal(ports.appliedTags.length, 0);
    assert.equal(ports.renames.length, 0);
    assert.equal(ports.savedFlights.length, 0);
    assert.equal(state.stageRow("doc1", "tagging"), null, "a dry run must not mark work done");
    assert.equal(state.stageRow("doc1", "renaming"), null);
  });

  it("is a no-op on the second run", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config());
    await run(config());
    assert.deepEqual(ports.modelCalls, ["catalogue"], "already-done work must not be repeated");
  });

  it("reprocesses when the prompt version is bumped", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config());
    await run(config((draft) => {
      draft.tagging.promptVersion = "2";
    }));
    assert.deepEqual(ports.modelCalls, ["catalogue", "catalogue"]);
  });

  it("keeps the tags when AirTrail fails", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["viaggi"]);
    ports.failOn["flights"] = "airtrail is down";
    await run(config());
    assert.equal(state.stageRow("doc1", "tagging")?.status, "done", "one failure must not cost the tags");
    assert.equal(state.stageRow("doc1", "flights")?.status, "error");
  });

  it("records an error for the catalogue stages when the model fails", async () => {
    ports.failOn["catalogue"] = "429 rate limited";
    await run(config());
    assert.equal(state.stageRow("doc1", "tagging")?.status, "error");
    assert.equal(state.stageRow("doc1", "renaming")?.status, "error");
    assert.match(String(state.stageRow("doc1", "tagging")?.result ?? ""), /^$|null/);
  });

  it("leaves a document with no extracted content for the next sweep", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"]);
    await run(config(), document({ content: "   " }));
    assert.deepEqual(ports.modelCalls, [], "no content means nothing to classify yet");
    assert.equal(state.stageRow("doc1", "tagging"), null);
  });

  it("skips the rename call when renaming.dry_run is on but stores the proposal", async () => {
    ports.answers["catalogue"] = catalogueAnswer(["banca"], { party: "Enel", doctype: "bolletta" });
    await run(config((draft) => {
      draft.renaming.dryRun = true;
      draft.flights.enabled = false;
    }));
    assert.equal(ports.renames.length, 0);
    const row = state.stageRow("doc1", "renaming");
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

    const applied = await applyPendingRenames(cfg, state, ports);
    assert.equal(applied, 1);
    assert.deepEqual(ports.modelCalls, [], "the names were already decided and paid for");
    assert.deepEqual(ports.renames, [{ docId: "doc1", name: "2024-10-26_enel_bolletta.pdf" }]);
    assert.equal(state.stageRow("doc1", "renaming")?.status, "done");
    assert.deepEqual(state.pendingRenames(), [], "an applied rename must not be offered twice");
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
    assert.equal(state.stageRow("doc1", "renaming")?.status, "skipped", "a failed rename stays pending");
  });
});

describe("spend brake", () => {
  const secrets = { mistralKey: "k", papraApiKey: "k", airtrailKey: "k" };

  it("refuses a model call by default", async () => {
    const ports = createPorts(config(), secrets);
    await assert.rejects(() => ports.askModel("catalogue", "s", "u", {}), SpendBlockedError);
  });

  it("still refuses when allowSpend is explicitly false", async () => {
    const ports = createPorts(config(), secrets, { allowSpend: false });
    await assert.rejects(() => ports.askModel("flights", "s", "u", {}), SpendBlockedError);
  });

  it("blocks before any network call is attempted", async () => {
    // The guard is the first statement in askModel, so an unreachable host and
    // a bogus key never matter — nothing leaves the process.
    const ports = createPorts(config(), { mistralKey: "", papraApiKey: "", airtrailKey: "" });
    await assert.rejects(() => ports.askModel("catalogue", "s", "u", {}), /refusing to call the model/);
  });

  it("names the free alternative in the error", async () => {
    const ports = createPorts(config(), secrets);
    await assert.rejects(() => ports.askModel("catalogue", "s", "u", {}), /--apply-renames costs none/);
  });

  it("defaults [model] spend to false when the key is absent", () => {
    const parsed = parseConfig(CONFIG_TOML.replace("spend = true\n", ""), {});
    assert.equal(parsed.model.spend, false, "an unset spend must not mean spend freely");
  });

  it("refuses a model call whenever the config says not to spend", async () => {
    const ports = createPorts(config((draft) => { draft.model.spend = false; }), secrets, {
      allowSpend: false,
    });
    await assert.rejects(() => ports.askModel("catalogue", "s", "u", {}), SpendBlockedError);
  });
});

describe("cli", () => {
  it("has no default action", () => {
    const args = parseArgs([]);
    assert.ok(!args.once && !args.serve && !args.applyRenames && args.doc === null);
  });

  it("parses --limit, the bound on how many documents a run touches", () => {
    assert.equal(parseArgs(["--once", "--limit", "5"]).limit, 5);
    assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["--limit", "all"]), /positive integer/);
  });
});
