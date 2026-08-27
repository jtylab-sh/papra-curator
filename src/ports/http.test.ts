/** requestJson retry behavior: transient failures are retried, contract errors are not. */

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { createServer, type Server } from "node:http";
import { requestJson, HttpError } from "#~/ports/http.ts";

/** One server per scripted list of responses; `null` means drop the connection. */
function serveScript(script: ({ status: number; body: string } | null)[]): {
  server: Server;
  url: () => string;
  hits: () => number;
} {
  let hits = 0;
  const server = createServer((request, response) => {
    const step = script[Math.min(hits, script.length - 1)];
    hits++;
    if (step === null) {
      request.socket.destroy();
      return;
    }
    response.writeHead(step.status, { "Content-Type": "application/json" });
    response.end(step.body);
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    hits: () => hits,
  };
}

const NO_WAIT = { retryDelaysMs: [0, 0] };

describe("requestJson retries", () => {
  const servers: Server[] = [];
  after(() => {
    for (const server of servers) server.close();
  });

  async function start(script: ({ status: number; body: string } | null)[]) {
    const scripted = serveScript(script);
    servers.push(scripted.server);
    await new Promise<void>((resolve) => scripted.server.listen(0, "127.0.0.1", resolve));
    return scripted;
  }

  it("retries a 503 and returns the eventual success", async () => {
    const scripted = await start([
      { status: 503, body: "upstream connect error, reset reason: overflow" },
      { status: 503, body: "upstream connect error, reset reason: overflow" },
      { status: 200, body: '{"ok":true}' },
    ]);
    const answer = await requestJson(scripted.url(), NO_WAIT);
    assert.deepEqual(answer, { ok: true });
    assert.equal(scripted.hits(), 3);
  });

  it("gives up after the retries are exhausted", async () => {
    const scripted = await start([{ status: 503, body: "still down" }]);
    await assert.rejects(
      () => requestJson(scripted.url(), NO_WAIT),
      (error: unknown) => error instanceof HttpError && error.status === 503,
    );
    assert.equal(scripted.hits(), 3, "initial attempt plus one per retry delay");
  });

  it("does not retry a 4xx contract error", async () => {
    const scripted = await start([{ status: 400, body: "bad payload" }]);
    await assert.rejects(
      () => requestJson(scripted.url(), NO_WAIT),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    assert.equal(scripted.hits(), 1);
  });

  it("retries a dropped connection", async () => {
    const scripted = await start([null, { status: 200, body: '{"ok":1}' }]);
    const answer = await requestJson(scripted.url(), NO_WAIT);
    assert.deepEqual(answer, { ok: 1 });
    assert.equal(scripted.hits(), 2);
  });
});
