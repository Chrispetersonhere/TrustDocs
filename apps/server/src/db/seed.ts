/**
 * Seed the M1 hardcoded identity rows so the demo writing_session has a real
 * (author, assignment) to reference under Postgres FK constraints. This is the
 * placeholder identity that M2 (real accounts + per-student links) will replace.
 */
import bcrypt from 'bcryptjs';
import { getPool } from './pool.js';

export async function ensureDemoIdentity(demo: {
  assignmentId: string;
  authorId: string;
}): Promise<void> {
  const pool = getPool();
  const hash = await bcrypt.hash('demo-password', 10);

  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'demo-instructor@example.com', $2, 'instructor')
     ON CONFLICT (id) DO NOTHING`,
    ['00000000-0000-0000-0000-0000000000c1', hash],
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'demo-student@example.com', $2, 'student')
     ON CONFLICT (id) DO NOTHING`,
    [demo.authorId, hash],
  );
  await pool.query(
    `INSERT INTO assignments (id, instructor_id, title)
     VALUES ($1, '00000000-0000-0000-0000-0000000000c1', 'Demo Assignment')
     ON CONFLICT (id) DO NOTHING`,
    [demo.assignmentId],
  );
}
