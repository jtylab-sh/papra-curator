/**
 * Filename composition.
 *
 * The model never returns a filename. It returns four *fields* and this module
 * composes them, which is what makes path separators, `..` traversal and
 * 300-character names structurally impossible rather than merely discouraged.
 */

import type { Config } from "#~/config/index.ts";

export interface NameFields {
  date: string;
  party: string;
  doctype: string;
  detail: string;
}

export const NAME_FIELDS: (keyof NameFields)[] = ["date", "party", "doctype", "detail"];

/** Lowercase, strip accents to ASCII, collapse everything else to single hyphens. */
export function slugify(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function splitExtension(filename: string): string {
  const match = /(\.[A-Za-z0-9]{1,8})$/.exec(filename ?? "");
  return match ? match[1] : "";
}

export function composeName(
  config: Config,
  fields: Partial<NameFields>,
  extension: string,
): string | null {
  const parts: Record<string, string> = {};
  for (const key of NAME_FIELDS) {
    const raw = fields[key] ?? "";
    parts[key] = config.renaming.slugifyFields ? slugify(raw) : String(raw);
  }

  let name = config.renaming.template;
  for (const key of NAME_FIELDS) name = name.replaceAll(`{${key}}`, parts[key]);

  // Collapse the separators an empty field leaves behind, e.g. a missing {detail}.
  name = name.replace(/[_-]{2,}/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  name = name.slice(0, Math.trunc(config.renaming.maxLength)).replace(/^[_-]+|[_-]+$/g, "");
  if (!name) return null;
  return extension ? `${name}${extension}` : name;
}
