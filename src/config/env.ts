/**
 * Secrets and the environment.
 *
 * Secrets come only from the environment, never config.toml. The ENV_OVERRIDES
 * below additionally let compose supply the values that identify a specific
 * deployment or person, so config.toml can ship as pure behaviour.
 */

export const env = {
  configPath: process.env.CURATOR_CONFIG ?? "/app/config.toml",
  // Prisma's own variable, and the same one `prisma migrate deploy` reads, so
  // the app and its migrations can never point at different files.
  databaseUrl: process.env.DATABASE_URL ?? "file:/state/curator.db",
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

type TomlTable = { [key: string]: unknown };

/**
 * Write an env-supplied value into the parsed TOML tree before validation, so
 * a value provided only by the environment satisfies a "required" check exactly
 * as a value in the file would.
 */
export function applyEnvOverrides(
  root: TomlTable,
  source: Record<string, string | undefined>,
): void {
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
    node[leaf] =
      leaf === "owner_names"
        ? raw
            .split("|")
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
        : raw.trim();
  }
}
