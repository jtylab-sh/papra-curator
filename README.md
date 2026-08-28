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
  `2024-10-26_enel_bolletta-luce_ottobre.pdf`. The uploaded filename is
  preserved in an `Original name` custom property (created automatically), so
  a rename never loses information.
- **Files flights** (optional): documents tagged as travel get a second model
  call that extracts flight segments into
  [AirTrail](https://github.com/johanohly/AirTrail).

It works on **existing documents** (batch backfill over the whole archive) and
on **new ones** (webhook, as they arrive) — same pipeline, see
[Usage](#usage).

## How it works

```
document:updated webhook ─┐
                          ├──► queue ──► [ tag + rename ]   one model call
--once sweep (backfill) ──┘                     │
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
  stage. That makes every run **idempotent**: a document already processed at
  the current prompt version costs nothing, so sweeps are safe to repeat and
  backfills can run in batches. **Back that file up** — losing it means paying
  the model to make the same decisions again.
- **No model call happens unless you set `spend = true`** — see
  [Spending](#spending).
- Notifications via [ntfy](https://ntfy.sh) are optional, with one switch per
  event (tagged, renamed, flights filed, errors) in `config.toml`.

## Setup

**1. Create a Papra API key** (Settings → API keys) with `documents:update`,
`tags:read`, `tags:update`, `custom-properties:read`,
`custom-properties:create`, `custom-properties:update` — and `tags:create`
only if you enable `allow_new_tags`.

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
    volumes:
      - ./curator/config.toml:/app/config.toml:ro
      - ./papra-data/db:/papra-db:ro # Papra's app-data db directory
      - ./curator/state:/state # this service's own DB
```

The state directory must be writable by uid 1000:
`mkdir -p curator/state && chown 1000:1000 curator/state`.

**3. Configure.** Copy
[`config.example.toml`](config.example.toml) to `curator/config.toml`; every
option is documented inline. Fill in `[papra]`: the database path, the API URL
and the organization id (it is in Papra's URL). The defaults are safe: no
spending, renames only proposed, flights off, no periodic sweep. The file never
holds secrets — those stay in the environment.

**4. Seed your tags.** Create your tags in Papra **with descriptions** — the
model reads both, and descriptions are what make the difference. With
`allow_new_tags = false` (the default) the vocabulary is enforced in the JSON
schema, so the model cannot invent a tag.

**5. Turn off Papra's native tagging**, or both systems tag every new document:

```yaml
AI_IS_ENABLED: "false"
AUTO_TAGGING_ENABLED: "false"
```

## Usage

### Existing documents (backfill)

A document whose extracted text later changes (late OCR, a content repair
through Papra's API) is detected by content hash and re-runs every stage on
the next webhook or sweep. Re-runs only ever ADD tags, never remove them.

Sweeps are idempotent — already-processed documents cost nothing — so backfill
in batches and repeat the same command freely. `--limit N` counts documents
that still need work: settled documents are skipped past without consuming the
budget, so repeating `--once --limit 50` advances the backlog by 50 each run.

```bash
# 1. Set spend = true in config.toml (see Spending).

# 2. Preview a small batch: 5 model calls, changes nothing in Papra.
docker compose run --rm papra-curator --once --limit 5 --dry-run

# 3. Proposals look right? Run for real, in batches.
#    Tags apply immediately. Renames are only STORED while
#    renaming.dry_run = true (the default).
docker compose run --rm papra-curator --once --limit 50
docker compose run --rm papra-curator --once            # the rest

# 4. Review the stored rename proposals in the run output, then set
#    renaming.dry_run = false and write them — zero model calls:
docker compose run --rm papra-curator --apply-renames
```

From then on renames apply directly on every run. One document at a time:
`--doc <id>` (the id is in the document's Papra URL).

**After improving a prompt or a tag description**: bump that stage's
`prompt_version` in `config.toml` and sweep again — exactly that stage re-runs,
for every document. One model call per document, so treat it as a spend
decision.

### New documents (webhook)

The `--serve` container from the compose file above listens on port `8099`. In
Papra (Settings → Webhooks) create a webhook for the `document:updated` event:

- URL: `http://papra-curator:8099`
- Secret: the same value as `PAPRA_WEBHOOK_SECRET` — unsigned requests are
  rejected.

And on the **Papra** container:

```yaml
# Papra refuses webhook URLs that resolve to private addresses by default, and
# drops those deliveries with no error visible on the curator side.
WEBHOOK_URL_ALLOWED_HOSTNAMES: papra-curator
```

Papra extracts text asynchronously and fires `document:updated` when the text
is written, so a document is processed the moment it is readable. Updates that
change anything else (renames — including this service's own — notes, dates)
are ignored. A document whose extraction produces no text is never tagged.
Deliveries lost to a Papra restart are picked up by the next sweep — so run
`--once` now and then, or set `[trigger] reconcile_interval_seconds` once the
backfill is done.

## Commands

| Command                                    | Model calls               |
| ------------------------------------------ | ------------------------- |
| `--serve`                                  | one per document received |
| `--once [--limit N] [--dry-run] [--force]` | one per document          |
| `--doc <id> [--dry-run] [--force]`         | one per document          |
| `--apply-renames [--limit N] [--dry-run]`  | **none**                  |

- `--limit N` bounds documents that actually need work; settled documents do
  not count against it.
- `--force` re-runs stages already recorded done.
- `--apply-renames` writes rename proposals stored by earlier runs, so names
  already decided are never paid for twice.

## Configuration reference

Everything lives in `config.toml` ([template](config.example.toml)) except
secrets and runtime paths, which come from the environment — no value has two
sources.

### Environment variables

| Variable               | Required            | Purpose                                                |
| ---------------------- | ------------------- | ------------------------------------------------------ |
| `MISTRAL_API_KEY`      | when `spend = true` | model API key                                          |
| `PAPRA_API_KEY`        | always              | Papra API key (writes; permissions in [Setup](#setup)) |
| `PAPRA_WEBHOOK_SECRET` | for `--serve`       | webhook HMAC secret, same value as in Papra's UI       |
| `AIRTRAIL_KEY`         | when flights on     | AirTrail API key                                       |
| `DATABASE_URL`         | optional            | state DB location (default `file:/state/curator.db`)   |
| `CURATOR_CONFIG`       | optional            | config path (default `/app/config.toml`)               |

### config.toml

| Key                                      | Default              | Meaning                                                                 |
| ---------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `[papra] db_path`                        | — (required)         | Papra's SQLite file, read-only                                          |
| `[papra] api_url`                        | — (required)         | Papra base URL                                                          |
| `[papra] organization_id`                | — (required)         | Papra organization id                                                   |
| `[papra] content_limit`                  | `30000`              | characters of OCR text sent to the model                                |
| `[trigger] listen_host`                  | `"0.0.0.0"`          | webhook bind address (`--serve`)                                        |
| `[trigger] listen_port`                  | `8099`               | webhook port                                                            |
| `[trigger] reconcile_interval_seconds`   | `0`                  | periodic sweep; `0` = off, first sweep one interval after start         |
| `[model] spend`                          | `false`              | master switch: no model call while false                                |
| `[model] name`                           | — (required)         | Mistral model, e.g. `mistral-medium-latest`                             |
| `[model] temperature`                    | `0.0`                | sampling temperature                                                    |
| `[model] max_attempts`                   | `3`                  | retries per stage before a document is parked with an error             |
| `[tagging] enabled`                      | `true`               | tag documents                                                           |
| `[tagging] prompt_version`               | — (required)         | bump to re-tag everything on the next sweep                             |
| `[tagging] max_tags`                     | `8`                  | most tags applied per document                                          |
| `[tagging] allow_new_tags`               | `false`              | let the model create tags (else vocabulary enforced in the schema)      |
| `[renaming] enabled`                     | `true`               | rename documents                                                        |
| `[renaming] prompt_version`              | — (required)         | bump to re-decide every name on the next sweep                          |
| `[renaming] template`                    | — (required)         | e.g. `"{date}_{party}_{doctype}_{detail}"`; empty fields collapse       |
| `[renaming] slugify_fields`              | `true`               | lowercase, ASCII-fold, non-alphanumerics to hyphens                     |
| `[renaming] max_length`                  | `120`                | name length cap, extension excluded                                     |
| `[renaming] original_name_property`      | `"Original name"`    | custom property that keeps the uploaded filename; `""` disables         |
| `[renaming] dry_run`                     | `true`               | store proposals instead of renaming; apply later with `--apply-renames` |
| `[handlers.flights] enabled`             | `false`              | file flights into AirTrail                                              |
| `[handlers.flights] prompt_version`      | — (required)         | bump to re-extract flights on the next sweep                            |
| `[handlers.flights] tags`                | — (required when on) | your travel tag(s); the gate for the second model call                  |
| `[handlers.flights] airtrail_url`        | — (required when on) | AirTrail base URL                                                       |
| `[handlers.flights] owner_user_id`       | — (required when on) | AirTrail user the flights are filed under                               |
| `[handlers.flights] owner_names`         | — (required when on) | owner spellings; a flight is filed only when one is a passenger         |
| `[handlers.flights] near_duplicate_days` | `2`                  | same flight number within ± this many days is skipped for review        |
| `[handlers.flights] dry_run`             | `false`              | extract and log, but do not push to AirTrail                            |
| `[notify] url` / `[notify] topic`        | `""`                 | ntfy server/topic; empty topic disables all notifications               |
| `[notify] on_tagged`                     | `false`              | include applied tags in the document's push                             |
| `[notify] on_renamed`                    | `false`              | include the rename in the document's push (incl. `--apply-renames`)     |
| `[notify] on_flights`                    | `true`               | include filed flights in the document's push                            |
| `[notify] on_error`                      | `true`               | push when a stage or sweep fails (high priority)                        |
| `[notify] on_sweep`                      | `true`               | one summary push per sweep that did anything                            |

A processed document sends at most **one** push, listing everything done to it;
the `on_*` switches choose which lines appear, not separate messages. Sweeps
(`--once` and the periodic reconcile) suppress the per-document pushes and send
one summary instead.

## Spending

Model calls cost money, so they are off by default:

```toml
[model]
spend = false # the default
```

While `spend` is false, `--once` and `--doc` refuse to start and say why;
`--serve` stays up but skips every document it receives, recording nothing.
Nothing is lost: set `spend = true` and the next sweep picks the skipped
documents up.

- `--dry-run` is **not** free. It asks the model and then discards the answer,
  costing exactly as much as a real run. `--limit N` is the cost bound.
- The periodic sweep (`[trigger] reconcile_interval_seconds`) is off by default
  and never runs at startup: on a fresh state DB it would be a full-archive
  backfill, one model call per document.

## The flights handler

Off by default. Requires a running AirTrail and `AIRTRAIL_KEY` in the
environment; the URL, the user id and the owner names live under
`[handlers.flights]`. When a document
carries one of `[handlers.flights] tags` — your travel tags, no default — a
second model call extracts flight segments and files the ones AirTrail does not
already have.

Two rules are enforced in code rather than trusted to the model:

- **A flight is filed only when the owner appears in the passenger list.**
  Being the booker or addressee is not enough — flights booked for family are
  still addressed to the account owner. List every spelling airlines print:

  ```toml
  owner_names = ["Jane Doe", "DOE/JANE", "DOE, JANE"]
  ```

- **Duplicates are keyed on (date, origin, destination), never flight number**
  — codeshares give one flight several numbers. The same number within ±2 days
  of an existing flight is skipped for review instead of filed, because a model
  reading an overnight itinerary routinely slips the date by a day.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests and releases.

> Written by an AI agent (Claude); reviewed by a human.

## License

MIT
