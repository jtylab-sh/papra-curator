# No build stage, because there is nothing to build.
#
# Node 24 strips TypeScript types at load and ships node:sqlite, and this
# service has zero npm dependencies — so the image is the runtime plus the
# source, and `docker build` copies files rather than compiling them. That also
# means the code you audit in this repo is byte-for-byte the code that runs.
FROM node:24-alpine

WORKDIR /app
COPY src ./src
COPY config.example.toml ./

# Config is expected as a mounted file. Nothing is baked in: the image carries
# no organization id, no hostnames and no keys.
ENV CURATOR_CONFIG=/app/config.toml \
    CURATOR_DB=/state/curator.db

# Drop root. The state DB is the only thing written, and its directory has to be
# writable by this uid — `chown 1000:1000` on the host state dir, or run the
# container with `--user` matching whoever owns it.
USER node

ENTRYPOINT ["node", "src/main.ts"]

# Usage, deliberately. There is no default action and no default that spends:
# starting this container by accident must never cost a model call.
CMD ["--help"]
