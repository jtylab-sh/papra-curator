/**
 * The pipeline: one document in, tags + a proposed name out, and for travel
 * documents only, flights into AirTrail.
 *
 *     document  ->  [tag + rename]  one model call
 *                        |
 *          tags include `viaggi`?  ->  [flights]  second call  ->  AirTrail
 *
 * `reconcile` deliberately does NOT run on its own. An earlier version swept on
 * every container start, and because a cold state DB means "nothing is done
 * yet", starting the container tagged the entire archive — one model call per
 * document. Sweeps are now something you ask for.
 */

import type { Config, Stage } from "./config.ts";
import { catalogueSchema, cataloguePrompt, type CatalogueAnswer } from "./catalogue.ts";
import { handleFlights } from "./flights.ts";
import { composeName, splitExtension, NAME_FIELDS } from "./naming.ts";
import type { Document } from "./papra.ts";
import type { Ports } from "./ports.ts";
import type { State } from "./state.ts";

export interface RunOptions {
  dryRun?: boolean;
  force?: boolean;
  ownerUserId?: string;
}

export interface CatalogueResult {
  applied: string[];
  proposed: string | null;
}

export async function runTaggingAndRename(
  config: Config,
  state: State,
  ports: Ports,
  doc: Document,
  options: RunOptions,
): Promise<CatalogueResult> {
  const dryRun = options.dryRun ?? false;
  const tags = ports.listTags();
  const idByName = new Map(tags.map((tag) => [tag.name, tag.id]));

  const answer: CatalogueAnswer = await ports.askModel(
    "catalogue",
    cataloguePrompt(config, tags),
    `Document name: ${doc.originalName || doc.name}\n\n${doc.content.slice(0, config.papra.contentLimit)}`,
    catalogueSchema(tags.map((tag) => tag.name), config.tagging.allowNewTags),
  );

  const applied: string[] = [];
  if (config.tagging.enabled) {
    const chosen = [...new Set(answer?.tags ?? [])].slice(0, config.tagging.maxTags);
    const already = new Set(ports.documentTags(doc.id));

    for (const tagName of chosen) {
      if (already.has(tagName)) {
        applied.push(tagName);
        continue;
      }
      let tagId = idByName.get(tagName);
      if (tagId === undefined) {
        // The model ignored the enum. Drop the tag rather than create it —
        // an unconstrained vocabulary is how per-document facts become tags.
        if (!config.tagging.allowNewTags) continue;
        if (dryRun) {
          applied.push(tagName);
          continue;
        }
        const created = await ports.createTag(tagName);
        if (!created) continue;
        tagId = created;
      }
      if (!dryRun) await ports.applyTag(doc.id, tagId);
      applied.push(tagName);
    }
    state.setStage(doc.id, "tagging", "done", config.tagging.promptVersion, {
      result: { tags: applied },
      dryRun,
    });
  }

  let proposed: string | null = null;
  if (config.renaming.enabled) {
    const fields = Object.fromEntries(
      NAME_FIELDS.map((key) => [key, (answer as any)?.[key] ?? ""]),
    );
    proposed = composeName(config, fields, splitExtension(doc.originalName || doc.name));

    const renameDry = dryRun || config.renaming.dryRun;
    if (proposed && proposed !== doc.name && !renameDry) {
      await ports.renameDocument(doc.id, proposed);
    }
    // Recorded even when skipped, and the proposal is stored: `--apply-renames`
    // can then write these through later with no further model call.
    state.setStage(doc.id, "renaming", renameDry ? "skipped" : "done", config.renaming.promptVersion, {
      result: { from: doc.name, to: proposed, applied: !renameDry },
      dryRun,
    });
  }

  return { applied, proposed };
}

