#!/bin/sh
# Bring the state DB up to date before anything reads it. Idempotent, so it is
# safe on every start, including `docker compose run` for a one-shot command.
set -e
node_modules/.bin/prisma migrate deploy
exec node /app/src/main.ts "$@"
