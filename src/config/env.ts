/**
 * The environment carries secrets and runtime paths — nothing else. All
 * behaviour and deployment identity lives in config.toml, so no value has two
 * sources of truth.
 */

export const env = {
  configPath: process.env.CURATOR_CONFIG ?? "/app/config.toml",
  // Prisma's own variable, and the same one `prisma migrate deploy` reads, so
  // the app and its migrations can never point at different files.
  databaseUrl: process.env.DATABASE_URL ?? "file:/state/curator.db",
  mistralKey: process.env.MISTRAL_API_KEY ?? "",
  papraApiKey: process.env.PAPRA_API_KEY ?? "",
  airtrailKey: process.env.AIRTRAIL_KEY ?? "",
  webhookSecret: process.env.PAPRA_WEBHOOK_SECRET ?? "",
};
