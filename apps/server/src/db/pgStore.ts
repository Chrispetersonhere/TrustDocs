/**
 * Postgres-backed Store (build spec §7). Enforces the same invariants as the
 * in-memory store, with append serialized by a row lock on writing_sessions so
 * the prev_hash chained onto is always the true head — no interleaving.
 */
import type pg from 'pg';
import {
  chainEntry,
  genesisHash,
  type AppendInput,
  type EditLogEntry,
  type GenesisContext,
  type Store,
  type WritingSessionRecord,
} from '@scriptorium/core';
import { getPool } from './pool.js';

function rowToSession(r: any): WritingSessionRecord {
  return {
    id: r.id,
    assignment_id: r.assignment_id,
    author_id: r.author_id,
    server_session_start: new Date(r.server_session_start).toISOString(),
    status: r.status,
  };
}

function rowToEntry(r: any): EditLogEntry {
  return {
    id: Number(r.id),
    session_id: r.session_id,
    version: r.version,
    steps_json: r.steps_json,
    server_received_at: new Date(r.server_received_at).toISOString(),
    client_meta: r.client_meta ?? null,
    prev_hash: r.prev_hash,
    entry_hash: r.entry_hash,
  };
}

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(pool: pg.Pool = getPool()) {
    this.pool = pool;
  }

  async createSession(input: {
    id: string;
    assignment_id: string;
    author_id: string;
    server_session_start: string;
  }): Promise<WritingSessionRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO writing_sessions (id, assignment_id, author_id, server_session_start)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.id, input.assignment_id, input.author_id, input.server_session_start],
    );
    return rowToSession(rows[0]);
  }

  async getSession(sessionId: string): Promise<WritingSessionRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM writing_sessions WHERE id = $1', [
      sessionId,
    ]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async listSessions(assignmentId?: string): Promise<WritingSessionRecord[]> {
    const { rows } = assignmentId
      ? await this.pool.query(
          'SELECT * FROM writing_sessions WHERE assignment_id = $1 ORDER BY server_session_start',
          [assignmentId],
        )
      : await this.pool.query('SELECT * FROM writing_sessions ORDER BY server_session_start');
    return rows.map(rowToSession);
  }

  async getCurrentVersion(sessionId: string): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT version FROM edit_log WHERE session_id = $1 ORDER BY id DESC LIMIT 1',
      [sessionId],
    );
    return rows[0] ? rows[0].version : 0;
  }

  async getHeadHash(sessionId: string, genesis: GenesisContext): Promise<string> {
    const { rows } = await this.pool.query(
      'SELECT entry_hash FROM edit_log WHERE session_id = $1 ORDER BY id DESC LIMIT 1',
      [sessionId],
    );
    return rows[0] ? rows[0].entry_hash : genesisHash(genesis);
  }

  async appendEntry(
    sessionId: string,
    genesis: GenesisContext,
    input: AppendInput,
  ): Promise<EditLogEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize appends for this session: lock the session row.
      const locked = await client.query('SELECT id FROM writing_sessions WHERE id = $1 FOR UPDATE', [
        sessionId,
      ]);
      if (locked.rowCount === 0) throw new Error(`Session ${sessionId} does not exist`);

      const head = await client.query(
        'SELECT entry_hash FROM edit_log WHERE session_id = $1 ORDER BY id DESC LIMIT 1',
        [sessionId],
      );
      const prevHash = head.rows[0] ? head.rows[0].entry_hash : genesisHash(genesis);

      const chained = chainEntry(
        {
          version: input.version,
          steps_json: input.steps_json,
          server_received_at: input.server_received_at,
        },
        prevHash,
      );

      const inserted = await client.query(
        `INSERT INTO edit_log
           (session_id, version, steps_json, server_received_at, client_meta, prev_hash, entry_hash)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
         RETURNING *`,
        [
          sessionId,
          chained.version,
          JSON.stringify(chained.steps_json),
          chained.server_received_at,
          input.client_meta == null ? null : JSON.stringify(input.client_meta),
          chained.prev_hash,
          chained.entry_hash,
        ],
      );
      await client.query('COMMIT');
      return rowToEntry(inserted.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getEntries(sessionId: string): Promise<EditLogEntry[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM edit_log WHERE session_id = $1 ORDER BY id ASC',
      [sessionId],
    );
    return rows.map(rowToEntry);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // The sanctioned hard-delete (§9). ON DELETE CASCADE removes edit_log rows.
    const { rowCount } = await this.pool.query('DELETE FROM writing_sessions WHERE id = $1', [
      sessionId,
    ]);
    return Boolean(rowCount && rowCount > 0);
  }
}
