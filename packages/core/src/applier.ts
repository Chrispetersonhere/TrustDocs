/**
 * Step application and document reconstruction (build spec §5, §6, §8, §12).
 *
 * We NEVER reimplement step semantics. Steps are rehydrated with
 * `Step.fromJSON(schema, json)` and applied with `step.apply(doc)`, using the
 * SAME shared schema and the SAME prosemirror-transform library the client used.
 */
import type { Node } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { schema } from '@scriptorium/schema';

/** The canonical empty document for this schema. */
export function emptyDoc(): Node {
  const doc = schema.topNodeType.createAndFill();
  if (!doc) throw new Error('Failed to create an empty document from the shared schema');
  return doc;
}

/**
 * Apply one batch of step JSON to a document, returning the new document.
 * Throws if any step is malformed or fails to apply (the authority must reject
 * such a batch rather than silently producing a divergent document).
 */
export function applyStepsJson(doc: Node, stepsJson: unknown[]): Node {
  let next = doc;
  for (let i = 0; i < stepsJson.length; i++) {
    const step = Step.fromJSON(schema, stepsJson[i] as object);
    const result = step.apply(next);
    if (result.failed || !result.doc) {
      throw new Error(`Step ${i} failed to apply: ${result.failed ?? 'no document produced'}`);
    }
    next = result.doc;
  }
  return next;
}

/**
 * Reconstruct the authoritative document by folding confirmed steps from
 * version 0. This is the only sanctioned way to know "the final document":
 * from the log alone, never from a client-saved copy.
 *
 * `entries` must be in ascending version order.
 */
export function reconstruct(entries: Array<{ steps_json: unknown[] }>): Node {
  let doc = emptyDoc();
  for (const entry of entries) {
    doc = applyStepsJson(doc, entry.steps_json);
  }
  return doc;
}

/** Reconstruct and return the plain-text rendering, for tests and summaries. */
export function reconstructText(entries: Array<{ steps_json: unknown[] }>): string {
  const doc = reconstruct(entries);
  return doc.textBetween(0, doc.content.size, '\n', '\n');
}
