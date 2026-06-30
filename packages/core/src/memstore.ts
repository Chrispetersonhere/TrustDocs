/**
 * In-memory Store implementation.
 *
 * Used by the test suite (the Definition-of-Done tests run with no database) and
 * as a zero-dependency demo backend. It enforces the same invariants as the
 * Postgres store: append-only, per-session serialized chaining, no update path.
 */
import { chainEntry, genesisHash, type GenesisContext } from './hashchain.js';
import type { AppendInput, EditLogEntry, Store, WritingSessionRecord } from './types.js';

export class InMemoryStore implements Store {
  private sessions = new Map<string, WritingSessionRecord>();
  private logs = new Map<string, EditLogEntry[]>();
  private nextId = 1;
  /** Per-session promise chain to serialize appends. */
  private locks = new Map<string, Promise<unknown>>();

  async createSession(input: {
    id: string;
    assignment_id: string;
    author_id: string;
    server_session_start: string;
  }): Promise<WritingSessionRecord> {
    if (this.sessions.has(input.id)) {
      throw new Error(`Session ${input.id} already exists`);
    }
    const record: WritingSessionRecord = { ...input, status: 'active' };
    this.sessions.set(input.id, record);
    this.logs.set(input.id, []);
    return record;
  }

  async getSession(sessionId: string): Promise<WritingSessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(assignmentId?: string): Promise<WritingSessionRecord[]> {
    const all = [...this.sessions.values()];
    return assignmentId ? all.filter((s) => s.assignment_id === assignmentId) : all;
  }

  async getCurrentVersion(sessionId: string): Promise<number> {
    const log = this.logs.get(sessionId);
    if (!log || log.length === 0) return 0;
    return log[log.length - 1].version;
  }

  async getHeadHash(sessionId: string, genesis: GenesisContext): Promise<string> {
    const log = this.logs.get(sessionId);
    if (!log || log.length === 0) return genesisHash(genesis);
    return log[log.length - 1].entry_hash;
  }

  appendEntry(
    sessionId: string,
    genesis: GenesisContext,
    input: AppendInput,
  ): Promise<EditLogEntry> {
    // Serialize per-session by chaining onto the previous append.
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const run = prior.then(() => this.appendLocked(sessionId, genesis, input));
    // Keep the lock chain alive even if this append rejects.
    this.locks.set(
      sessionId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async appendLocked(
    sessionId: string,
    genesis: GenesisContext,
    input: AppendInput,
  ): Promise<EditLogEntry> {
    const log = this.logs.get(sessionId);
    if (!log) throw new Error(`Session ${sessionId} does not exist`);

    const prevHash = log.length === 0 ? genesisHash(genesis) : log[log.length - 1].entry_hash;
    const chained = chainEntry(
      {
        version: input.version,
        steps_json: input.steps_json,
        server_received_at: input.server_received_at,
      },
      prevHash,
    );

    const row: EditLogEntry = {
      id: this.nextId++,
      session_id: sessionId,
      client_meta: input.client_meta ?? null,
      ...chained,
    };
    log.push(row);
    return row;
  }

  async getEntries(sessionId: string): Promise<EditLogEntry[]> {
    return [...(this.logs.get(sessionId) ?? [])];
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.sessions.delete(sessionId);
    this.logs.delete(sessionId);
    this.locks.delete(sessionId);
    return existed;
  }
}
