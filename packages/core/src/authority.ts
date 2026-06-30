/**
 * The collab authority, repurposed for the single-author case (build spec §6).
 *
 * We do NOT hand-roll ordering, gap detection, or reconstruction. This is the
 * standard prosemirror-collab authority contract: the client submits steps based
 * on a version; the server accepts them only if the version is current, applies
 * them via the shared schema, assigns monotonic versions, and returns the new
 * version. Tamper-evidence (the hash chain) is layered on top of the confirmed
 * step log by the caller.
 */
import type { Node } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { schema } from '@scriptorium/schema';

export interface SubmitBatch {
  /** Document version the client's steps are based on. */
  version: number;
  clientID: string;
  /** step.toJSON() objects. */
  steps: unknown[];
}

export type SubmitResult =
  | {
      status: 'accepted';
      /** The new authoritative version after applying the batch. */
      version: number;
      /** The base version the steps applied at (== submitted version). */
      baseVersion: number;
      /** The rehydrated step JSON actually confirmed (round-tripped, canonical). */
      confirmedSteps: unknown[];
      doc: Node;
    }
  | {
      status: 'stale';
      /** Current authoritative version, so the client can rebase and resend. */
      version: number;
    }
  | {
      status: 'invalid';
      reason: string;
    };

/**
 * Validate and apply a submitted batch against the current authority state.
 *
 * Returns the outcome without performing any persistence — the caller is
 * responsible for appending the confirmed steps to the hash-chained log inside
 * the same transaction that advances the version, so the log and the version
 * never drift apart.
 */
export function applySubmission(
  currentDoc: Node,
  currentVersion: number,
  batch: SubmitBatch,
): SubmitResult {
  if (!Array.isArray(batch.steps) || batch.steps.length === 0) {
    return { status: 'invalid', reason: 'A batch must contain at least one step.' };
  }

  if (batch.version !== currentVersion) {
    // Standard collab rebase signal. Rare for a single author, but the protocol
    // handles it: the client rebases its local steps onto the new version.
    return { status: 'stale', version: currentVersion };
  }

  let doc = currentDoc;
  const confirmedSteps: unknown[] = [];
  for (let i = 0; i < batch.steps.length; i++) {
    let step: Step;
    try {
      step = Step.fromJSON(schema, batch.steps[i] as object);
    } catch (err) {
      return { status: 'invalid', reason: `Step ${i} is not a valid step: ${String(err)}` };
    }
    const result = step.apply(doc);
    if (result.failed || !result.doc) {
      return {
        status: 'invalid',
        reason: `Step ${i} could not be applied to the authoritative document: ${
          result.failed ?? 'no document produced'
        }`,
      };
    }
    doc = result.doc;
    // Round-trip through toJSON so what we log is exactly what the schema yields,
    // not whatever shape the client happened to send.
    confirmedSteps.push(step.toJSON());
  }

  return {
    status: 'accepted',
    version: currentVersion + batch.steps.length,
    baseVersion: currentVersion,
    confirmedSteps,
    doc,
  };
}
