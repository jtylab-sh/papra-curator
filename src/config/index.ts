/**
 * Config: parsed from config.toml and validated in one place, at startup,
 * because the alternative is discovering a missing key partway through a sweep
 * that has already spent money on model calls.
 */

import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { env } from "#~/config/env.ts";

export { env } from "#~/config/env.ts";

/**
 * smol-toml is strict — anything it cannot parse throws with a line number
 * rather than being skipped. That matters here: a config parser that silently
 * ignores a line it cannot read is how a `dry_run = true` quietly becomes a
 * live run.
 */
type TomlTable = { [key: string]: unknown };
type TomlValue = unknown;

export type Stage = "tagging" | "renaming" | "flights";

export interface Config {
  papra: {
    dbPath: string;
    apiUrl: string;
    organizationId: string;
    contentLimit: number;
  };
  trigger: {
    listenHost: string;
    listenPort: number;
    reconcileIntervalSeconds: number;
  };
  model: {
    name: string;
    spend: boolean;
    temperature: number;
    maxAttempts: number;
  };
  tagging: {
    enabled: boolean;
    promptVersion: string;
    maxTags: number;
    allowNewTags: boolean;
    countryProperty: string;
    setDocumentDate: boolean;
  };
  renaming: {
    enabled: boolean;
    promptVersion: string;
    template: string;
    slugifyFields: boolean;
    maxLength: number;
    dryRun: boolean;
    originalNameProperty: string;
  };
  flights: {
    enabled: boolean;
    promptVersion: string;
    tags: string[];
    airtrailUrl: string;
    ownerUserId: string;
    ownerNames: string[];
    nearDuplicateDays: number;
    dryRun: boolean;
  };
  notify: {
    url: string;
    topic: string;
    onTagged: boolean;
    onRenamed: boolean;
    onFlights: boolean;
    onError: boolean;
    onSweep: boolean;
  };
}

class ConfigError extends Error {}

function table(root: TomlTable, path: string): TomlTable {
  let node: TomlValue | undefined = root;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new ConfigError(`[${path}] is missing from the config`);
    }
    node = (node as TomlTable)[part];
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new ConfigError(`[${path}] is missing from the config`);
  }
  return node as TomlTable;
}

function str(node: TomlTable, key: string, where: string, fallback?: string): string {
  const value = node[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`[${where}] ${key} is required`);
  }
  if (typeof value !== "string") throw new ConfigError(`[${where}] ${key} must be a string`);
  return value;
}

function num(node: TomlTable, key: string, where: string, fallback?: number): number {
  const value = node[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`[${where}] ${key} is required`);
  }
  if (typeof value !== "number") throw new ConfigError(`[${where}] ${key} must be a number`);
  return value;
}

function bool(node: TomlTable, key: string, where: string, fallback: boolean): boolean {
  const value = node[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`[${where}] ${key} must be true or false`);
  return value;
}

function strings(node: TomlTable, key: string, where: string, fallback?: string[]): string[] {
  const value = node[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`[${where}] ${key} is required`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`[${where}] ${key} must be an array of strings`);
  }
  return value as string[];
}

/**
 * `prompt_version` is a string on purpose: it is an opaque token compared for
 * equality, and bumping it is what re-queues a stage for every document. A
 * number in the TOML is accepted and stringified so `prompt_version = 2` does
 * not silently fail to match the stored `"2"`.
 */
function version(node: TomlTable, where: string): string {
  const value = node["prompt_version"];
  if (value === undefined) throw new ConfigError(`[${where}] prompt_version is required`);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new ConfigError(`[${where}] prompt_version must be a string`);
}

