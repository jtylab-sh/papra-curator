// Prisma 7 keeps the connection URL out of schema.prisma: migrations read it
// from here, and the client is handed a driver adapter at construction.
//
// The URL comes from the app's own env module, so `prisma migrate deploy` and
// the running service cannot end up pointing at different files.
import { defineConfig } from "prisma/config";
import { env } from "./src/config/index.ts";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env.databaseUrl },
});