export async function processDocument(
  config: Config,
  state: State,
  ports: Ports,
  docId: string,
  doc: Document | null,
  options: RunOptions = {},
): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;

  if (doc === null) {
    ports.log(`  ${docId}: not found or deleted`);
    return;
  }
  if (!doc.content.trim()) {
    // Papra extracts text asynchronously; an empty content column means it has
    // not finished, not that the document is empty.
    ports.log(`  ${doc.name.slice(0, 50)}: no extracted content yet, leaving for the next sweep`);
    return;
  }
  if (!dryRun) state.recordDocument(doc.id, doc.content, doc.originalName);

  const maxAttempts = config.model.maxAttempts;
  const catalogueStages: Stage[] = [];
  if (config.tagging.enabled) catalogueStages.push("tagging");
  if (config.renaming.enabled) catalogueStages.push("renaming");
  const needsCatalogue =
    force ||
    catalogueStages.some((stage) =>
      state.stageNeedsRun(doc.id, stage, config[stage].promptVersion, maxAttempts),
    );

  let applied = ports.documentTags(doc.id);
  if (needsCatalogue) {
    try {
      const result = await runTaggingAndRename(config, state, ports, doc, options);
      applied = result.applied;
      ports.log(
        `  ${doc.name.slice(0, 44).padEnd(46)} tags=${applied.join(",") || "-"}  name=${result.proposed ?? "-"}`,
      );
    } catch (error) {
      const message = String((error as Error).message ?? error).slice(0, 400);
      for (const stage of catalogueStages) {
        state.setStage(doc.id, stage, "error", config[stage].promptVersion, {
          error: message,
          dryRun,
        });
      }
      ports.log(`  ! ${doc.name.slice(0, 44)}: catalogue failed: ${message}`);
      return;
    }
  }

  // Second model call only for documents the tags say are travel. This gate is
  // the cost control: everything else stops here having used exactly one call.
  if (!config.flights.enabled) return;
  const wanted = new Set(config.flights.tags.map((tag) => tag.toLowerCase()));
  if (!applied.some((tag) => wanted.has(tag.toLowerCase()))) return;
  if (!force && !state.stageNeedsRun(doc.id, "flights", config.flights.promptVersion, maxAttempts)) {
    return;
  }

  try {
    const added = await handleFlights(
      config,
      ports,
      doc,
      options.ownerUserId ?? "",
      dryRun || config.flights.dryRun,
    );
    state.setStage(doc.id, "flights", "done", config.flights.promptVersion, {
      result: { added },
      dryRun,
    });
    if (added.length > 0) {
      ports.log(`    flights: ${added.join(", ")}`);
      if (config.notify.onSuccess) {
        await ports.notify(`AirTrail: ${added.length} flight(s)`, added.join("\n"));
      }
    }
  } catch (error) {
    const message = String((error as Error).message ?? error).slice(0, 400);
    state.setStage(doc.id, "flights", "error", config.flights.promptVersion, {
      error: message,
      dryRun,
    });
    ports.log(`  ! ${doc.name.slice(0, 44)}: flights failed: ${message}`);
  }
}

/**
 * Apply rename proposals already stored in the state DB. Zero model calls.
 *
 * This exists because turning `[renaming] dry_run` off would otherwise apply
 * nothing: those stages are recorded `skipped` at the current prompt version, so
 * `stageNeedsRun` correctly considers them settled. Bumping the version to force
 * a re-run would re-pay the model for names it already decided.
 */
export async function applyPendingRenames(
  config: Config,
  state: State,
  ports: Ports,
  options: { dryRun?: boolean; limit?: number } = {},
): Promise<number> {
  const dryRun = options.dryRun ?? false;
  let proposals = state.pendingRenames();
  if (options.limit && options.limit > 0) proposals = proposals.slice(0, options.limit);
  ports.log(`${proposals.length} stored rename(s) to apply${dryRun ? " (dry run)" : ""}`);

  let applied = 0;
  for (const proposal of proposals) {
    try {
      if (!dryRun) {
        await ports.renameDocument(proposal.docId, proposal.to);
        state.setStage(proposal.docId, "renaming", "done", config.renaming.promptVersion, {
          result: { from: proposal.from, to: proposal.to, applied: true },
        });
      }
      ports.log(`  ${dryRun ? "would rename" : "renamed"}: ${proposal.from} -> ${proposal.to}`);
      applied++;
    } catch (error) {
      ports.log(`  ! ${proposal.docId}: rename failed: ${(error as Error).message}`);
    }
  }
  return applied;
}
