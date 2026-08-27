/**
 * Papra access, split by direction on purpose.
 *
 * Reads go straight at Papra's SQLite, opened read-only. That file is on a `:ro`
 * bind mount and Papra runs it in journal_mode=delete, so a reader needs no lock
 * files. In that journal mode reader and writer still exclude each other
 * briefly: while Papra commits (e.g. its search-index update right after this
 * service's own rename/tag API call) a read attempt gets SQLITE_BUSY, so every
 * connection sets a busy timeout to wait out the commit instead of failing the
 * whole stage with "database is locked".
 *
 * Writes go through Papra's HTTP API, never the DB, because the schema is
 * Papra's own migration domain and writing behind its back would also leave its
 * full-text index stale.
 */

import { DatabaseSync } from "node:sqlite";
import type { Config } from "#~/config/index.ts";
import { requestJson } from "#~/ports/http.ts";

export interface Document {
  id: string;
  name: string;
  originalName: string;
  content: string;
  notes: string;
}

export interface Tag {
  id: string;
  name: string;
  description: string;
}

export function openReadOnly(dbPath: string): DatabaseSync {
  // timeout = sqlite3_busy_timeout: wait for Papra's commit lock to clear
  // instead of throwing SQLITE_BUSY immediately.
  return new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
}

const DOCUMENT_COLUMNS =
  "id, name, coalesce(original_name, '') as original_name, coalesce(content, '') as content, coalesce(notes, '') as notes";

interface DocumentRow {
  id: string;
  name: string;
  original_name: string;
  content: string;
  notes: string;
}

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    name: row.name,
    originalName: row.original_name,
    content: row.content,
    notes: row.notes,
  };
}

export class PapraReader {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private open(): DatabaseSync {
    return openReadOnly(this.config.papra.dbPath);
  }

  document(docId: string): Document | null {
    const db = this.open();
    try {
      const row = db
        .prepare(
          `select ${DOCUMENT_COLUMNS} from documents` +
            " where id = ? and organization_id = ? and is_deleted = 0",
        )
        .get(docId, this.config.papra.organizationId) as DocumentRow | undefined;
      return row ? toDocument(row) : null;
    } finally {
      db.close();
    }
  }

  documents(limit = 0): Document[] {
    const db = this.open();
    try {
      let sql =
        `select ${DOCUMENT_COLUMNS} from documents` +
        " where is_deleted = 0 and organization_id = ? order by created_at desc";
      if (limit > 0) sql += ` limit ${Math.trunc(limit)}`;
      // node:sqlite types rows as Record<string, SQLOutputValue>; the shape is
      // guaranteed by DOCUMENT_COLUMNS above, so assert through unknown.
      const rows = db
        .prepare(sql)
        .all(this.config.papra.organizationId) as unknown as DocumentRow[];
      return rows.map(toDocument);
    } finally {
      db.close();
    }
  }

  /** The tag vocabulary, read from the DB because it is cheaper than the API and used on every document. */
  tags(): Tag[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          "select id, name, coalesce(description, '') as description from tags" +
            " where organization_id = ? order by name",
        )
        .all(this.config.papra.organizationId) as {
        id: string;
        name: string;
        description: string;
      }[];
      return rows;
    } finally {
      db.close();
    }
  }

  /** Id of an organization custom-property definition by display name, or null when it does not exist. */
  customPropertyId(name: string): string | null {
    const db = this.open();
    try {
      const row = db
        .prepare(
          "select id from custom_property_definitions where organization_id = ? and name = ?",
        )
        .get(this.config.papra.organizationId, name) as { id: string } | undefined;
      return row?.id ?? null;
    } finally {
      db.close();
    }
  }

  documentTags(docId: string): string[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          "select t.name as name from documents_tags dt" +
            " join tags t on t.id = dt.tag_id where dt.document_id = ?",
        )
        .all(docId) as { name: string }[];
      return rows.map((row) => row.name);
    } finally {
      db.close();
    }
  }
}

export function papraBase(config: Config): string {
  return `${config.papra.apiUrl.replace(/\/+$/, "")}/api/organizations/${config.papra.organizationId}`;
}

export class PapraWriter {
  private readonly config: Config;
  private readonly apiKey: string;

  constructor(config: Config, apiKey: string) {
    this.config = config;
    this.apiKey = apiKey;
  }

  async applyTag(docId: string, tagId: string): Promise<void> {
    await requestJson(`${papraBase(this.config)}/documents/${docId}/tags`, {
      payload: { tagId },
      token: this.apiKey,
      timeoutMs: 60_000,
    });
  }

  async createTag(name: string, description = ""): Promise<string | null> {
    const answer = await requestJson(`${papraBase(this.config)}/tags`, {
      payload: { name, description },
      token: this.apiKey,
      timeoutMs: 60_000,
    });
    return answer?.tag?.id ?? null;
  }

  /** Create a text custom-property definition; the API key needs the custom-properties:create permission. */
  async createCustomProperty(name: string): Promise<string | null> {
    const answer = await requestJson(`${papraBase(this.config)}/custom-properties`, {
      payload: { name, type: "text" },
      token: this.apiKey,
      timeoutMs: 60_000,
    });
    return answer?.propertyDefinition?.id ?? null;
  }

  async setCustomProperty(docId: string, propertyId: string, value: string): Promise<void> {
    await requestJson(
      `${papraBase(this.config)}/documents/${docId}/custom-properties/${propertyId}`,
      { payload: { value }, method: "PUT", token: this.apiKey, timeoutMs: 60_000 },
    );
  }

  /**
   * Only `name` changes. Papra keeps the uploaded filename in its own
   * `original_name` column, which updateDocument never touches, so a rename is
   * always revertible and never loses the original.
   */
  async renameDocument(docId: string, newName: string): Promise<void> {
    await requestJson(`${papraBase(this.config)}/documents/${docId}`, {
      payload: { name: newName },
      token: this.apiKey,
      method: "PATCH",
      timeoutMs: 60_000,
    });
  }
}
