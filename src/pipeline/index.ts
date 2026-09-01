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

/** Applied when the model finds nothing and the document has no tags at all — see below. */
export const UNTAGGED = "untagged";

export interface RunOptions {
  dryRun?: boolean;
  force?: boolean;
  /** Suppress the per-document push; sweeps set this and send one summary instead. */
  quiet?: boolean;
}

export interface CatalogueResult {
  applied: string[];
  proposed: string | null;
  /** Country filed into the configured custom property, or null when none was written. */
  country: string | null;
  /** Issue date written into Papra's document date field, or null when none was. */
  date: string | null;
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

  // The marker is applied by code below, never offered to the model: in the
  // vocabulary it would invite "untagged" as a lazy answer for weak documents.
  const vocabulary = tags.filter((tag) => tag.name !== UNTAGGED);

  const answer: CatalogueAnswer = await ports.askModel(
    "catalogue",
    cataloguePrompt(config, vocabulary),
    `Document name: ${doc.originalName || doc.name}\n\n${doc.content.slice(0, config.papra.contentLimit)}`,
    catalogueSchema(
      vocabulary.map((tag) => tag.name),
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
    if (applied.length === 0 && already.size === 0) {
      // Nothing fit and nobody tagged it by hand: mark it, so documents the
      // model could not place are findable instead of looking untouched.
      // The tag is created on first use (needs the tags:create permission);
      // failing to mark must not park the document, so errors only log.
      try {
        const untaggedId =
          idByName.get(UNTAGGED) ?? (dryRun ? null : await ports.createTag(UNTAGGED));
        if (!dryRun && untaggedId) await ports.applyTag(doc.id, untaggedId);
        if (untaggedId || dryRun) applied.push(UNTAGGED);
      } catch (error) {
        ports.log(
          `  ${doc.name.slice(0, 50)}: could not apply ${UNTAGGED}: ${(error as Error).message}`,
        );
      }
    }
    await state.setStage(doc.id, "tagging", "done", config.tagging.promptVersion, {
      result: { tags: applied },
      dryRun,
    });
  }

  // The same catalogue answer also names the document's country; file it into
  // a custom property when one is configured — same model call, no extra cost.
  const country = String(answer?.country ?? "")
    .trim()
    .toLowerCase();
  let filedCountry: string | null = null;
  if (config.tagging.countryProperty && country && !dryRun) {
    await setDocumentProperty(ports, config.tagging.countryProperty, doc.id, country);
    filedCountry = country;
  }

  // The issue date goes into Papra's native document date field, which its UI
  // shows and sorts by. Only a full date is written: Papra stores a timestamp,
  // so a bare year or month would fabricate a precision the document lacks.
  const answerDate = String(answer?.date ?? "").trim();
  let filedDate: string | null = null;
  if (config.tagging.setDocumentDate && /^\d{4}-\d{2}-\d{2}$/.test(answerDate) && !dryRun) {
    await ports.setDocumentDate(doc.id, answerDate);
    filedDate = answerDate;
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
    if (renamed) {
      await ports.renameDocument(doc.id, proposed!);
      await setDocumentProperty(
        ports,
        config.renaming.originalNameProperty,
        doc.id,
        doc.originalName || doc.name,
      );
    }
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

  return { applied, proposed, renamed, country: filedCountry, date: filedDate };
}

/**
 * Write a value into a named Papra custom property, creating the property
 * definition on first use. Used for the preserved original filename and the
 * document's country — a custom property shows in Papra's UI where internal
 * columns do not.
 */
async function setDocumentProperty(
  ports: Ports,
  propertyName: string,
  docId: string,
  value: string,
): Promise<void> {
  if (!propertyName || !value) return;
  const propertyId =
    ports.customPropertyId(propertyName) ?? (await ports.createCustomProperty(propertyName));
  if (!propertyId) return;
  await ports.setCustomProperty(docId, propertyId, value);
}

export interface ProcessResult {
  /** True when the document needed work (a model call was made or attempted) — what `--limit` counts. */
  worked: boolean;
  tags: string[];
  renamed: boolean;
  proposed: string | null;
  flights: number;
  errors: number;
}

export async function processDocument(
  config: Config,
  state: State,
  ports: Ports,
  docId: string,
  doc: Document | null,
  options: RunOptions = {},
): Promise<ProcessResult> {
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const quiet = options.quiet ?? false;
  const result: ProcessResult = {
    worked: false,
    tags: [],
    renamed: false,
    proposed: null,
    flights: 0,
    errors: 0,
  };

  if (doc === null) {
    ports.log(`  ${docId}: not found or deleted`);
    return result;
  }
  if (!config.model.spend) {
    // Skipped, not failed: recording an error here would burn one of the
    // document's `max_attempts` for every delivery received while spending is
    // off, and park it for good before it was ever tried.
    ports.log(`  ${doc.name.slice(0, 50)}: [model] spend is false, leaving untouched`);
    return result;
  }
  if (!doc.content.trim()) {
    // Nothing recorded: the model only ever reads the extracted text, so there
    // is nothing to classify. If Papra extracts text later, its
    // document:updated webhook processes the document then.
    ports.log(`  ${doc.name.slice(0, 50)}: no extracted content, skipping`);
    return result;
  }
  if (!dryRun && (await state.recordDocument(doc.id, doc.content, doc.originalName))) {
    ports.log(`  ${doc.name.slice(0, 50)}: content changed since last run, stages re-queued`);
  }

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
  result.worked = needsCatalogue;

  // At most ONE push per document, assembled from everything done to it; the
  // on_* switches choose which lines appear in it, not separate messages.
  const lines: string[] = [];

  let applied = ports.documentTags(doc.id);
  if (needsCatalogue) {
    try {
      const catalogue = await runTaggingAndRename(config, state, ports, doc, options);
      applied = catalogue.applied;
      result.tags = catalogue.applied;
      result.renamed = catalogue.renamed;
      result.proposed = catalogue.proposed;
      ports.log(
        `  ${doc.name.slice(0, 44).padEnd(46)} tags=${applied.join(",") || "-"}  name=${catalogue.proposed ?? "-"}`,
      );
      if (config.notify.onTagged && applied.length > 0) lines.push(`tags: ${applied.join(", ")}`);
      if (config.notify.onTagged && catalogue.country) lines.push(`country: ${catalogue.country}`);
      if (config.notify.onTagged && catalogue.date) lines.push(`date: ${catalogue.date}`);
      if (config.notify.onRenamed && catalogue.renamed) {
        lines.push(`renamed: ${doc.name} -> ${catalogue.proposed}`);
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
      result.errors += 1;
      if (config.notify.onError) {
        await ports.notify(
          "papra-curator error",
          `${doc.name}: tagging/renaming failed: ${message}`,
          "high",
        );
      }
      return result;
    }
  }

  // Second model call only for documents the tags say are travel. This gate is
  // the cost control: everything else stops here having used exactly one call.
  if (config.flights.enabled) {
    const wanted = new Set(config.flights.tags.map((tag) => tag.toLowerCase()));
    const isTravel = applied.some((tag) => wanted.has(tag.toLowerCase()));
    if (
      isTravel &&
      (force ||
        (await state.stageNeedsRun(doc.id, "flights", config.flights.promptVersion, maxAttempts)))
    ) {
      result.worked = true;
      const flightsDry = dryRun || config.flights.dryRun;
      try {
        const added = await handleFlights(config, ports, doc, flightsDry);
        await state.setStage(doc.id, "flights", "done", config.flights.promptVersion, {
          result: { added },
          dryRun,
        });
        result.flights = added.length;
        if (added.length > 0) {
          ports.log(`    flights: ${added.join(", ")}`);
          // A dry run files nothing, so it has nothing to announce.
          if (config.notify.onFlights && !flightsDry) lines.push(`flights: ${added.join(", ")}`);
        }
      } catch (error) {
        const message = String((error as Error).message ?? error).slice(0, 400);
        await state.setStage(doc.id, "flights", "error", config.flights.promptVersion, {
          error: message,
          dryRun,
        });
        ports.log(`  ! ${doc.name.slice(0, 44)}: flights failed: ${message}`);
        result.errors += 1;
        if (config.notify.onError) {
          await ports.notify(
            "papra-curator error",
            `${doc.name}: flights failed: ${message}`,
            "high",
          );
        }
      }
    }
  }

  if (!dryRun && !quiet && lines.length > 0) {
    const title = result.renamed && result.proposed ? result.proposed : doc.name;
    await ports.notify(title.slice(0, 60), lines.join("\n"));
  }
  return result;
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
        await setDocumentProperty(
          ports,
          config.renaming.originalNameProperty,
          proposal.docId,
          proposal.originalName || proposal.from,
        );
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
