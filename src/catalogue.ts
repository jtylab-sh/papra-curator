/**
 * Stage 1: tags and filename fields in a single model call.
 *
 * One call rather than two, so the tags and the name always describe the same
 * reading of the document — and so the common case (a document that is not
 * travel) costs exactly one call, start to finish.
 */

import type { Config } from "./config.ts";
import type { Tag } from "./papra.ts";
import { NAME_FIELDS } from "./naming.ts";

export interface CatalogueAnswer {
  tags: string[];
  date: string;
  party: string;
  doctype: string;
  detail: string;
}

/**
 * When new tags are not allowed, the vocabulary goes into the schema as an
 * `enum`. Constraining the decoder is far stronger than asking politely in the
 * prompt: with a loose vocabulary a model invents per-document facts as tags
 * ("Real Estate Price: EUR 295,000").
 */
export function catalogueSchema(tagNames: string[], allowNew: boolean): object {
  const tagItems =
    !allowNew && tagNames.length > 0
      ? { type: "string", enum: tagNames }
      : { type: "string" };
  return {
    type: "object",
    properties: {
      tags: { type: "array", items: tagItems },
      date: { type: "string" },
      party: { type: "string" },
      doctype: { type: "string" },
      detail: { type: "string" },
    },
    required: ["tags", ...NAME_FIELDS],
    additionalProperties: false,
  };
}

export function cataloguePrompt(config: Config, tags: Tag[]): string {
  const vocabulary = tags.map((tag) => (tag.description ? `- ${tag.name}: ${tag.description}` : `- ${tag.name}`));
  return [
    "You catalogue documents for a personal archive. You are given a document's " +
      "OCR text and must return both its tags and the fields used to build its " +
      "filename, in one answer, so the two always agree.",
    "",
    "Available tags:",
    ...vocabulary,
    "",
    "TAGS",
    `- Choose at most ${config.tagging.maxTags}, only genuinely relevant ones. ` +
      "Fewer is better than forcing a weak match.",
    config.tagging.allowNewTags
      ? "- You may propose a new tag only when nothing existing fits."
      : "- Only choose from the tags listed above. Do not invent new tags.",
    "- Tag what the document IS, not everything it mentions in passing.",
    "",
    "FILENAME FIELDS",
    "- date: the date the document is ABOUT (issue/transaction/travel date), as " +
      "YYYY-MM-DD. Use YYYY-MM or YYYY if that is all the document supports. " +
      "Empty string if genuinely undated. Never today's date.",
    "- party: the organisation or person the document is with — the issuer, " +
      "supplier, airline, bank or authority. Short form: 'enel' not " +
      "'Enel Energia S.p.A.'. Empty if there is none.",
    "- doctype: what kind of document it is, 2-3 words max, lowercase, in " +
      "Italian if the document is Italian: 'bolletta luce', 'busta paga', " +
      "'carta imbarco', 'contratto affitto'.",
    "- detail: one short distinguishing detail when it helps tell near-identical " +
      "documents apart (a route like 'mxp-tfu', a month, an invoice number). " +
      "Empty string when nothing adds value.",
    "",
    "Return facts from the document only. Never guess a date or a party.",
  ].join("\n");
}
