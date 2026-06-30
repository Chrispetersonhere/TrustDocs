/**
 * Minimal forward-only migration runner. Applies every migrations/*.sql file once,
 * tracked in a schema_migrations table. Idempotent.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const pool = getPool();
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rowCount && rowCount > 0) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

// Allow `pnpm migrate` to run this directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then((applied) => {
      console.log(
        applied.length ? `Applied migrations: ${applied.join(', ')}` : 'No new migrations.',
      );
      return import('./pool.js').then((m) => m.closePool());
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
