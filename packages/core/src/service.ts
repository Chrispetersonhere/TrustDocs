/**
 * The writing-session service: the one place that ties the collab authority to
 * the hash-chained append-only log (build spec §6).
 *
 * It rebuilds the authoritative document from the log, validates a submitted
 * batch against the current version, and — on accept — appends the confirmed
 * steps with the authoritative receipt time, all serialized per session by the
 * Store. The version and the log advance together or not at all.
 */
import type { Node } from 'prosemirror-model';
import { applySubmission, type SubmitBatch } from './authority.js';
import { emptyDoc, applyStepsJson, reconstruct } from './applier.js';
import type { GenesisContext } from './hashchain.js';
import type { EditLogEntry, Store, WritingSessionRecord } from './types.js';

export interface SubmitOutcome {
  status: 'accepted' | 'stale' | 'invalid';
  version: number;
  reason?: string;
}

/** A monotonic clock injectable for tests; defaults to wall-clock UTC. */
export type NowFn = () => Date;

export class WritingService {
  constructor(
    private store: Store,
    private now: NowFn = () => new Date(),
  ) {}

  private genesisOf(session: WritingSessionRecord): GenesisContext {
    return {
      assignment_id: session.assignment_id,
      author_id: session.author_id,
      session_id: session.id,
      server_session_start: session.server_session_start,
    };
  }

  /**
   * Process a client batch. Receipt time is stamped HERE, on the server, the
   * moment we accept — never taken from the client (build spec §2, §6).
   */
  async submit(sessionId: string, batch: SubmitBatch): Promise<SubmitOutcome> {
    const session = await this.store.getSession(sessionId);
    if (!session) return { status: 'invalid', version: 0, reason: 'Unknown session' };
    if (session.status !== 'active') {
      return {
        status: 'invalid',
        version: await this.store.getCurrentVersion(sessionId),
        reason: 'Session is not active',
      };
    }

    const entries = await this.store.getEntries(sessionId);
    const currentVersion = entries.length === 0 ? 0 : entries[entries.length - 1].version;
    const currentDoc = reconstruct(entries);

    const result = applySubmission(currentDoc, currentVersion, batch);

    if (result.status === 'stale') {
      return { status: 'stale', version: result.version };
    }
    if (result.status === 'invalid') {
      return { status: 'invalid', version: currentVersion, reason: result.reason };
    }

    const server_received_at = this.now().toISOString();
    const stored = await this.store.appendEntry(sessionId, this.genesisOf(session), {
      version: result.version,
      steps_json: result.confirmedSteps,
      server_received_at,
      client_meta: sanitizeClientMeta((batch as { client_meta?: unknown }).client_meta),
    });

    return { status: 'accepted', version: stored.version };
  }

  /** Steps confirmed at versions greater than `sinceVersion`, for client catch-up. */
  async eventsSince(
    sessionId: string,
    sinceVersion: number,
  ): Promise<{ version: number; steps: unknown[] }> {
    const entries = await this.store.getEntries(sessionId);
    const fresh = entries.filter((e) => e.version > sinceVersion);
    const steps = fresh.flatMap((e) => e.steps_json);
    const version = entries.length === 0 ? 0 : entries[entries.length - 1].version;
    return { version, steps };
  }

  /** The authoritative document, reconstructed from the log alone. */
  async currentDoc(sessionId: string): Promise<{ version: number; doc: Node }> {
    const entries = await this.store.getEntries(sessionId);
    const version = entries.length === 0 ? 0 : entries[entries.length - 1].version;
    return { version, doc: entries.length === 0 ? emptyDoc() : reconstruct(entries) };
  }

  async getEntries(sessionId: string): Promise<EditLogEntry[]> {
    return this.store.getEntries(sessionId);
  }
}

/**
 * Client metadata is stored only in the explicitly-untrusted `client_meta`
 * field. We keep it small and never let it carry a "time" that any timing claim
 * could read. This is belt-and-suspenders for the §6 trust discipline.
 */
function sanitizeClientMeta(meta: unknown): unknown | null {
  if (meta == null) return null;
  try {
    const json = JSON.stringify(meta);
    if (json.length > 4096) return { truncated: true };
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export { applyStepsJson };
