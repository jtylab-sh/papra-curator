# papra-curator

Tagging, renaming and downstream handlers for [Papra](https://papra.app), owned
by a service outside Papra so they can be retried, re-run and audited.

> Written by an AI agent (Claude), reviewed and run in production by a human.

---

## Why this exists

Papra has native LLM auto-tagging, and it works. Three things it structurally
cannot do:

| | Papra | papra-curator |
|---|---|---|
| Retry a failed tagging call | No — `maxRetries=0`, one attempt | Yes, to a configurable cap |
| Re-tag after you improve a prompt or tag description | No, and no re-tag API | Yes — bump `prompt_version` |
| Decide tags and filename together | Tags only | One model call returns both |

The retry gap is the sharp one. Papra fires exactly one tagging request per
document with no retries, so a single HTTP 429 leaves that document
**permanently untagged**, with no API to fix it. On a bulk import against a
rate-limited model, that is not hypothetical.

What this service adds:

- **Tags + filename in one model call**, so the two always describe the same
  reading of the document.
- **Content-based renaming**: `scan_0043.pdf` becomes
  `2024-10-26_enel_bolletta-luce_ottobre.pdf`. The original is never lost —
  Papra keeps it in its own `original_name` column, which the rename API does
  not touch.
- **Per-document, per-stage state**, so re-runs are cheap and idempotent.
- **Pluggable handlers** gated on tags. One ships: `flights`, which files
  boarding passes and e-tickets into [AirTrail](https://github.com/johanohly/AirTrail).

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

Reads come straight from Papra's SQLite, opened **read-only** — safe alongside
Papra because it runs `journal_mode=delete`, so a reader needs no lock files.
Writes go through Papra's **HTTP API**, never the database, since the schema is
Papra's migration domain and writing behind its back would leave its full-text
index stale.

The tag gate is the cost control: the second model call only happens for
documents the first call tagged as travel, so a typical archive — where ~95% of
documents are not travel — costs exactly one call per document.

### No dependencies, no build

Node 24 strips TypeScript types at load and ships `node:sqlite`, so this runs
`.ts` files directly with **zero runtime dependencies and no build step**. No
`node_modules` in the image, no compile output. The code you audit is
byte-for-byte the code that runs — which matters for something holding an API
key and reading your entire document archive.

`package.json` exists only for dev tooling: `typescript` and `@types/node`, used
by `npm run typecheck`. Neither is installed in the image, and neither is needed
to run the service.

---

## Install

### 1. A Papra API key

In Papra: **Settings → API keys → Create**. It needs:

- `documents:update` — to rename
- `tags:read` and `tags:update` — to apply tags
- `tags:create` — only if you set `allow_new_tags = true`

### 2. Add the service

```yaml
services:
  papra-curator:
    image: ghcr.io/jtylab-sh/papra-curator:latest
    container_name: papra-curator
    # Never started by `docker compose up -d`. See "Spending".
    profiles: ["manual"]
    restart: "no"
    depends_on: [papra]
    environment:
      # --- secrets ---
      MISTRAL_API_KEY: ${MISTRAL_API_KEY}
      PAPRA_API_KEY: ${PAPRA_API_KEY}
      PAPRA_WEBHOOK_SECRET: ${PAPRA_WEBHOOK_SECRET}   # only needed for --serve
      # --- identity ---
      PAPRA_ORGANIZATION_ID: ${PAPRA_ORGANIZATION_ID}
      PAPRA_API_URL: http://papra:1221
      PAPRA_DB_PATH: /papra-db/db.sqlite
    volumes:
      - ./curator/config.toml:/app/config.toml:ro
      - ./papra-data/db:/papra-db:ro    # Papra's app-data db directory
      - ./curator/state:/state          # this service's tracking DB
```

`PAPRA_ORGANIZATION_ID` is in Papra's URL:
`/organizations/<this>/documents`.

The state directory must be writable by the container (uid 1000 by default):
`mkdir -p curator/state && chown 1000:1000 curator/state`.

### 3. Configure

```bash
curl -O https://raw.githubusercontent.com/jtylab-sh/papra-curator/main/config.example.toml
mv config.example.toml curator/config.toml
```

Every knob is documented inline. The defaults are deliberately timid:
`renaming.dry_run = true`, flights disabled, no periodic sweep.

Identity and hostnames come from the environment, so `config.toml` holds only
behaviour and contains nothing personal.

### 4. Seed your tags first

**Do this before processing anything.** With an empty or vague tag vocabulary an
LLM invents per-document facts as tags — real output from an early run:

```
Real Estate Price: €295,000
```

Create your tags in Papra **with descriptions** — the model reads the name *and*
the description, and descriptions are what make the difference. With
`allow_new_tags = false` (the default) the vocabulary is enforced in the JSON
schema, not merely requested in the prompt, so the model cannot invent one.

### 5. First run

```bash
# Free. Shows what the state DB knows; makes no model call.
docker compose run --rm papra-curator --apply-renames --dry-run

# Costs 5 model calls. Read the proposed tags and names before going further.
docker compose run --rm papra-curator --once --spend --limit 5 --dry-run
```

`--dry-run` decides everything and changes nothing — but it is **not free**: it
asks the model and then declines to apply the answer, costing exactly as much as
a real run. `--limit` is the spend control.

When the proposals look right, drop `--dry-run`, raise `--limit`, and once
you're confident set `renaming.dry_run = false` in the config.

### 6. Turn off Papra's native tagging

Otherwise both systems tag every new document:

```yaml
AI_IS_ENABLED: "false"
AUTO_TAGGING_ENABLED: "false"
```

---

## Commands

| Command | Model calls |
|---|---|
| `--apply-renames [--limit N] [--dry-run]` | **none** |
| `--once --spend [--limit N] [--dry-run] [--force]` | one per document |
| `--doc <id> --spend [--dry-run] [--force]` | one per document |
| `--serve --spend` | one per document received |

- `--spend` is required by every mode that calls the model.
- `--force` re-runs stages already recorded done.
- `--apply-renames` writes rename proposals already computed and stored by an
  earlier run. It exists so that turning `renaming.dry_run` off does not mean
  paying the model a second time for names it already decided.

---

## Spending

Every model call is off unless you ask for it, on that invocation:

- **`--spend` enables it.** Without the flag no model call happens — enforced at
  a single choke point every call passes through, so it covers sweeps, webhooks,
  dry runs and any handler added later. It is a flag rather than a config key or
  an environment variable on purpose: a flag has to be typed every time, whereas
  a setting gets turned on once and then forgotten.
- **`--limit N` bounds it** to N documents. This is the spend control on
  `--once`.
- **`--apply-renames` never spends** at all; it writes names an earlier run
  already decided.
- **`--dry-run` does not disable spending.** It asks the model and then declines
  to apply the answer, costing exactly as much as a real run.

Two more defaults keep the service from spending on its own:

- **`profiles: ["manual"]`** — `docker compose up -d` does not start it.
- **No default action** — no arguments prints usage and exits non-zero, so a
  container started by accident does nothing.

To disable spending entirely, stop passing `--spend`. `reconcile_interval_seconds`
defaults to `0` (no periodic sweep), and even when set the first sweep is one
full interval out rather than at startup.

---

## Webhook mode

`--serve` accepts Papra's `document:created` webhook. Two requirements:

**Papra must be allowed to reach this container.** Papra blocks webhook URLs
pointing at private addresses by default, and drops the delivery with no error
visible on this side:

```yaml
WEBHOOK_URL_ALLOWED_HOSTNAMES: papra-curator
```

**A signing secret is mandatory.** The endpoint accepts POSTs from anything that
can reach the port, so the HMAC check is the only thing between Papra and the
network. `--serve` refuses to start without `PAPRA_WEBHOOK_SECRET`, rather than
silently accepting unsigned requests. Set the same value on the webhook in
Papra's UI.

Deliveries are not guaranteed — a restart or exhausted retries loses the event —
so `--once` remains the way to catch up.

---

## The flights handler

Disabled by default; it is useless without AirTrail. Enabling it requires
`[handlers.flights] tags` — the tag or tags that mark a travel document, in your
own vocabulary, with no default. When a document is tagged with one of them, a
second model call extracts flight segments and files the missing ones.

Two rules are enforced in code rather than trusted to the model:

**The owner must be in the passenger list.** Flights booked for family are
addressed to the account holder but flown by someone else. The model reports
whether the owner is aboard, and the code independently re-verifies that exactly
one passenger carries the owner's user id before anything is sent. Set every
spelling airlines print:

```bash
AIRTRAIL_OWNER_NAMES="Jane Doe|DOE/JANE|DOE, JANE"
```

Pipe-separated, because the names airlines print contain commas. Quote it in
`.env` — `|` is a shell operator.

**Deduplication keys on `(date, origin, destination)`, never on flight number.**
One physical flight arrives under codeshare numbers (`IB6660` == `LA2485`) and
carrier variants (Wizz `W4` vs `W6`). A separate guard catches the other
direction: a model reading a ticket routinely slips the date by a day on
overnight connections, so a flight number already logged within ±2 days is
flagged for review instead of duplicated.

---

## Development

```bash
node --test 'src/*.test.ts'   # no install needed
npm ci && npm run typecheck   # dev-only tooling
```

60 tests, no network, no Papra, no config file — the outside world is behind one
`Ports` interface and the state DB runs in memory. They are weighted toward
invariants whose failure costs money or data rather than toward coverage:

- a document the owner did not fly must never reach AirTrail
- a non-travel document must never cost a second model call
- a dry run must change nothing and persist nothing
- an unsigned webhook must be rejected
- a model must not be able to invent a tag, or emit a filename that is a path
- a sweep must never start on its own

## License

MIT
