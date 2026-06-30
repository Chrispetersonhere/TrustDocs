/**
 * Test helpers that simulate a real client: produce genuine ProseMirror steps
 * with prosemirror-transform and submit them through the authority, exactly as
 * the browser editor would. No step semantics are hand-rolled here.
 */
import { Transform } from 'prosemirror-transform';
import type { Node } from 'prosemirror-model';
import { emptyDoc } from '../src/applier.js';
import { schema } from '@scriptorium/schema';
import { WritingService } from '../src/service.js';

export const GENESIS = {
  assignment_id: 'assignment-1',
  author_id: 'author-1',
  session_id: 'session-1',
  server_session_start: '2026-01-01T00:00:00.000Z',
};

/**
 * A client that mirrors the authority: it keeps a local doc + version, builds
 * steps with Transform, submits them, and tracks the confirmed version. A clock
 * lets tests space out receipt times deterministically.
 */
export class SimClient {
  doc: Node = emptyDoc();
  version = 0;
  constructor(
    public service: WritingService,
    public sessionId = GENESIS.session_id,
  ) {}

  /** Build a transform from the current local doc; caller mutates it. */
  tr(): Transform {
    return new Transform(this.doc);
  }

  /** Submit a transform's steps as one eager batch. */
  async commit(tr: Transform): Promise<void> {
    if (tr.steps.length === 0) return;
    const steps = tr.steps.map((s) => s.toJSON());
    const res = await this.service.submit(this.sessionId, {
      version: this.version,
      clientID: 'sim',
      steps,
    });
    if (res.status !== 'accepted') {
      throw new Error(`Submission not accepted: ${res.status} ${res.reason ?? ''}`);
    }
    this.doc = tr.doc;
    this.version = res.version;
  }

  /** Convenience: insert text at a position and commit. */
  async type(text: string, pos: number): Promise<void> {
    const tr = this.tr();
    tr.insert(pos, schema.text(text));
    await this.commit(tr);
  }

  /** Convenience: delete a range and commit. */
  async delete(from: number, to: number): Promise<void> {
    const tr = this.tr();
    tr.delete(from, to);
    await this.commit(tr);
  }

  /** Split the block at pos (e.g. press Enter) and commit. */
  async split(pos: number): Promise<void> {
    const tr = this.tr();
    tr.split(pos);
    await this.commit(tr);
  }
}

/** A clock that advances a fixed step each call, for deterministic receipt times. */
export function steppedClock(startIso: string, stepMs: number): () => Date {
  let t = Date.parse(startIso);
  let first = true;
  return () => {
    if (first) {
      first = false;
      return new Date(t);
    }
    t += stepMs;
    return new Date(t);
  };
}

export { schema, emptyDoc };
