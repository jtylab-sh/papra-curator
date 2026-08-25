import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPorts, SpendBlockedError } from "#~/ports/index.ts";
import { CONFIG_TOML, config } from "#~/testing/helpers.ts";
import { parseConfig } from "#~/config/index.ts";

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
    await assert.rejects(
      () => ports.askModel("catalogue", "s", "u", {}),
      /refusing to call the model/,
    );
  });

  it("names the free alternative in the error", async () => {
    const ports = createPorts(config(), secrets);
    await assert.rejects(
      () => ports.askModel("catalogue", "s", "u", {}),
      /--apply-renames costs none/,
    );
  });

  it("defaults [model] spend to false when the key is absent", async () => {
    const parsed = parseConfig(CONFIG_TOML.replace("spend = true\n", ""));
    assert.equal(parsed.model.spend, false, "an unset spend must not mean spend freely");
  });

  it("refuses a model call whenever the config says not to spend", async () => {
    const ports = createPorts(
      config((draft) => {
        draft.model.spend = false;
      }),
      secrets,
      {
        allowSpend: false,
      },
    );
    await assert.rejects(() => ports.askModel("catalogue", "s", "u", {}), SpendBlockedError);
  });
});
