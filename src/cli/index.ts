/**
 * CLI entry point.
 *
 *   node src/cli/index.ts --once             one reconcile pass, then exit
 *   node src/cli/index.ts --once --limit 5   the same, bounded
 *   node src/cli/index.ts --doc <id>         process a single document
 *   node src/cli/index.ts --apply-renames    stored renames, zero model calls
 *   node src/cli/index.ts --serve            webhook receiver (long-running)
 *
 * No arguments prints usage and exits non-zero: there is no default action.
 * No mode calls the model unless `[model] spend` is true in config.toml.
 *
 * `--dry-run` is NOT free: it asks the model and then declines to apply the
 * answer, costing exactly as much as a real run. `--apply-renames` is the only
 * mode that never calls the model.
 */

import { existsSync } from "node:fs";
import { env, loadConfig, type Config } from "#~/config/index.ts";
import { PapraReader } from "#~/papra/index.ts";
import { createPorts, type Ports } from "#~/ports/index.ts";
import { applyPendingRenames, processDocument } from "#~/pipeline/index.ts";
import { serve } from "#~/server/index.ts";
import { State } from "#~/state/index.ts";

const USAGE = `papra-curator

  --once [--limit N] [--dry-run] [--force]   sweep documents
  --doc <id> [--dry-run] [--force]           process one document
  --apply-renames [--limit N] [--dry-run]    stored renames, no model calls
  --serve                                    run the webhook receiver
  --help

Every mode except --apply-renames calls the model once per document, and needs
spend = true under [model] in config.toml. --dry-run does NOT make a run free:
it asks the model and then declines to apply the answer, so it costs one call
per document just like a real run. --limit bounds how many documents are
processed.`;

interface Args {
  once: boolean;
  serve: boolean;
  applyRenames: boolean;
  doc: string | null;
  limit: number;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  const limitRaw = value("--limit");
  const limit = limitRaw === null ? 0 : Number.parseInt(limitRaw, 10);
  if (limitRaw !== null && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`--limit needs a positive integer, got ${JSON.stringify(limitRaw)}`);
  }
  return {
    once: flag("--once"),
    serve: flag("--serve"),
    applyRenames: flag("--apply-renames"),
    doc: value("--doc"),
    limit,
    dryRun: flag("--dry-run"),
    force: flag("--force"),
    help: flag("--help") || flag("-h"),
  };
}

function requireSecrets(config: Config, needsModel: boolean): void {
  if (needsModel && !env.mistralKey) throw new Error("MISTRAL_API_KEY is not set");
  if (!env.papraApiKey) throw new Error("PAPRA_API_KEY is not set");
  if (!existsSync(config.papra.dbPath)) {
    throw new Error(`${config.papra.dbPath} not found — is the bind mount path absolute?`);
  }
  if (config.flights.enabled && !env.airtrailKey) {
    throw new Error("[handlers.flights] is enabled but AIRTRAIL_KEY is not set");
  }
}

async function reconcile(
  config: Config,
  state: State,
  ports: Ports,
  reader: PapraReader,
  options: { dryRun: boolean; force: boolean; limit: number },
): Promise<void> {
  const documents = reader.documents(options.limit);
  ports.log(
    `reconcile: ${documents.length} document(s) in scope` +
      (options.limit ? ` (limited to ${options.limit})` : "") +
      (options.dryRun ? " — dry run" : ""),
  );
  for (const doc of documents) {
    await processDocument(config, state, ports, doc.id, doc, {
      dryRun: options.dryRun,
      force: options.force,
    });
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const modes = [args.once, args.serve, args.applyRenames, args.doc !== null].filter(Boolean);
  if (args.help || modes.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? 0 : 1;
  }
  if (modes.length > 1) {
    process.stderr.write("choose exactly one of --once, --doc, --apply-renames, --serve\n");
    return 1;
  }

  const config = loadConfig();

  // A one-shot run that could do nothing at all says so and exits, rather than
  // reporting success over an empty sweep. `--serve` is exempt: a daemon that
  // exited here would restart-loop, so it stays up and skips documents until
  // spending is turned on.
  if ((args.once || args.doc !== null) && !config.model.spend) {
    process.stderr.write(
      "refusing to run: this mode calls the model once per document and " +
        "[model] spend is false in config.toml.\n" +
        "Set spend = true to allow it, or use --apply-renames, which never calls the model.\n" +
        "Note: --dry-run still costs a call per document.\n",
    );
    return 1;
  }

  // With spending off nothing reaches the model, so its key is not needed.
  const mayCallModel = !args.applyRenames && config.model.spend;
  requireSecrets(config, mayCallModel);

  const ports = createPorts(
    config,
    {
      mistralKey: env.mistralKey,
      papraApiKey: env.papraApiKey,
      airtrailKey: env.airtrailKey,
    },
    { allowSpend: config.model.spend },
  );
  const reader = new PapraReader(config);
  const state = new State(env.databaseUrl);

  try {
    if (args.applyRenames) {
      await applyPendingRenames(config, state, ports, { dryRun: args.dryRun, limit: args.limit });
      return 0;
    }
    if (args.doc !== null) {
      await processDocument(config, state, ports, args.doc, reader.document(args.doc), {
        dryRun: args.dryRun,
        force: args.force,
      });
      return 0;
    }
    if (args.once) {
      await reconcile(config, state, ports, reader, {
        dryRun: args.dryRun,
        force: args.force,
        limit: args.limit,
      });
      return 0;
    }
    if (!config.model.spend) {
      ports.log("[model] spend is false: documents will be received and skipped, not processed");
    }
    await serve(config, ports, env.webhookSecret, {
      processDocument: (docId) =>
        processDocument(config, state, ports, docId, reader.document(docId)),
      reconcile: () =>
        reconcile(config, state, ports, reader, { dryRun: false, force: false, limit: 0 }),
    });
    return 0;
  } finally {
    await state.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
