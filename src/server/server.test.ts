import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHmac } from "node:crypto";
import { verifySignature, documentIdFrom } from "#~/server/index.ts";

describe("webhook signature", () => {
  const secret = "s3cr3t";
  const webhookId = "wbh_1";
  const timestamp = "1700000000";
  const body = '{"event":"document:created"}';
  const good =
    "v1," +
    createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${body}`).digest("base64");

  it("accepts Papra's scheme", async () => {
    assert.ok(verifySignature(secret, webhookId, timestamp, body, good));
  });

  it("rejects a tampered body, a wrong secret, and swapped headers", async () => {
    assert.ok(!verifySignature(secret, webhookId, timestamp, body + " ", good));
    assert.ok(!verifySignature("wrong", webhookId, timestamp, body, good));
    assert.ok(!verifySignature(secret, "wbh_2", timestamp, body, good));
    assert.ok(!verifySignature(secret, webhookId, "1700000001", body, good));
  });

  it("rejects an unknown version, garbage, and an empty secret", async () => {
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, "v2," + good.split(",")[1]));
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, "garbage"));
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, ""));
    // No secret must never mean "accept anything".
    assert.ok(!verifySignature("", webhookId, timestamp, body, good));
  });

  it("accepts a space-separated signature list if any entry matches", async () => {
    // standard-webhooks sends several signatures during a secret rotation.
    assert.ok(verifySignature(secret, webhookId, timestamp, body, `v1,AAAA ${good}`));
    assert.ok(!verifySignature(secret, webhookId, timestamp, body, "v1,AAAA v2,BBBB"));
  });

  it("finds the document id in both payload shapes", async () => {
    assert.equal(documentIdFrom({ payload: { document: { id: "d1" } } }), "d1");
    assert.equal(documentIdFrom({ payload: { documentId: "d2" } }), "d2");
    assert.equal(documentIdFrom({ payload: {} }), null);
  });
});
