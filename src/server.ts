/**
 * Webhook receiver.
 *
 * The endpoint accepts POSTs from anything that can reach the port, so the HMAC
 * check is the only thing standing between Papra and the network. It is
 * therefore mandatory: the server refuses to start without a secret rather than
 * quietly falling back to accepting everything, which is what the first version
 * did.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Config } from "./config.ts";
import type { Ports } from "./ports.ts";

/**
 * Papra signs `v1,<base64 hmac-sha256>` over `"{webhookId}.{timestamp}.{rawBody}"`.
 * Per the standard-webhooks spec the header may carry several space-separated
 * signatures (e.g. after a secret rotation); any valid v1 entry accepts.
 */
export function verifySignature(
  secret: string,
  webhookId: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest();

  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    let given: Buffer;
    try {
      given = Buffer.from(entry.slice(comma + 1), "base64");
    } catch {
      continue;
    }
    // timingSafeEqual throws on a length mismatch, which is itself a rejection.
    if (given.length === expected.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

export function documentIdFrom(event: any): string | null {
  return event?.payload?.document?.id ?? event?.payload?.documentId ?? null;
}

interface QueueItem {
  docId: string;
  receivedAt: number;
}

function createWebhookServer(
  config: Config,
  ports: Ports,
  secret: string,
  onDocument: (docId: string) => void,
): Server {
  return createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const header = (name: string) => String(request.headers[name] ?? "");

      if (
        !verifySignature(
          secret,
          header("webhook-id"),
          header("webhook-timestamp"),
          raw,
          header("webhook-signature"),
        )
      ) {
        response.writeHead(401);
        response.end();
        ports.log("webhook: bad signature, rejected");
        return;
      }

      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }

      // Acknowledge immediately: Papra retries on non-2xx and the model call
      // takes seconds. The work happens after the response.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");

      const docId = documentIdFrom(event);
      if (docId) {
        onDocument(docId);
        ports.log(`webhook: ${(event as any)?.event} -> ${docId}`);
      }
    });
  });
}

/**
 * Serve webhooks, and optionally sweep on a timer.
 *
 * The first sweep is scheduled one full interval out, never at startup. A sweep
 * on a cold state DB is a full-archive backfill, and that must be an explicit
 * `--once`, not a side effect of `docker compose up`.
 */
export async function serve(
  config: Config,
  ports: Ports,
  secret: string,
  handlers: {
    processDocument: (docId: string) => Promise<void>;
    reconcile: () => Promise<void>;
  },
): Promise<void> {
  if (!secret) {
    throw new Error(
      "PAPRA_WEBHOOK_SECRET is not set. The webhook endpoint would accept any " +
        "unsigned POST that can reach it; refusing to start.",
    );
  }

  const queue: QueueItem[] = [];
  const server = createWebhookServer(config, ports, secret, (docId) => {
    queue.push({ docId, receivedAt: Date.now() });
  });

  await new Promise<void>((resolve) => {
    server.listen(config.trigger.listenPort, config.trigger.listenHost, resolve);
  });
  ports.log(`listening on ${config.trigger.listenHost}:${config.trigger.listenPort}`);

  const settleMs = config.trigger.contentSettleSeconds * 1000;
  const intervalMs = config.trigger.reconcileIntervalSeconds * 1000;
  let lastSweep = Date.now(); // NOT 0: no sweep at startup.
  if (intervalMs > 0) {
    ports.log(
      `periodic sweep every ${config.trigger.reconcileIntervalSeconds}s, first one in that long`,
    );
  }

  for (;;) {
    const now = Date.now();
    // Papra extracts text asynchronously, so a document is not readable the
    // instant document:created fires.
    const ready = queue.filter((item) => now - item.receivedAt >= settleMs);
    const waiting = queue.filter((item) => now - item.receivedAt < settleMs);
    queue.length = 0;
    queue.push(...waiting);

    for (const item of ready) {
      try {
        await handlers.processDocument(item.docId);
      } catch (error) {
        ports.log(`  ! ${item.docId}: ${(error as Error).message}`);
      }
    }

    if (intervalMs > 0 && now - lastSweep >= intervalMs) {
      lastSweep = now;
      try {
        await handlers.reconcile();
      } catch (error) {
        const message = String((error as Error).message).slice(0, 400);
        ports.log(`reconcile failed: ${message}`);
        await ports.notify("papra-curator sweep failed", message, "high");
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
