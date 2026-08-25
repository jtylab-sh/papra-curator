/** Shared fixtures for the test files: a valid config, a document, and a Ports fake that records every outward effect so tests can assert on cost. */

import { parseConfig, type Config } from "#~/config/index.ts";
import type { Segment } from "#~/flights/index.ts";
import type { Document, Tag } from "#~/papra.ts";
import type { AirtrailFlight, Ports } from "#~/ports.ts";

export const CONFIG_TOML = `
[papra]
db_path = "/papra-db/db.sqlite"
api_url = "http://papra:1221"
organization_id = "org_test"
content_limit = 30000

[trigger]
listen_host = "0.0.0.0"
listen_port = 8099
reconcile_interval_seconds = 0
content_settle_seconds = 20

[model]
name = "mistral-medium-latest"
spend = true
temperature = 0.0
max_attempts = 3

[tagging]
enabled = true
prompt_version = "1"
max_tags = 8
allow_new_tags = false

[renaming]
enabled = true
prompt_version = "1"
template = "{date}_{party}_{doctype}_{detail}"
slugify_fields = true
max_length = 120
dry_run = false

[handlers.flights]
enabled = true
prompt_version = "1"
tags = ["viaggi"]
airtrail_url = "https://fly.example.com"
owner_names = ["Test Owner", "OWNER/TEST"]
near_duplicate_days = 2
dry_run = false

[notify]
url = "http://ntfy:80"
topic = "papra-curator"
on_success = true
`;

export const OWNER = "u-owner";

export function config(overrides: (draft: Config) => void = () => {}): Config {
  const parsed = parseConfig(CONFIG_TOML, {});
  overrides(parsed);
  return parsed;
}

export function document(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc1",
    name: "scan_001.pdf",
    originalName: "scan_001.pdf",
    content: "some extracted text",
    notes: "",
    ...overrides,
  };
}

/** A Ports fake that records every outward effect, so tests can assert on cost. */
export class FakePorts implements Ports {
  modelCalls: string[] = [];
  appliedTags: string[] = [];
  createdTags: string[] = [];
  renames: { docId: string; name: string }[] = [];
  savedFlights: unknown[] = [];
  notifications: string[] = [];
  logs: string[] = [];

  tags: Tag[] = [
    { id: "t-viaggi", name: "viaggi", description: "travel" },
    { id: "t-banca", name: "banca", description: "banking" },
  ];
  existingDocumentTags: string[] = [];
  existingFlights: AirtrailFlight[] = [];
  answers: Record<string, unknown> = {};
  failOn: Record<string, string> = {};

  async askModel(label: string): Promise<any> {
    this.modelCalls.push(label);
    if (this.failOn[label]) throw new Error(this.failOn[label]);
    return this.answers[label] ?? {};
  }
  listTags(): Tag[] {
    return this.tags;
  }
  documentTags(): string[] {
    return this.existingDocumentTags;
  }
  async applyTag(_docId: string, tagId: string): Promise<void> {
    this.appliedTags.push(tagId);
  }
  async createTag(name: string): Promise<string | null> {
    this.createdTags.push(name);
    return `t-${name}`;
  }
  async renameDocument(docId: string, newName: string): Promise<void> {
    if (this.failOn["rename"]) throw new Error(this.failOn["rename"]);
    this.renames.push({ docId, name: newName });
  }
  async listFlights(): Promise<AirtrailFlight[]> {
    return this.existingFlights;
  }
  async saveFlight(body: unknown): Promise<void> {
    this.savedFlights.push(body);
  }
  async notify(title: string): Promise<void> {
    this.notifications.push(title);
  }
  log(message: string): void {
    this.logs.push(message);
  }
}

export function catalogueAnswer(tags: string[], fields: Partial<Record<string, string>> = {}) {
  return {
    tags,
    date: fields.date ?? "2024-10-26",
    party: fields.party ?? "Air China",
    doctype: fields.doctype ?? "carta imbarco",
    detail: fields.detail ?? "",
  };
}

export function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    from: "mxp",
    to: "otp",
    departure: "2024-07-14",
    departureTime: "11:30",
    flightNumber: "W6 4312",
    guests: [],
    ownerIsAboard: true,
    evidence: "passenger list",
    ...overrides,
  };
}
