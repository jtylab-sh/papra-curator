/**
 * Per-document tracking DB — this service's own SQLite file, one row per
 * document and one per (document, stage), reached through Prisma.
 *
 * `promptVersion` on each stage is the capability Papra structurally lacks:
 * bump it in config and the next sweep re-runs that stage everywhere, so an
 * improved prompt reaches documents that were already processed.
 *
 * Papra's own database is a different file, opened read-only elsewhere. Nothing
 * here touches it.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "#~/generated/prisma/client.ts";
import type { Stage } from "#~/config/index.ts";

export type StageStatus = "done" | "error" | "skipped";

export interface StageRow {
  status: StageStatus;
  promptVersion: string | null;
  attempts: number;
  result: unknown;
}

export interface RenameProposal {
  docId: string;
  from: string;
  to: string;
  /** The uploaded filename recorded when the document was first processed. */
  originalName: string;
}

export class State {
  private readonly prisma: PrismaClient;

  private constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /** `url` is a Prisma SQLite URL: `file:/state/curator.db`, or `file::memory:`. */
  static async open(url: string): Promise<State> {
    const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    // The serve container and a one-shot `--once` run share this file: a sweep
    // rename makes Papra fire document:updated at the serve container, which
    // then writes the same DB mid-sweep. WAL lets a reader and a writer
    // coexist, and the busy timeout makes a contended write wait instead of
    // dying with "database is locked".
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000");
    return new State(prisma);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /**
   * Record a document sighting. Returns true when the extracted text changed
   * since the stages last ran (late OCR after an early webhook, a content
   * repair through the API): every stored stage was decided on the old text,
   * so they are all deleted and the caller's stage checks re-run them.
   */
  async recordDocument(docId: string, content: string, originalName: string): Promise<boolean> {
    const contentSha256 = createHash("sha256")
      .update(content ?? "")
      .digest("hex");
    const existing = await this.prisma.document.findUnique({ where: { docId } });
    if (existing === null) {
      await this.prisma.document.create({ data: { docId, contentSha256, originalName } });
      return false;
    }
    if (existing.contentSha256 === contentSha256) return false;
    await this.prisma.document.update({ where: { docId }, data: { contentSha256 } });
    await this.prisma.stage.deleteMany({ where: { docId } });
    return true;
  }

  async stageRow(docId: string, stage: Stage): Promise<StageRow | null> {
    const row = await this.prisma.stage.findUnique({ where: { docId_stage: { docId, stage } } });
    if (row === null) return null;
    return {
      status: row.status as StageStatus,
      promptVersion: row.promptVersion,
      attempts: row.attempts,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }

  /**
   * A stage runs when it has never succeeded at the current prompt version.
   *
   * `skipped` counts as a settled outcome, not a retry: it is what a dry-run
   * rename records, and re-running it would spend a model call to reach the
   * same conclusion.
   */
  async stageNeedsRun(
    docId: string,
    stage: Stage,
    promptVersion: string,
    maxAttempts: number,
  ): Promise<boolean> {
    const row = await this.stageRow(docId, stage);
    if (row === null) return true;
    if (row.status === "done" || row.status === "skipped") {
      return row.promptVersion !== promptVersion;
    }
    return row.attempts < maxAttempts; // error: retry until the cap
  }

  /**
   * Record a stage outcome.
   *
   * A dry run must NOT persist progress: marking a stage done without having
   * applied it would make the following real run skip the work entirely, so the
   * dry run would silently consume the change it was only meant to preview.
   */
  async setStage(
    docId: string,
    stage: Stage,
    status: StageStatus,
    promptVersion: string,
    options: { result?: unknown; error?: string; dryRun?: boolean } = {},
  ): Promise<void> {
    if (options.dryRun) return;
    const previous = await this.stageRow(docId, stage);
    const row = {
      status,
      promptVersion,
      doneAt: new Date(),
      attempts: (previous?.attempts ?? 0) + 1,
      lastError: options.error ?? null,
      result: options.result === undefined ? null : JSON.stringify(options.result),
    };
    await this.prisma.stage.upsert({
      where: { docId_stage: { docId, stage } },
      create: { docId, stage, ...row },
      update: row,
    });
  }

  /**
   * Rename proposals computed but never applied, i.e. every document whose
   * renaming stage was recorded `skipped` because `[renaming] dry_run` was on.
   *
   * These exist so turning dry_run off does not mean paying the model again:
   * the names were already decided and stored, and `--apply-renames` writes
   * them through with no model call at all.
   */
  async pendingRenames(): Promise<RenameProposal[]> {
    const rows = await this.prisma.stage.findMany({
      where: { stage: "renaming", status: "skipped" },
      select: { docId: true, result: true },
    });
    const documents = await this.prisma.document.findMany({
      where: { docId: { in: rows.map((row) => row.docId) } },
      select: { docId: true, originalName: true },
    });
    const originalNames = new Map(documents.map((doc) => [doc.docId, doc.originalName]));
    const proposals: RenameProposal[] = [];
    for (const row of rows) {
      if (!row.result) continue;
      let parsed: { from?: unknown; to?: unknown };
      try {
        parsed = JSON.parse(row.result);
      } catch {
        continue;
      }
      const from = typeof parsed.from === "string" ? parsed.from : "";
      const to = typeof parsed.to === "string" ? parsed.to : "";
      if (!to || to === from) continue;
      proposals.push({
        docId: row.docId,
        from,
        to,
        originalName: originalNames.get(row.docId) ?? "",
      });
    }
    return proposals;
  }

  /** Raw passthrough, for `createSchema` below. */
  async execute(sql: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(sql);
  }
}

/**
 * Apply every migration to an EMPTY database, for tests and for nothing else.
 *
 * It reads the same `prisma/migrations` SQL that ships to production, so the
 * two cannot drift, but it keeps no ledger of what it has applied — a real
 * deployment upgrades with `prisma migrate deploy`, which does.
 */
export async function createSchema(state: State): Promise<void> {
  const migrations = new URL("../../prisma/migrations/", import.meta.url);
  for (const name of readdirSync(migrations).sort()) {
    if (!name.match(/^\d/)) continue;
    const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8");
    for (const statement of sql.split(";")) {
      if (statement.trim()) await state.execute(statement);
    }
  }
}
