/**
 * Wiring: choose stores, seed a demo instructor + assignment + student link, and
 * build the app.
 *
 * With DATABASE_URL set, the authoritative Postgres stores are used and
 * migrations are applied. Without it, in-memory stores run so the slice works
 * with nothing but Node — the integrity and identity model is identical; only
 * durability differs.
 */
import { InMemoryStore, WritingService, type Store } from '@scriptorium/core';
import { createApp } from './app.js';
import { hasDatabase } from './db/pool.js';
import { InMemoryIdentityStore } from './identity/memIdentity.js';
import type { IdentityStore } from './identity/types.js';
import { hashPassword } from './auth/password.js';

export const DEMO_INSTRUCTOR = { email: 'instructor@example.com', password: 'demo-password-123' };
export const DEMO_STUDENT_EMAIL = 'student@example.com';

export interface BuiltApp {
  app: import('express').Express;
  store: Store;
  identity: IdentityStore;
  service: WritingService;
  mode: 'postgres' | 'memory';
  demo: { instructorEmail: string; instructorPassword: string; studentLink: string | null };
}

/**
 * Idempotently ensure a demo instructor, one assignment, and one enrolled
 * student exist, and return the student's capability link. Safe to run on every
 * boot (Postgres persists; memory is fresh each time).
 */
async function seedDemo(
  identity: IdentityStore,
): Promise<{ studentLink: string | null }> {
  let instructor = await identity.getUserByEmail(DEMO_INSTRUCTOR.email);
  if (!instructor) {
    await identity.createUser({
      email: DEMO_INSTRUCTOR.email,
      password_hash: await hashPassword(DEMO_INSTRUCTOR.password),
      role: 'instructor',
    });
    instructor = await identity.getUserByEmail(DEMO_INSTRUCTOR.email);
  }
  if (!instructor) return { studentLink: null };

  let [assignment] = await identity.listAssignmentsByInstructor(instructor.id);
  if (!assignment) {
    assignment = await identity.createAssignment({
      instructor_id: instructor.id,
      title: 'Demo Assignment',
      retention_days: null,
    });
  }

  const student = await identity.getOrCreateStudent(DEMO_STUDENT_EMAIL);
  const token = await identity.mintToken(assignment.id, student.id);
  return { studentLink: `/?token=${token.token}` };
}

export async function buildApp(): Promise<BuiltApp> {
  const allowHardDelete = process.env.ALLOW_HARD_DELETE === 'true';

  let store: Store;
  let identity: IdentityStore;
  let mode: 'postgres' | 'memory';

  if (hasDatabase()) {
    const { migrate } = await import('./db/migrate.js');
    await migrate();
    const { PgStore } = await import('./db/pgStore.js');
    const { PgIdentityStore } = await import('./identity/pgIdentity.js');
    store = new PgStore();
    identity = new PgIdentityStore();
    mode = 'postgres';
  } else {
    store = new InMemoryStore();
    identity = new InMemoryIdentityStore();
    mode = 'memory';
  }

  const { studentLink } = await seedDemo(identity);
  const service = new WritingService(store);

  return {
    app: createApp({ store, identity, service, allowHardDelete }),
    store,
    identity,
    service,
    mode,
    demo: {
      instructorEmail: DEMO_INSTRUCTOR.email,
      instructorPassword: DEMO_INSTRUCTOR.password,
      studentLink,
    },
  };
}
