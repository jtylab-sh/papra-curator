#!/bin/sh
# Bring the state DB up to date before anything reads it.
#
# `prisma migrate deploy`'s schema engine opens the DB without a busy timeout,
# so it dies with "database is locked" whenever another container (--serve)
# holds the file. On an already-migrated DB — every start after the first —
# a cheap read-only check skips the deploy entirely; a fresh or outdated DB
# runs it with retries, in case a serve container is writing at that moment.
set -e
if node /app/src/cli/migrations-applied.ts; then
  echo "state DB schema is up to date, skipping migrate deploy"
else
  attempt=1
  until node_modules/.bin/prisma migrate deploy; do
    if [ "$attempt" -ge 5 ]; then
      echo "migrate deploy failed $attempt times, giving up" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    echo "migrate deploy failed, retrying (attempt $attempt of 5) in 2s" >&2
    sleep 2
  done
fi
exec node /app/src/cli/index.ts "$@"
