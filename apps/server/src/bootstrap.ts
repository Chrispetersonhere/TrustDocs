/**
 * Wiring: choose a store, seed the M1 hardcoded author + assignment, build the app.
 *
 * With DATABASE_URL set, the authoritative Postgres store is used and migrations
 * are applied. Without it, an in-memory store runs so an instructor can try the
 * vertical slice with nothing but Node — the integrity model is identical; only
 * durability differs.
 */
import {
  InMemoryStore,
  WritingService,
  type Store,
} from '@scriptorium/core';
import { createApp } from './app.js';
import { hasDatabase } from './db/pool.js';

// M1 hardcoded identity (build spec §10, M1: "one hardcoded author + one
// hardcoded assignment, no real auth yet"). M2 replaces this with real accounts.
export const DEMO = {
  sessionId: '00000000-0000-0000-0000-000000000001',
  assignmentId: '00000000-0000-0000-0000-0000000000a1',
  authorId: '00000000-0000-0000-0000-0000000000b1',
};

export interface BuiltApp {
  app: import('express').Express;
  store: Store;
  service: WritingService;
  mode: 'postgres' | 'memory';
}

async function seedDemoSession(store: Store): Promise<void> {
  const existing = await store.getSession(DEMO.sessionId);
  if (existing) return;
  await store.createSession({
    id: DEMO.sessionId,
    assignment_id: DEMO.assignmentId,
    author_id: DEMO.authorId,
    server_session_start: new Date().toISOString(),
  });
}

export async function buildApp(): Promise<BuiltApp> {
  const allowHardDelete = process.env.ALLOW_HARD_DELETE === 'true';

  if (hasDatabase()) {
    const { migrate } = await import('./db/migrate.js');
    await migrate();
    const { PgStore } = await import('./db/pgStore.js');
    const { ensureDemoIdentity } = await import('./db/seed.js');
    const store = new PgStore();
    await ensureDemoIdentity(DEMO);
    await seedDemoSession(store);
    const service = new WritingService(store);
    return {
      app: createApp({ store, service, allowHardDelete }),
      store,
      service,
      mode: 'postgres',
    };
  }

  const store = new InMemoryStore();
  await seedDemoSession(store);
  const service = new WritingService(store);
  return {
    app: createApp({ store, service, allowHardDelete }),
    store,
    service,
    mode: 'memory',
  };
}
