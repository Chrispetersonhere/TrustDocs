/**
 * Server-derived evidence (build spec §8).
 *
 * HARD CONSTRAINT (§8, §11): this module computes NO verdict — no score, no
 * probability, no "likely AI", no flag meaning "cheating". It surfaces
 * uninterpreted, server-trustworthy signals from the confirmed step log. A human
 * interprets; the tool asserts nothing.
 */
import { Step } from 'prosemirror-transform';
import type { Fragment } from 'prosemirror-model';
import { schema } from '@scriptorium/schema';

export interface EvidenceEntry {
  version: number;
  steps_json: unknown[];
  /** ISO 8601 UTC, authoritative server receipt time. */
  server_received_at: string;
}

export interface LargeInsertion {
  version: number;
  server_received_at: string;
  /** Number of inserted characters in the single step that crossed the threshold. */
  insertedChars: number;
}

/** Count the characters of text contained in a slice's fragment. */
function fragmentTextLength(content: Fragment): number {
  let total = 0;
  content.forEach((node) => {
    total += node.textContent.length;
  });
  return total;
}

/**
 * Server-derived large-insertion events: any single insertion step whose inserted
 * text exceeds `thresholdChars`. Computed purely from steps_json, so the client
 * cannot suppress it. This is the signal that matters.
 *
 * Note: this is evidence of a large insertion, NOT a claim that it was a paste or
 * that it indicates wrongdoing.
 */
export function largeInsertions(
  entries: EvidenceEntry[],
  thresholdChars = 240,
): LargeInsertion[] {
  const events: LargeInsertion[] = [];
  for (const entry of entries) {
    for (const stepJson of entry.steps_json) {
      let step: Step;
      try {
        step = Step.fromJSON(schema, stepJson as object);
      } catch {
        continue;
      }
      // ReplaceStep / ReplaceAroundStep both expose a `slice`.
      const slice = (step as unknown as { slice?: { content: Fragment } }).slice;
      if (!slice) continue;
      const inserted = fragmentTextLength(slice.content);
      if (inserted > thresholdChars) {
        events.push({
          version: entry.version,
          server_received_at: entry.server_received_at,
          insertedChars: inserted,
        });
      }
    }
  }
  return events;
}

export interface WorkingSession {
  startedAt: string;
  endedAt: string;
  activeMs: number;
  entryCount: number;
}

export interface ActiveTimeReport {
  /**
   * Sum of gaps between consecutive receipts where gap <= idleThresholdMs.
   * RECEIPT-BASED: this is time between edits the server saw, not a claim about
   * authorship effort.
   */
  activeMs: number;
  /** First to last receipt, inclusive. */
  wallClockMs: number;
  workingSessions: WorkingSession[];
  idleThresholdMs: number;
  sessionGapMs: number;
  /** Restated honestly so consuming UIs cannot drop the caveat. */
  basis: 'server-receipt-time';
}

/**
 * Active-time and working-session computation from server receipt timestamps
 * (build spec §8). Defaults: idle threshold 120s, session split at 30min.
 *
 * Entries are sorted by receipt time defensively; ties keep input order.
 */
export function activeTime(
  entries: EvidenceEntry[],
  idleThresholdMs = 120_000,
  sessionGapMs = 30 * 60_000,
): ActiveTimeReport {
  const times = entries
    .map((e) => Date.parse(e.server_received_at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (times.length === 0) {
    return {
      activeMs: 0,
      wallClockMs: 0,
      workingSessions: [],
      idleThresholdMs,
      sessionGapMs,
      basis: 'server-receipt-time',
    };
  }

  let activeMs = 0;
  const sessions: WorkingSession[] = [];
  let sessionStart = times[0];
  let sessionActive = 0;
  let sessionCount = 1;
  let prev = times[0];

  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - prev;
    if (gap > sessionGapMs) {
      sessions.push({
        startedAt: new Date(sessionStart).toISOString(),
        endedAt: new Date(prev).toISOString(),
        activeMs: sessionActive,
        entryCount: sessionCount,
      });
      sessionStart = times[i];
      sessionActive = 0;
      sessionCount = 1;
    } else {
      if (gap <= idleThresholdMs) {
        activeMs += gap;
        sessionActive += gap;
      }
      sessionCount += 1;
    }
    prev = times[i];
  }
  sessions.push({
    startedAt: new Date(sessionStart).toISOString(),
    endedAt: new Date(prev).toISOString(),
    activeMs: sessionActive,
    entryCount: sessionCount,
  });

  return {
    activeMs,
    wallClockMs: times[times.length - 1] - times[0],
    workingSessions: sessions,
    idleThresholdMs,
    sessionGapMs,
    basis: 'server-receipt-time',
  };
}
