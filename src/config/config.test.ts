import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "#~/config/index.ts";
import { CONFIG_TOML } from "#~/testing/helpers.ts";

describe("config", () => {
  it("throws rather than silently skipping a line it cannot parse", async () => {
    // The dangerous failure mode: a config parser that ignores what it does not
    // understand can turn dry_run = true into an unset (live) run.
    assert.throws(() => parseConfig(CONFIG_TOML + "\nk = nonsense", {}));
    assert.throws(() => parseConfig(CONFIG_TOML + "\n[notify]\n", {}), /redefine/);
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace("max_tags = 8", "max_tags = 8\nmax_tags = 9"), {}),
      /redefine/,
    );
  });

  it("rejects a flights handler that cannot enforce the owner rule", async () => {
    assert.throws(
      () =>
        parseConfig(
          CONFIG_TOML.replace('owner_names = ["Test Owner", "OWNER/TEST"]', "owner_names = []"),
          {},
        ),
      /owner_names must not be empty/,
    );
  });

  it("rejects an enabled flights handler with no trigger tags", async () => {
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace('tags = ["viaggi"]', "tags = []"), {}),
      /tags must not be empty/,
    );
  });

  it("defaults renaming.dry_run to true when the key is absent", async () => {
    const parsed = parseConfig(
      CONFIG_TOML.replace("dry_run = false\n\n[handlers.flights]", "\n[handlers.flights]"),
      {},
    );
    assert.equal(parsed.renaming.dryRun, true, "an unset dry_run must not mean rename everything");
  });

  it("defaults the flights handler off", async () => {
    const parsed = parseConfig(
      CONFIG_TOML.replace(
        'enabled = true\nprompt_version = "1"\ntags',
        'prompt_version = "1"\ntags',
      ),
      {},
    );
    assert.equal(parsed.flights.enabled, false);
  });

  it("takes identity from the environment so config.toml carries none", async () => {
    // config.toml ships with these blank; compose supplies them.
    const blank = CONFIG_TOML.replace('organization_id = "org_test"', 'organization_id = ""')
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

  it("lets the environment win over a value in the file", async () => {
    const parsed = parseConfig(CONFIG_TOML, { PAPRA_ORGANIZATION_ID: "org_override" });
    assert.equal(parsed.papra.organizationId, "org_override");
  });

  it("ignores an unset or blank variable rather than blanking the file value", async () => {
    const parsed = parseConfig(CONFIG_TOML, {
      PAPRA_ORGANIZATION_ID: "   ",
      AIRTRAIL_URL: undefined,
    });
    assert.equal(parsed.papra.organizationId, "org_test");
    assert.equal(parsed.flights.airtrailUrl, "https://fly.example.com");
  });

  it("names both places when an identity value is missing everywhere", async () => {
    const blank = CONFIG_TOML.replace('organization_id = "org_test"', 'organization_id = ""');
    assert.throws(
      () => parseConfig(blank, {}),
      /organization_id is required.*PAPRA_ORGANIZATION_ID/s,
    );
  });

  it("accepts a numeric prompt_version so it cannot silently fail to match", async () => {
    const parsed = parseConfig(
      CONFIG_TOML.replace(
        '[tagging]\nenabled = true\nprompt_version = "1"',
        "[tagging]\nenabled = true\nprompt_version = 2",
      ),
      {},
    );
    assert.equal(parsed.tagging.promptVersion, "2");
  });
});