export function parseConfig(text: string): Config {
  const root = parseToml(text) as TomlTable;
  const papra = table(root, "papra");
  const trigger = table(root, "trigger");
  const model = table(root, "model");
  const tagging = table(root, "tagging");
  const renaming = table(root, "renaming");
  const flights = table(root, "handlers.flights");
  const notify = table(root, "notify");

  const config: Config = {
    papra: {
      dbPath: str(papra, "db_path", "papra", ""),
      apiUrl: str(papra, "api_url", "papra", ""),
      organizationId: str(papra, "organization_id", "papra", ""),
      contentLimit: num(papra, "content_limit", "papra", 30000),
    },
    trigger: {
      listenHost: str(trigger, "listen_host", "trigger", "0.0.0.0"),
      listenPort: num(trigger, "listen_port", "trigger", 8099),
      reconcileIntervalSeconds: num(trigger, "reconcile_interval_seconds", "trigger", 0),
    },
    model: {
      name: str(model, "name", "model"),
      // Defaults OFF: no model call happens until this is turned on, so a
      // fresh install cannot spend anything.
      spend: bool(model, "spend", "model", false),
      temperature: num(model, "temperature", "model", 0),
      maxAttempts: num(model, "max_attempts", "model", 3),
    },
    tagging: {
      enabled: bool(tagging, "enabled", "tagging", true),
      promptVersion: version(tagging, "tagging"),
      maxTags: num(tagging, "max_tags", "tagging", 8),
      allowNewTags: bool(tagging, "allow_new_tags", "tagging", false),
      // Papra text custom property to fill with the document's country
      // (created on first use); empty disables.
      countryProperty: str(tagging, "country_property", "tagging", ""),
      // File the catalogue's issue date into Papra's native document date
      // field (the UI's "Date"); only full YYYY-MM-DD dates are written.
      setDocumentDate: bool(tagging, "set_document_date", "tagging", false),
    },
    renaming: {
      enabled: bool(renaming, "enabled", "renaming", true),
      promptVersion: version(renaming, "renaming"),
      template: str(renaming, "template", "renaming"),
      slugifyFields: bool(renaming, "slugify_fields", "renaming", true),
      maxLength: num(renaming, "max_length", "renaming", 120),
      // Defaults to a safety rail: an unset dry_run must never mean "rename
      // everything in the archive".
      dryRun: bool(renaming, "dry_run", "renaming", true),
      originalNameProperty: str(renaming, "original_name_property", "renaming", "Original name"),
    },
    flights: {
      // Defaults OFF: this handler pushes to a third-party service and is
      // useless to anyone who does not run AirTrail.
      enabled: bool(flights, "enabled", "handlers.flights", false),
      promptVersion: version(flights, "handlers.flights"),
      tags: strings(flights, "tags", "handlers.flights", []),
      airtrailUrl: str(flights, "airtrail_url", "handlers.flights", ""),
      ownerUserId: str(flights, "owner_user_id", "handlers.flights", ""),
      ownerNames: strings(flights, "owner_names", "handlers.flights", []),
      nearDuplicateDays: num(flights, "near_duplicate_days", "handlers.flights", 2),
      dryRun: bool(flights, "dry_run", "handlers.flights", false),
    },
    notify: {
      url: str(notify, "url", "notify", ""),
      topic: str(notify, "topic", "notify", ""),
      // One switch per event. Failures and filed flights are worth a push by
      // default; per-document tagging and renaming are opt-in volume.
      onTagged: bool(notify, "on_tagged", "notify", false),
      onRenamed: bool(notify, "on_renamed", "notify", false),
      onFlights: bool(notify, "on_flights", "notify", true),
      onError: bool(notify, "on_error", "notify", true),
      // One push summarizing a sweep that did anything; sweeps suppress the
      // per-document pushes, so a backfill is one message, not hundreds.
      onSweep: bool(notify, "on_sweep", "notify", true),
    },
  };

  const required: [string, string][] = [
    [config.papra.organizationId, "[papra] organization_id"],
    [config.papra.apiUrl, "[papra] api_url"],
    [config.papra.dbPath, "[papra] db_path"],
  ];
  for (const [value, key] of required) {
    if (!value) throw new ConfigError(`${key} is required`);
  }

  if (config.tagging.maxTags < 1) throw new ConfigError("[tagging] max_tags must be at least 1");
  if (config.model.maxAttempts < 1)
    throw new ConfigError("[model] max_attempts must be at least 1");
  if (config.flights.enabled) {
    if (!config.flights.airtrailUrl) {
      throw new ConfigError("[handlers.flights] airtrail_url is required when enabled");
    }
    if (!config.flights.ownerUserId) {
      throw new ConfigError(
        "[handlers.flights] owner_user_id is required when enabled — the AirTrail user flights are filed under",
      );
    }
    if (config.flights.tags.length === 0) {
      // The tag gate is what keeps the second model call off the ~95% of an
      // archive that is not travel. With no tags it would never fire at all.
      throw new ConfigError(
        "[handlers.flights] tags must not be empty when enabled — list the tag(s) that mark a travel document",
      );
    }
    if (config.flights.ownerNames.length === 0) {
      // Without owner names every flight in every document would look like the
      // owner's, including the ones booked for family.
      throw new ConfigError(
        "[handlers.flights] owner_names must not be empty when enabled — every spelling airlines print for the owner",
      );
    }
  }
  return config;
}

export function loadConfig(path: string = env.configPath): Config {
  return parseConfig(readFileSync(path, "utf8"));
}
