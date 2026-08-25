/**
 * Per-document tracking DB — this service's own SQLite, one row per document
 * and one row per (document, stage).
 *
 * `prompt_version` on each stage is the capability Papra structurally lacks:
 * bump it in config and the next sweep re-runs that stage everywhere, so an
 * improved prompt reaches documents that were already processed.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Stage } from "./config.ts";

const SCHEMA = `
create table if not exists documents (
  doc_id            text primary key,
  first_seen        text not null,
  content_sha256    text,
  original_name     text
);
create table if not exists stages (
  doc_id            text not null,
  stage             text not null,
  status            text not null,          -- done | error | skipped
  prompt_version    text,
  done_at           text,
  attempts          integer not null default 0,
  last_error        text,
  result            text,                   -- json: what we decided/applied
  primary key (doc_id, stage)
);
create index if not exists stages_status on stages (stage, status);
`;

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
}

export class State {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  recordDocument(docId: string, content: string, originalName: string): void {
    this.db
      .prepare(
        `insert or ignore into documents (doc_id, first_seen, content_sha256, original_name)
         values (?, ?, ?, ?)`,
      )
      .run(
        docId,
        new Date().toISOString(),
        createHash("sha256")
          .update(content ?? "")
          .digest("hex"),
        originalName,
      );
  }

  stageRow(docId: string, stage: Stage): StageRow | null {
    const row = this.db
      .prepare(
        "select status, prompt_version, attempts, result from stages where doc_id = ? and stage = ?",
      )
      .get(docId, stage) as
      | { status: string; prompt_version: string | null; attempts: number; result: string | null }
      | undefined;
    if (!row) return null;
    return {
      status: row.status as StageStatus,
      promptVersion: row.prompt_version,
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
  stageNeedsRun(docId: string, stage: Stage, promptVersion: string, maxAttempts: number): boolean {
    const row = this.stageRow(docId, stage);
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
  setStage(
    docId: string,
    stage: Stage,
    status: StageStatus,
    promptVersion: string,
    options: { result?: unknown; error?: string; dryRun?: boolean } = {},
  ): void {
    if (options.dryRun) return;
    const previous = this.stageRow(docId, stage);
    const attempts = (previous?.attempts ?? 0) + 1;
    this.db
      .prepare(
        `insert into stages (doc_id, stage, status, prompt_version, done_at, attempts, last_error, result)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(doc_id, stage) do update set
           status = excluded.status,
           prompt_version = excluded.prompt_version,
           done_at = excluded.done_at,
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           result = excluded.result`,
      )
      .run(
        docId,
        stage,
        status,
        promptVersion,
        new Date().toISOString(),
        attempts,
        options.error ?? null,
        options.result === undefined ? null : JSON.stringify(options.result),
      );
  }

  /**
   * Rename proposals computed but never applied, i.e. every document whose
   * renaming stage was recorded `skipped` because `[renaming] dry_run` was on.
   *
   * These exist so turning dry_run off does not mean paying the model again:
   * the names were already decided and stored, and `--apply-renames` writes
   * them through with no model call at all.
   */
  pendingRenames(): RenameProposal[] {
    const rows = this.db
      .prepare("select doc_id, result from stages where stage = 'renaming' and status = 'skipped'")
      .all() as { doc_id: string; result: string | null }[];
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
      proposals.push({ docId: row.doc_id, from, to });
    }
    return proposals;
  }
}
