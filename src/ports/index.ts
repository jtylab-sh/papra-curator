/**
 * Everything the pipeline does to the outside world, behind one interface.
 *
 * The pipeline never calls fetch, sqlite or the model directly — it calls a
 * Port. That is what lets the tests assert the property that actually costs
 * money ("a non-travel document must make exactly one model call") by counting
 * calls on a fake, instead of monkeypatching modules and hoping.
 */

import type { Config } from "#~/config/index.ts";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
import { requestJson } from "#~/ports/http.ts";
import { PapraReader, PapraWriter, type Tag } from "#~/papra/index.ts";

export interface AirtrailFlight {
  date?: string;
  flightNumber?: string;
  from?: { iata?: string } | null;
  to?: { iata?: string } | null;
}

export interface Ports {
  /** One structured-output call to the model. `label` exists so tests and logs can tell the two prompts apart. */
  askModel(label: string, system: string, user: string, schema: object): Promise<any>;

  listTags(): Tag[];
  documentTags(docId: string): string[];
  applyTag(docId: string, tagId: string): Promise<void>;
  createTag(name: string, description?: string): Promise<string | null>;
  renameDocument(docId: string, newName: string): Promise<void>;
  setDocumentDate(docId: string, isoDate: string): Promise<void>;

  customPropertyId(name: string): string | null;
  createCustomProperty(name: string): Promise<string | null>;
  setCustomProperty(docId: string, propertyId: string, value: string): Promise<void>;

  listFlights(): Promise<AirtrailFlight[]>;
  saveFlight(body: unknown): Promise<void>;

  notify(title: string, message: string, priority?: string): Promise<void>;
  log(message: string): void;
}

export function timestampedLog(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`${stamp} ${message}\n`);
}

/**
 * `allowSpend` is the hard stop on model spend.
 *
 * Every model call in the service goes through `askModel`, so refusing here
 * refuses all of them — a sweep, a webhook, a --dry-run, a handler added later.
 * It defaults to false, and is turned on only by `[model] spend` in config.toml.
 *
 * Note that --dry-run is NOT free. It asks the model and then declines to apply
 * the answer, so it costs exactly as much as a real run.
 */
export class SpendBlockedError extends Error {
  constructor() {
    super(
      "refusing to call the model: set [model] spend = true in config.toml to allow it. " +
        "Note --dry-run still costs one call per document; --apply-renames costs none.",
    );
    this.name = "SpendBlockedError";
  }
}

export function createPorts(
  config: Config,
  secrets: { mistralKey: string; papraApiKey: string; airtrailKey: string },
  options: { allowSpend?: boolean } = {},
): Ports {
  const reader = new PapraReader(config);
  const writer = new PapraWriter(config, secrets.papraApiKey);
  const airtrail = config.flights.airtrailUrl.replace(/\/+$/, "");

  return {
    async askModel(_label, system, user, schema) {
      if (!options.allowSpend) throw new SpendBlockedError();
      const answer = await requestJson(MISTRAL_URL, {
        payload: {
          model: config.model.name,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: _label, schema, strict: true },
          },
          temperature: config.model.temperature,
        },
        token: secrets.mistralKey,
      });
      return JSON.parse(answer.choices[0].message.content);
    },

    listTags: () => reader.tags(),
    documentTags: (docId) => reader.documentTags(docId),
    applyTag: (docId, tagId) => writer.applyTag(docId, tagId),
    createTag: (name, description) => writer.createTag(name, description),
    renameDocument: (docId, newName) => writer.renameDocument(docId, newName),
    setDocumentDate: (docId, isoDate) => writer.setDocumentDate(docId, isoDate),
    customPropertyId: (name) => reader.customPropertyId(name),
    createCustomProperty: (name) => writer.createCustomProperty(name),
    setCustomProperty: (docId, propertyId, value) =>
      writer.setCustomProperty(docId, propertyId, value),

    async listFlights() {
      const answer = await requestJson(`${airtrail}/api/flight/list`, {
        token: secrets.airtrailKey,
        timeoutMs: 60_000,
      });
      return (answer?.flights ?? []) as AirtrailFlight[];
    },

    async saveFlight(body) {
      await requestJson(`${airtrail}/api/flight/save`, {
        payload: body,
        token: secrets.airtrailKey,
        timeoutMs: 60_000,
      });
    },

    async notify(title, message, priority = "default") {
      if (!config.notify.topic || !config.notify.url) return;
      try {
        await fetch(`${config.notify.url.replace(/\/+$/, "")}/${config.notify.topic}`, {
          method: "POST",
          headers: { Title: title, Priority: priority },
          body: message,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        // A failed notification must never fail the pipeline.
        timestampedLog(`  ntfy failed: ${(error as Error).message}`);
      }
    },

    log: timestampedLog,
  };
}
