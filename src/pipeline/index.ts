/**
 * The pipeline: one document in, tags + a proposed name out, and for travel
 * documents only, flights into AirTrail.
 *
 *     document  ->  [tag + rename]  one model call
 *                        |
 *      tags include a flights tag?  ->  [flights]  second call  ->  AirTrail
 *
 * `reconcile` never runs on its own: a sweep costs one model call per document
 * that is not already recorded done, so it happens only when asked for.
 */

import type { Config, Stage } from "#~/config/index.ts";
import { catalogueSchema, cataloguePrompt, type CatalogueAnswer } from "#~/pipeline/catalogue.ts";
import { handleFlights } from "#~/flights/index.ts";
import { composeName, splitExtension, NAME_FIELDS } from "#~/pipeline/naming.ts";
import type { Document } from "#~/papra/index.ts";
import type { Ports } from "#~/ports/index.ts";
import type { State } from "#~/state/index.ts";

export interface RunOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface CatalogueResult {
  applied: string[];
  proposed: string | null;
  /** True when the rename was actually sent to Papra, not proposed or dry-run. */
  renamed: boolean;
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
    catalogueSchema(
      tags.map((tag) => tag.name),
      config.tagging.allowNewTags,
    ),
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
    await state.setStage(doc.id, "tagging", "done", config.tagging.promptVersion, {
      result: { tags: applied },
      dryRun,
    });
  }

  let proposed: string | null = null;
  let renamed = false;
  if (config.renaming.enabled) {
    const fields = Object.fromEntries(
      NAME_FIELDS.map((key) => [key, (answer as any)?.[key] ?? ""]),
    );
    proposed = composeName(config, fields, splitExtension(doc.originalName || doc.name));

    const renameDry = dryRun || config.renaming.dryRun;
    renamed = Boolean(proposed && proposed !== doc.name && !renameDry);
    if (renamed) await ports.renameDocument(doc.id, proposed!);
    // Recorded even when skipped, and the proposal is stored: `--apply-renames`
    // can then write these through later with no further model call.
    await state.setStage(
      doc.id,
      "renaming",
      renameDry ? "skipped" : "done",
      config.renaming.promptVersion,
      {
        result: { from: doc.name, to: proposed, applied: !renameDry },
        dryRun,
      },
    );
  }

  return { applied, proposed, renamed };
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
  if (!config.model.spend) {
    // Skipped, not failed: recording an error here would burn one of the
    // document's `max_attempts` for every delivery received while spending is
    // off, and park it for good before it was ever tried.
    ports.log(`  ${doc.name.slice(0, 50)}: [model] spend is false, leaving untouched`);
    return;
  }
  if (!doc.content.trim()) {
    // Nothing recorded: the model only ever reads the extracted text, so there
    // is nothing to classify. If Papra extracts text later, its
    // document:updated webhook processes the document then.
    ports.log(`  ${doc.name.slice(0, 50)}: no extracted content, skipping`);
    return;
  }
  if (!dryRun) await state.recordDocument(doc.id, doc.content, doc.originalName);

  const maxAttempts = config.model.maxAttempts;
  const catalogueStages: Stage[] = [];
  if (config.tagging.enabled) catalogueStages.push("tagging");
  if (config.renaming.enabled) catalogueStages.push("renaming");
  const staleStages = await Promise.all(
    catalogueStages.map((stage) =>
      state.stageNeedsRun(doc.id, stage, config[stage].promptVersion, maxAttempts),
    ),
  );
  const needsCatalogue = force || staleStages.some(Boolean);

  let applied = ports.documentTags(doc.id);
  if (needsCatalogue) {
    try {
      const result = await runTaggingAndRename(config, state, ports, doc, options);
      applied = result.applied;
      ports.log(
        `  ${doc.name.slice(0, 44).padEnd(46)} tags=${applied.join(",") || "-"}  name=${result.proposed ?? "-"}`,
      );
      if (!dryRun && config.notify.onTagged && applied.length > 0) {
        await ports.notify(`Tagged ${doc.name.slice(0, 60)}`, applied.join(", "));
      }
      if (config.notify.onRenamed && result.renamed) {
        await ports.notify("Renamed", `${doc.name} -> ${result.proposed}`);
      }
    } catch (error) {
      const message = String((error as Error).message ?? error).slice(0, 400);
      for (const stage of catalogueStages) {
        await state.setStage(doc.id, stage, "error", config[stage].promptVersion, {
          error: message,
          dryRun,
        });
      }
      ports.log(`  ! ${doc.name.slice(0, 44)}: catalogue failed: ${message}`);
      if (config.notify.onError) {
        await ports.notify(
          "papra-curator error",
          `${doc.name}: tagging/renaming failed: ${message}`,
          "high",
        );
      }
      return;
    }
  }

  // Second model call only for documents the tags say are travel. This gate is
  // the cost control: everything else stops here having used exactly one call.
  if (!config.flights.enabled) return;
  const wanted = new Set(config.flights.tags.map((tag) => tag.toLowerCase()));
  if (!applied.some((tag) => wanted.has(tag.toLowerCase()))) return;
  if (
    !force &&
    !(await state.stageNeedsRun(doc.id, "flights", config.flights.promptVersion, maxAttempts))
  ) {
    return;
  }

  const flightsDry = dryRun || config.flights.dryRun;
  try {
    const added = await handleFlights(config, ports, doc, flightsDry);
    await state.setStage(doc.id, "flights", "done", config.flights.promptVersion, {
      result: { added },
      dryRun,
    });
    if (added.length > 0) {
      ports.log(`    flights: ${added.join(", ")}`);
      // A dry run files nothing, so it has nothing to announce.
      if (config.notify.onFlights && !flightsDry) {
        await ports.notify(`AirTrail: ${added.length} flight(s)`, added.join("\n"));
      }
    }
  } catch (error) {
    const message = String((error as Error).message ?? error).slice(0, 400);
    await state.setStage(doc.id, "flights", "error", config.flights.promptVersion, {
      error: message,
      dryRun,
    });
    ports.log(`  ! ${doc.name.slice(0, 44)}: flights failed: ${message}`);
    if (config.notify.onError) {
      await ports.notify("papra-curator error", `${doc.name}: flights failed: ${message}`, "high");
    }
  }
  return;
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
  let proposals = await state.pendingRenames();
  if (options.limit && options.limit > 0) proposals = proposals.slice(0, options.limit);
  ports.log(`${proposals.length} stored rename(s) to apply${dryRun ? " (dry run)" : ""}`);

  let applied = 0;
  for (const proposal of proposals) {
    try {
      if (!dryRun) {
        await ports.renameDocument(proposal.docId, proposal.to);
        await state.setStage(proposal.docId, "renaming", "done", config.renaming.promptVersion, {
          result: { from: proposal.from, to: proposal.to, applied: true },
        });
        if (config.notify.onRenamed) {
          await ports.notify("Renamed", `${proposal.from} -> ${proposal.to}`);
        }
      }
      ports.log(`  ${dryRun ? "would rename" : "renamed"}: ${proposal.from} -> ${proposal.to}`);
      applied++;
    } catch (error) {
      ports.log(`  ! ${proposal.docId}: rename failed: ${(error as Error).message}`);
    }
  }
  return applied;
}
