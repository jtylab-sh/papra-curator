# papra-curator

LLM tagging, content-based renaming, and downstream handlers for
[Papra](https://papra.app), run as a sidecar service.

Papra's native auto-tagging makes exactly one attempt per document
(`maxRetries=0`) and has no re-tag API, so one rate-limit error leaves a
document permanently untagged. papra-curator owns that pipeline instead:

- **Retries** failed model calls, up to a configurable cap.
- **Re-runs** any stage after you improve a prompt or a tag description: bump
  its `prompt_version` and the next sweep picks every document up again.
- **Decides tags and filename in one model call**, so both reflect the same
  reading of the document: `scan_0043.pdf` becomes
  `2024-10-26_enel_bolletta-luce_ottobre.pdf`. Papra keeps the original name,
  so a rename is always revertible.
- **Files flights** (optional): documents tagged as travel get a second model
  call that extracts flight segments into
  [AirTrail](https://github.com/johanohly/AirTrail).

## How it works

```
document:created webhook ──► queue ──► [ tag + rename ]   one model call
                                              │
                                   travel tag applied?
                                              │
                                              ▼
                                        [ flights ]       second model call
                                              │
                                              ▼
                                          AirTrail
```

- One model call per document (Mistral, structured output). The second call
  happens only for documents tagged with one of your travel tags.
- Papra's SQLite is read **read-only**; every write goes through Papra's HTTP
  API, so Papra's schema and full-text index stay its own business.
- Its own state DB (a SQLite file) records every decision per document and
  stage, which makes runs idempotent and re-runs explicit. **Back that file
  up** — losing it means paying the model to make the same decisions again.
- **No model call happens unless you set `spend = true`** — see
  [Spending](#spending).

## Setup

**1. Create a Papra API key** (Settings → API keys) with `documents:update`,
`tags:read`, `tags:update` — and `tags:create` only if you enable
`allow_new_tags`.

**2. Add the service** next to Papra:

```yaml
services:
  papra-curator:
    # Also tagged :MAJOR.MINOR.PATCH and :MAJOR.MINOR — pin one in production.
    image: ghcr.io/jtylab-sh/papra-curator:latest
    restart: unless-stopped
    depends_on: [papra]
    command: ["--serve"]
    environment:
      MISTRAL_API_KEY: ${MISTRAL_API_KEY}
      PAPRA_API_KEY: ${PAPRA_API_KEY}
      PAPRA_WEBHOOK_SECRET: ${PAPRA_WEBHOOK_SECRET}
      PAPRA_ORGANIZATION_ID: ${PAPRA_ORGANIZATION_ID} # from Papra's URL
      PAPRA_API_URL: http://papra:1221
      PAPRA_DB_PATH: /papra-db/db.sqlite
    volumes:
      - ./curator/config.toml:/app/config.toml:ro
      - ./papra-data/db:/papra-db:ro # Papra's app-data db directory
      - ./curator/state:/state # this service's own DB
```

The state directory must be writable by uid 1000:
`mkdir -p curator/state && chown 1000:1000 curator/state`.

**3. Configure.** Copy
[`config.example.toml`](config.example.toml) to `curator/config.toml`; every
option is documented inline. The defaults are safe: no spending, renames only
proposed, flights off, no periodic sweep. Identity and hostnames come from the
environment, so the file itself contains nothing personal.

**4. Seed your tags first.** Create your tags in Papra **with descriptions** —
the model reads both, and descriptions are what make the difference. With
`allow_new_tags = false` (the default) the vocabulary is enforced in the JSON
schema, so the model cannot invent a tag.

**5. First run:**

```bash
# Set spend = true in config.toml first. Costs 5 model calls; changes nothing.
docker compose run --rm papra-curator --once --limit 5 --dry-run
```

When the proposals look right, drop `--dry-run` and raise `--limit`; once
confident, set `renaming.dry_run = false` and apply the stored proposals with
`--apply-renames`.

**6. Turn off Papra's native tagging**, or both systems tag every new document:

```yaml
AI_IS_ENABLED: "false"
AUTO_TAGGING_ENABLED: "false"
```

## Commands

| Command                                    | Model calls               |
| ------------------------------------------ | ------------------------- |
| `--serve`                                  | one per document received |
| `--once [--limit N] [--dry-run] [--force]` | one per document          |
| `--doc <id> [--dry-run] [--force]`         | one per document          |
| `--apply-renames [--limit N] [--dry-run]`  | **none**                  |

- `--force` re-runs stages already recorded done.
- `--apply-renames` writes rename proposals stored by earlier runs (e.g. while
  `renaming.dry_run` was on), so names already decided are never paid for twice.

## Spending

Model calls cost money, so they are off by default:

```toml
[model]
spend = false # the default
```

While `spend` is false, `--once` and `--doc` refuse to start and say why;
`--serve` stays up but skips every document it receives, recording nothing.
Nothing is lost: set `spend = true` and the next `--once` sweep picks the
skipped documents up.

- `--dry-run` is **not** free. It asks the model and then discards the answer,
  costing exactly as much as a real run. `--limit N` is the cost bound.
- The periodic sweep (`[trigger] reconcile_interval_seconds`) is off by default
  and never runs at startup: on a fresh state DB it would be a full-archive
  backfill, one model call per document.

## Webhook mode

`--serve` listens for Papra's `document:created` webhook (port `8099` by
default).

- Papra refuses to deliver to private addresses unless its own container sets
  `WEBHOOK_URL_ALLOWED_HOSTNAMES=papra-curator` — dropped deliveries produce
  **no error on this side**.
- `PAPRA_WEBHOOK_SECRET` is required and unsigned requests are rejected. Set
  the same secret on the webhook in Papra's UI.
- Deliveries are not guaranteed (a restart loses queued events), so run
  `--once` to catch up when needed.

## The flights handler

Off by default. Requires a running AirTrail plus `AIRTRAIL_URL`,
`AIRTRAIL_KEY` and `AIRTRAIL_USER_ID` in the environment. When a document
carries one of `[handlers.flights] tags` — your travel tags, no default — a
second model call extracts flight segments and files the ones AirTrail does not
already have.

Two rules are enforced in code rather than trusted to the model:

- **A flight is filed only when the owner appears in the passenger list.**
  Being the booker or addressee is not enough — flights booked for family are
  still addressed to the account owner. List every spelling airlines print,
  pipe-separated (names contain commas):

  ```bash
  AIRTRAIL_OWNER_NAMES="Jane Doe|DOE/JANE|DOE, JANE"
  ```

- **Duplicates are keyed on (date, origin, destination), never flight number**
  — codeshares give one flight several numbers. The same number within ±2 days
  of an existing flight is skipped for review instead of filed, because a model
  reading an overnight itinerary routinely slips the date by a day.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests and releases.

> Written by an AI agent (Claude); reviewed and run in production by a human.

## License

MIT
