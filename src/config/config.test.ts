import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "#~/config/index.ts";
import { CONFIG_TOML } from "#~/testing/helpers.ts";

describe("config", () => {
  it("throws rather than silently skipping a line it cannot parse", async () => {
    // The dangerous failure mode: a config parser that ignores what it does not
    // understand can turn dry_run = true into an unset (live) run.
    assert.throws(() => parseConfig(CONFIG_TOML + "\nk = nonsense"));
    assert.throws(() => parseConfig(CONFIG_TOML + "\n[notify]\n"), /redefine/);
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace("max_tags = 8", "max_tags = 8\nmax_tags = 9")),
      /redefine/,
    );
  });

  it("defaults notifications to failures and flights only", async () => {
    const stripped = CONFIG_TOML.split("\n")
      .filter((line) => !line.startsWith("on_"))
      .join("\n");
    const parsed = parseConfig(stripped);
    assert.equal(parsed.notify.onTagged, false);
    assert.equal(parsed.notify.onRenamed, false);
    assert.equal(parsed.notify.onFlights, true);
    assert.equal(parsed.notify.onError, true);
  });

  it("rejects a flights handler that cannot enforce the owner rule", async () => {
    assert.throws(
      () =>
        parseConfig(
          CONFIG_TOML.replace('owner_names = ["Test Owner", "OWNER/TEST"]', "owner_names = []"),
        ),
      /owner_names must not be empty/,
    );
  });

  it("rejects an enabled flights handler with no trigger tags", async () => {
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace('tags = ["viaggi"]', "tags = []")),
      /tags must not be empty/,
    );
  });

  it("defaults renaming.dry_run to true when the key is absent", async () => {
    const parsed = parseConfig(
      CONFIG_TOML.replace("dry_run = false\n\n[handlers.flights]", "\n[handlers.flights]"),
    );
    assert.equal(parsed.renaming.dryRun, true, "an unset dry_run must not mean rename everything");
  });

  it("defaults the flights handler off", async () => {
    const parsed = parseConfig(
      CONFIG_TOML.replace(
        'enabled = true\nprompt_version = "1"\ntags',
        'prompt_version = "1"\ntags',
      ),
    );
    assert.equal(parsed.flights.enabled, false);
  });

  it("rejects a blank identity value", async () => {
    const blank = CONFIG_TOML.replace('organization_id = "org_test"', 'organization_id = ""');
    assert.throws(() => parseConfig(blank), /organization_id is required/);
  });

  it("rejects an enabled flights handler with no owner_user_id", async () => {
    assert.throws(
      () => parseConfig(CONFIG_TOML.replace('owner_user_id = "u-owner"', "")),
      /owner_user_id is required/,
    );
  });

  it("accepts a numeric prompt_version so it cannot silently fail to match", async () => {
    const parsed = parseConfig(
      CONFIG_TOML.replace(
        '[tagging]\nenabled = true\nprompt_version = "1"',
        "[tagging]\nenabled = true\nprompt_version = 2",
      ),
    );
    assert.equal(parsed.tagging.promptVersion, "2");
  });
});
