/**
 * Postgres IdentityStore (build spec §9). Uniqueness is enforced by the schema:
 * users.email UNIQUE, assignment_tokens UNIQUE(assignment_id, student_id).
 */
import type pg from 'pg';
import { randomToken } from '../auth/password.js';
import { getPool } from '../db/pool.js';
import type {
  Assignment,
  AssignmentToken,
  IdentityStore,
  ResolvedToken,
  Role,
  User,
} from './types.js';

function rowToAssignment(r: any): Assignment {
  return {
    id: r.id,
    instructor_id: r.instructor_id,
    title: r.title,
    created_at: new Date(r.created_at).toISOString(),
    retention_days: r.retention_days ?? null,
  };
}

export class PgIdentityStore implements IdentityStore {
  private pool: pg.Pool;
  constructor(pool: pg.Pool = getPool()) {
    this.pool = pool;
  }

  async createUser(input: { email: string; password_hash: string; role: Role }): Promise<User> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
         RETURNING id, email, role`,
        [input.email.toLowerCase(), input.password_hash, input.role],
      );
      return rows[0];
    } catch (err: any) {
      if (err?.code === '23505') throw new Error('email_taken');
      throw err;
    }
  }

  async getUserByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
    const { rows } = await this.pool.query(
      'SELECT id, email, role, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT id, email, role FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async getOrCreateStudent(email: string): Promise<User> {
    const existing = await this.getUserByEmail(email);
    if (existing) {
      if (existing.role !== 'student') throw new Error('email_belongs_to_non_student');
      return { id: existing.id, email: existing.email, role: existing.role };
    }
    // '!' is an un-loginable placeholder hash; students authenticate by token.
    return this.createUser({ email, password_hash: '!', role: 'student' });
  }

  async createAuthSession(token: string, userId: string): Promise<void> {
    await this.pool.query('INSERT INTO auth_sessions (token, user_id) VALUES ($1, $2)', [
      token,
      userId,
    ]);
  }

  async getAuthSession(token: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.email, u.role FROM auth_sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
      [token],
    );
    return rows[0] ?? null;
  }

  async deleteAuthSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
  }

  async createAssignment(input: {
    instructor_id: string;
    title: string;
    retention_days: number | null;
  }): Promise<Assignment> {
    const { rows } = await this.pool.query(
      `INSERT INTO assignments (instructor_id, title, retention_days)
       VALUES ($1, $2, $3) RETURNING *`,
      [input.instructor_id, input.title, input.retention_days],
    );
    return rowToAssignment(rows[0]);
  }

  async getAssignment(id: string): Promise<Assignment | null> {
    const { rows } = await this.pool.query('SELECT * FROM assignments WHERE id = $1', [id]);
    return rows[0] ? rowToAssignment(rows[0]) : null;
  }

  async listAssignmentsByInstructor(instructorId: string): Promise<Assignment[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM assignments WHERE instructor_id = $1 ORDER BY created_at',
      [instructorId],
    );
    return rows.map(rowToAssignment);
  }

  async mintToken(assignmentId: string, studentId: string): Promise<AssignmentToken> {
    const token = randomToken();
    const { rows } = await this.pool.query(
      `INSERT INTO assignment_tokens (token, assignment_id, student_id)
         VALUES ($1, $2, $3)
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET assignment_id = EXCLUDED.assignment_id
       RETURNING token, assignment_id, student_id, created_at`,
      [token, assignmentId, studentId],
    );
    const r = rows[0];
    const student = await this.getUserById(studentId);
    return {
      token: r.token,
      assignment_id: r.assignment_id,
      student_id: r.student_id,
      student_email: student?.email ?? '',
      created_at: new Date(r.created_at).toISOString(),
    };
  }

  async getToken(token: string): Promise<ResolvedToken | null> {
    const { rows } = await this.pool.query(
      `SELECT t.token, u.id AS student_id, u.email AS student_email, u.role AS student_role,
              a.id AS a_id, a.instructor_id, a.title, a.created_at AS a_created, a.retention_days
         FROM assignment_tokens t
         JOIN users u ON u.id = t.student_id
         JOIN assignments a ON a.id = t.assignment_id
        WHERE t.token = $1`,
      [token],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      token: r.token,
      student: { id: r.student_id, email: r.student_email, role: r.student_role },
      assignment: {
        id: r.a_id,
        instructor_id: r.instructor_id,
        title: r.title,
        created_at: new Date(r.a_created).toISOString(),
        retention_days: r.retention_days ?? null,
      },
    };
  }

  async listTokensByAssignment(assignmentId: string): Promise<AssignmentToken[]> {
    const { rows } = await this.pool.query(
      `SELECT t.token, t.assignment_id, t.student_id, t.created_at, u.email AS student_email
         FROM assignment_tokens t JOIN users u ON u.id = t.student_id
        WHERE t.assignment_id = $1 ORDER BY t.created_at`,
      [assignmentId],
    );
    return rows.map((r: any) => ({
      token: r.token,
      assignment_id: r.assignment_id,
      student_id: r.student_id,
      student_email: r.student_email,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }
}
