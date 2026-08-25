/**
 * Config and secrets.
 *
 * Every knob lives in config.toml; only secrets come from the environment.
 * The whole config is validated here, at startup, because the alternative is
 * discovering a missing key partway through a sweep that has already spent
 * money on model calls.
 */

import { readFileSync } from "node:fs";
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";

export const env = {
  configPath: process.env.CURATOR_CONFIG ?? "/app/config.toml",
  stateDb: process.env.CURATOR_DB ?? "/state/curator.db",
  mistralKey: process.env.MISTRAL_API_KEY ?? "",
  papraApiKey: process.env.PAPRA_API_KEY ?? "",
  airtrailKey: process.env.AIRTRAIL_KEY ?? "",
  airtrailUserId: process.env.AIRTRAIL_USER_ID ?? "",
  webhookSecret: process.env.PAPRA_WEBHOOK_SECRET ?? "",
};

/**
 * Config values that identify a specific deployment or person, and therefore
 * belong in compose's environment rather than in a file meant to be committed:
 * the organization id, the hostnames, and the archive owner's names.
 *
 * Each one overrides the matching config.toml key when set, so config.toml can
 * ship as pure behaviour (prompt versions, limits, safety rails) with nothing
 * identifying in it. An empty or unset variable changes nothing — it never
 * blanks a value the file already supplies.
 */
export const ENV_OVERRIDES: Record<string, string> = {
  PAPRA_ORGANIZATION_ID: "papra.organization_id",
  PAPRA_API_URL: "papra.api_url",
  PAPRA_DB_PATH: "papra.db_path",
  AIRTRAIL_URL: "handlers.flights.airtrail_url",
  // Pipe-separated, because the names airlines print contain commas
  // ("DOE, JANE"). Quote it in .env: `|` is a shell operator.
  AIRTRAIL_OWNER_NAMES: "handlers.flights.owner_names",
  NTFY_URL: "notify.url",
  NTFY_TOPIC: "notify.topic",
};

export const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

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
    contentSettleSeconds: number;
  };
  model: {
    name: string;
    temperature: number;
    maxAttempts: number;
    retryBackoffSeconds: number;
  };
  tagging: {
    enabled: boolean;
    promptVersion: string;
    maxTags: number;
    allowNewTags: boolean;
  };
  renaming: {
    enabled: boolean;
    promptVersion: string;
    template: string;
    slugifyFields: boolean;
    maxLength: number;
    dryRun: boolean;
  };
  flights: {
    enabled: boolean;
    promptVersion: string;
    tags: string[];
    airtrailUrl: string;
    ownerNames: string[];
    nearDuplicateDays: number;
    dryRun: boolean;
  };
  notify: {
    url: string;
    topic: string;
    onSuccess: boolean;
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

/**
 * Write an env-supplied value into the parsed TOML tree before validation, so
 * a value provided only by the environment satisfies a "required" check exactly
 * as a value in the file would.
 */
function applyEnvOverrides(root: TomlTable, source: Record<string, string | undefined>): void {
  for (const [variable, path] of Object.entries(ENV_OVERRIDES)) {
    const raw = source[variable];
    if (raw === undefined || raw.trim() === "") continue;

    const parts = path.split(".");
    const leaf = parts.pop()!;
    let node = root;
    for (const part of parts) {
      if (typeof node[part] !== "object" || node[part] === null || Array.isArray(node[part])) {
        node[part] = {};
      }
      node = node[part] as TomlTable;
    }
    node[leaf] = leaf === "owner_names"
      ? raw.split("|").map((name) => name.trim()).filter((name) => name.length > 0)
      : raw.trim();
  }
}

export function parseConfig(
  text: string,
  source: Record<string, string | undefined> = process.env,
): Config {
  const root = parseToml(text);
  applyEnvOverrides(root, source);
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
      contentSettleSeconds: num(trigger, "content_settle_seconds", "trigger", 20),
    },
    model: {
      name: str(model, "name", "model"),
      temperature: num(model, "temperature", "model", 0),
      maxAttempts: num(model, "max_attempts", "model", 3),
      retryBackoffSeconds: num(model, "retry_backoff_seconds", "model", 20),
    },
    tagging: {
      enabled: bool(tagging, "enabled", "tagging", true),
      promptVersion: version(tagging, "tagging"),
      maxTags: num(tagging, "max_tags", "tagging", 8),
      allowNewTags: bool(tagging, "allow_new_tags", "tagging", false),
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
    },
    flights: {
      // Defaults OFF: this handler pushes to a third-party service and is
      // useless to anyone who does not run AirTrail.
      enabled: bool(flights, "enabled", "handlers.flights", false),
      promptVersion: version(flights, "handlers.flights"),
      tags: strings(flights, "tags", "handlers.flights", []),
      airtrailUrl: str(flights, "airtrail_url", "handlers.flights", ""),
      ownerNames: strings(flights, "owner_names", "handlers.flights", []),
      nearDuplicateDays: num(flights, "near_duplicate_days", "handlers.flights", 2),
      dryRun: bool(flights, "dry_run", "handlers.flights", false),
    },
    notify: {
      url: str(notify, "url", "notify", ""),
      topic: str(notify, "topic", "notify", ""),
      onSuccess: bool(notify, "on_success", "notify", true),
    },
  };

  // These three can come from either config.toml or the environment, so the
  // error has to name both places or it sends you looking in the wrong file.
  const required: [string, string, string][] = [
    [config.papra.organizationId, "[papra] organization_id", "PAPRA_ORGANIZATION_ID"],
    [config.papra.apiUrl, "[papra] api_url", "PAPRA_API_URL"],
    [config.papra.dbPath, "[papra] db_path", "PAPRA_DB_PATH"],
  ];
  for (const [value, key, variable] of required) {
    if (!value) throw new ConfigError(`${key} is required — set it in config.toml or as ${variable}`);
  }

  if (config.tagging.maxTags < 1) throw new ConfigError("[tagging] max_tags must be at least 1");
  if (config.model.maxAttempts < 1) throw new ConfigError("[model] max_attempts must be at least 1");
  if (config.flights.enabled) {
    if (!config.flights.airtrailUrl) {
      throw new ConfigError(
        "[handlers.flights] airtrail_url is required when enabled — set it in config.toml or as AIRTRAIL_URL",
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
        "[handlers.flights] owner_names must not be empty when enabled — set it in config.toml " +
          "or as AIRTRAIL_OWNER_NAMES (pipe-separated)",
      );
    }
  }
  return config;
}

export function loadConfig(path: string = env.configPath): Config {
  return parseConfig(readFileSync(path, "utf8"));
}

export function promptVersionFor(config: Config, stage: Stage): string {
  return config[stage].promptVersion;
}
