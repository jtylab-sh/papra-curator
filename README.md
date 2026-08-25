# papra-curator

Tagging, renaming and downstream handlers for [Papra](https://papra.app), owned
by a service outside Papra so they can be retried, re-run and audited.

> Written by an AI agent (Claude), reviewed and run in production by a human.

## Why this exists

Papra has native LLM auto-tagging. Three things it structurally cannot do:

|                                                      | Papra                            | papra-curator               |
| ---------------------------------------------------- | -------------------------------- | --------------------------- |
| Retry a failed tagging call                          | No — `maxRetries=0`, one attempt | Yes, to a configurable cap  |
| Re-tag after you improve a prompt or tag description | No, and no re-tag API            | Yes — bump `prompt_version` |
| Decide tags and filename together                    | Tags only                        | One model call returns both |

The retry gap is the sharp one: one HTTP 429 leaves a document **permanently
untagged**, with no API to fix it.

On top of that, **content-based renaming** — `scan_0043.pdf` becomes
`2024-10-26_enel_bolletta-luce_ottobre.pdf`. Papra keeps the original in its own
`original_name` column, which the rename API does not touch.

## How it works

```
document:created webhook ──► queue ──► [ tag + rename ]  ← one model call
                                              │
                         tags include a flights tag?
                                              │
                                              ▼
                                        [ flights ]      ← second model call
                                              │
                                              ▼
                                          AirTrail
```

The tag gate is the cost control: the second call only happens for documents the
first call tagged as travel, so a typical archive costs one call per document.

### Two databases

**Papra's**, read **only** — and read directly from its SQLite file rather than
over the API, because that is the cheap way to sweep an archive. Safe alongside a
running Papra because it uses `journal_mode=delete`, so a reader needs no lock
files. Every **write** goes through Papra's **HTTP API**, never its database:
writing behind its back would leave its full-text index stale.

**Ours**, a SQLite file in the state volume — one row per document and one per
(document, stage), recording what has already been decided and paid for. **Back
it up**: losing it means paying the model to decide the same things again.
Schema changes are applied automatically when the container starts, so upgrading
the image needs no manual step.

## Install

### 1. A Papra API key

**Settings → API keys → Create**, with `documents:update`, `tags:read`,
`tags:update`, and `tags:create` only if you set `allow_new_tags = true`.

### 2. Add the service

```yaml
services:
  papra-curator:
    # Also tagged :MAJOR.MINOR.PATCH and :MAJOR.MINOR — pin one in production,
    # since :latest moves on every push to main.
    image: ghcr.io/jtylab-sh/papra-curator:latest
    container_name: papra-curator
    restart: unless-stopped
    depends_on: [papra]
    command: ["--serve"]
    environment:
      # --- secrets ---
      MISTRAL_API_KEY: ${MISTRAL_API_KEY}
      PAPRA_API_KEY: ${PAPRA_API_KEY}
      PAPRA_WEBHOOK_SECRET: ${PAPRA_WEBHOOK_SECRET} # required by --serve
      # --- identity ---
      PAPRA_ORGANIZATION_ID: ${PAPRA_ORGANIZATION_ID}
      PAPRA_API_URL: http://papra:1221
      PAPRA_DB_PATH: /papra-db/db.sqlite
    volumes:
      - ./curator/config.toml:/app/config.toml:ro
      - ./papra-data/db:/papra-db:ro # Papra's app-data db directory
      - ./curator/state:/state # this service's tracking DB
```

`PAPRA_ORGANIZATION_ID` is in Papra's URL: `/organizations/<this>/documents`.

The state directory must be writable by the container (uid 1000 by default):
`mkdir -p curator/state && chown 1000:1000 curator/state`.

### 3. Configure

```bash
curl -O https://raw.githubusercontent.com/jtylab-sh/papra-curator/main/config.example.toml
mv config.example.toml curator/config.toml
```

Every knob is documented inline. The defaults are timid: `spend = false`,
`renaming.dry_run = true`, flights disabled, no periodic sweep. Identity and
hostnames come from the environment, so `config.toml` holds only behaviour and
contains nothing personal.

### 4. Seed your tags first

**Do this before processing anything.** With an empty or vague tag vocabulary the
model invents per-document facts as tags. Create your tags in Papra **with
descriptions** — the model reads the name _and_ the description, and descriptions
are what make the difference. With `allow_new_tags = false` (the default) the
vocabulary is enforced in the JSON schema, not merely requested in the prompt, so
the model cannot invent one.

### 5. First run

```bash
# Free: shows what the state DB knows, makes no model call.
docker compose run --rm papra-curator --apply-renames --dry-run

# Costs 5 model calls, and needs spend = true. Read the proposals before going on.
docker compose run --rm papra-curator --once --limit 5 --dry-run
```

When the proposals look right, drop `--dry-run`, raise `--limit`, and once you're
confident set `renaming.dry_run = false`.

### 6. Turn off Papra's native tagging

Otherwise both systems tag every new document:

```yaml
AI_IS_ENABLED: "false"
AUTO_TAGGING_ENABLED: "false"
```

## Commands

| Command                                    | Model calls               |
| ------------------------------------------ | ------------------------- |
| `--apply-renames [--limit N] [--dry-run]`  | **none**                  |
| `--once [--limit N] [--dry-run] [--force]` | one per document          |
| `--doc <id> [--dry-run] [--force]`         | one per document          |
| `--serve`                                  | one per document received |

- `--force` re-runs stages already recorded done.
- `--apply-renames` writes rename proposals a previous run already computed, so
  turning `renaming.dry_run` off does not mean paying for names twice.

## Spending

```toml
[model]
spend = false   # the default
```

While `spend` is false no model call is made at all. `--once` and `--doc` refuse
to run and say why; `--serve` stays up and skips the documents it receives,
recording nothing, so nothing is lost or half-processed. Set it to `true` and the
skipped documents are picked up by the next `--once` sweep — a webhook only fires
once, when the document is created.

`--dry-run` is not a spending control: it asks the model and then declines to
apply the answer, costing exactly as much as a real run. `--apply-renames` is the
only mode that never calls the model. `--limit N` caps one run at N documents.

`reconcile_interval_seconds` defaults to `0` (no periodic sweep), and even when
set the first sweep is one full interval out rather than at startup.

## Webhook mode

`--serve` accepts Papra's `document:created` webhook. Two requirements:

**Papra must be allowed to reach this container.** It blocks webhook URLs
pointing at private addresses by default, and drops the delivery with no error
visible on this side:

```yaml
WEBHOOK_URL_ALLOWED_HOSTNAMES: papra-curator
```

**A signing secret is mandatory.** The endpoint accepts POSTs from anything that
can reach the port, so the HMAC check is the only thing between Papra and the
network. `--serve` refuses to start without `PAPRA_WEBHOOK_SECRET`. Set the same
value on the webhook in Papra's UI.

Deliveries are not guaranteed — a restart or exhausted retries loses the event —
so `--once` remains the way to catch up.

## The flights handler

Disabled by default; it is useless without AirTrail. Enabling it requires
`[handlers.flights] tags`, the tag or tags that mark a travel document, in your
own vocabulary and with no default. When a document is tagged with one of them, a
second model call extracts flight segments and files the missing ones.

Two rules are enforced in code rather than trusted to the model:

**The owner must be in the passenger list.** Flights booked for family are
addressed to the account holder but flown by someone else. The model reports
whether the owner is aboard, and the code re-verifies that exactly one passenger
carries the owner's user id before anything is sent. Set every spelling airlines
print, pipe-separated because those names contain commas:

```bash
AIRTRAIL_OWNER_NAMES="Jane Doe|DOE/JANE|DOE, JANE"
```

Quote it in `.env` — `|` is a shell operator.

**Deduplication keys on `(date, origin, destination)`, never on flight number.**
One physical flight arrives under codeshare numbers (`IB6660` == `LA2485`) and
carrier variants (Wizz `W4` vs `W6`). A second guard catches the other direction:
a model reading a ticket routinely slips the date by a day on overnight
connections, so a flight number already logged within ±2 days is flagged for
review instead of duplicated.

Development and release notes are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
