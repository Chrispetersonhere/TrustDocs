/**
 * Retention enforcement (build spec §9): purge sessions whose assignment
 * retention_days window has elapsed. This is the sanctioned exception to
 * append-only — a real hard-delete of the session and its edit_log rows.
 *
 * Usage:  retention --apply        actually delete expired sessions
 *         retention                 dry-run; list what would be deleted
 *
 * Requires DATABASE_URL.
 */
import { getPool, closePool } from '../db/pool.js';

interface ExpiredRow {
  id: string;
  assignment_id: string;
  retention_days: number;
  server_session_start: string;
}

async function findExpired(): Promise<ExpiredRow[]> {
  const { rows } = await getPool().query(
    `SELECT ws.id, ws.assignment_id, a.retention_days, ws.server_session_start
       FROM writing_sessions ws
       JOIN assignments a ON a.id = ws.assignment_id
      WHERE a.retention_days IS NOT NULL
        AND ws.server_session_start < now() - (a.retention_days || ' days')::interval`,
  );
  return rows as ExpiredRow[];
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('retention requires DATABASE_URL to be set.');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  try {
    const expired = await findExpired();
    if (expired.length === 0) {
      console.log('No sessions past their retention window.');
      return;
    }
    console.log(`${expired.length} session(s) past retention:`);
    for (const r of expired) {
      console.log(`  ${r.id} (assignment ${r.assignment_id}, retention ${r.retention_days}d)`);
    }
    if (!apply) {
      console.log('\nDry run. Re-run with --apply to permanently purge these sessions.');
      return;
    }
    for (const r of expired) {
      // ON DELETE CASCADE removes the edit_log rows with the session.
      await getPool().query('DELETE FROM writing_sessions WHERE id = $1', [r.id]);
      console.log(`Purged ${r.id}`);
    }
    console.log(`\nPurged ${expired.length} session(s).`);
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
