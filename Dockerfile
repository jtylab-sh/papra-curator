# Prisma generates its client from prisma/schema.prisma, so unlike earlier
# versions of this service there is a build stage. Debian rather than Alpine
# because better-sqlite3, which Prisma's SQLite adapter drives, ships prebuilt
# binaries for glibc and would otherwise have to be compiled here.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# prisma.config.ts reads the database URL from src/config.ts, so the source has
# to be here to generate. Generate against the full dependency tree, then drop
# everything the running service does not need — the Prisma CLI stays, since it
# applies migrations at start.
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/generated ./src/generated
COPY prisma ./prisma
COPY prisma.config.ts package.json ./
COPY src ./src
COPY config.example.toml ./
COPY --chmod=755 docker-entrypoint.sh ./

# Config is expected as a mounted file. Nothing is baked in: the image carries
# no organization id, no hostnames and no keys.
ENV CURATOR_CONFIG=/app/config.toml \
    DATABASE_URL=file:/state/curator.db

# Drop root. The state DB is the only thing written, and its directory has to be
# writable by this uid — `chown 1000:1000` on the host state dir, or run the
# container with `--user` matching whoever owns it.
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]

# Usage, deliberately. There is no default action and no default that spends:
# starting this container by accident must never cost a model call.
CMD ["--help"]
