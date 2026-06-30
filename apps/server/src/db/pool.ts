import pg from 'pg';

let pool: pg.Pool | null = null;

/** Lazily construct the shared pg Pool from DATABASE_URL. */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set; cannot create a Postgres pool');
    }
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
