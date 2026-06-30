import type { ChainedEntry, GenesisContext } from './hashchain.js';

export interface WritingSessionRecord {
  id: string;
  assignment_id: string;
  author_id: string;
  /** ISO 8601 UTC. */
  server_session_start: string;
  status: 'active' | 'closed';
}

/** A stored edit_log row. */
export interface EditLogEntry extends ChainedEntry {
  id: number;
  session_id: string;
  /**
   * Nullable, UNTRUSTED (build spec §6, §7). Anything the client asserts —
   * e.g. a client-claimed "this was a paste". Never the basis of any timing
   * claim and never fed into the hash as authoritative truth about the world.
   */
  client_meta: unknown | null;
}

export interface AppendInput {
  version: number;
  steps_json: unknown[];
  server_received_at: string;
  client_meta?: unknown | null;
}

/**
 * Storage abstraction over the append-only, hash-chained log.
 *
 * Implementations MUST guarantee that appendEntry is atomic and serialized per
 * session: the prev_hash it chains onto must be the entry_hash of the current
 * last row, with no interleaving. There is no update path; the only deletion is
 * the sanctioned hard-delete (build spec §9).
 */
export interface Store {
  createSession(input: {
    id: string;
    assignment_id: string;
    author_id: string;
    server_session_start: string;
  }): Promise<WritingSessionRecord>;

  getSession(sessionId: string): Promise<WritingSessionRecord | null>;

  listSessions(assignmentId?: string): Promise<WritingSessionRecord[]>;

  /** Current authoritative version for a session (0 if no entries). */
  getCurrentVersion(sessionId: string): Promise<number>;

  /** entry_hash of the last row, or the genesis hash if no entries. */
  getHeadHash(sessionId: string, genesis: GenesisContext): Promise<string>;

  /**
   * Append one confirmed batch, chaining it onto the current head. Returns the
   * stored row. Must be atomic + serialized per session.
   */
  appendEntry(sessionId: string, genesis: GenesisContext, input: AppendInput): Promise<EditLogEntry>;

  /** All entries for a session in ascending version order. */
  getEntries(sessionId: string): Promise<EditLogEntry[]>;

  /** Sanctioned hard-delete: purge a session and its edit_log rows (build spec §9). */
  deleteSession(sessionId: string): Promise<boolean>;
}
