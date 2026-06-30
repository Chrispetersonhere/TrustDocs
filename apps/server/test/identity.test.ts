/**
 * Identity store invariants (build spec §9, M2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryIdentityStore } from '../src/identity/memIdentity.js';

test('emails are unique and case-insensitive', async () => {
  const id = new InMemoryIdentityStore();
  await id.createUser({ email: 'Prof@example.com', password_hash: 'h', role: 'instructor' });
  await assert.rejects(
    id.createUser({ email: 'prof@example.com', password_hash: 'h', role: 'instructor' }),
    /email_taken/,
  );
  const found = await id.getUserByEmail('PROF@example.com');
  assert.equal(found?.email, 'prof@example.com');
});

test('getOrCreateStudent is idempotent and returns the same student', async () => {
  const id = new InMemoryIdentityStore();
  const a = await id.getOrCreateStudent('s@example.com');
  const b = await id.getOrCreateStudent('s@example.com');
  assert.equal(a.id, b.id);
  assert.equal(a.role, 'student');
});

test('a token resolves to exactly its (assignment, student) and is stable per pair', async () => {
  const id = new InMemoryIdentityStore();
  const prof = await id.createUser({ email: 'p@example.com', password_hash: 'h', role: 'instructor' });
  const assignment = await id.createAssignment({
    instructor_id: prof.id,
    title: 'Essay 1',
    retention_days: null,
  });
  const student = await id.getOrCreateStudent('s@example.com');

  const t1 = await id.mintToken(assignment.id, student.id);
  const t2 = await id.mintToken(assignment.id, student.id);
  assert.equal(t1.token, t2.token, 'one token per (assignment, student)');

  const resolved = await id.getToken(t1.token);
  assert.equal(resolved?.assignment.id, assignment.id);
  assert.equal(resolved?.student.id, student.id);
  assert.equal(await id.getToken('not-a-real-token'), null);
});

test('two students in one assignment get distinct tokens', async () => {
  const id = new InMemoryIdentityStore();
  const prof = await id.createUser({ email: 'p2@example.com', password_hash: 'h', role: 'instructor' });
  const assignment = await id.createAssignment({
    instructor_id: prof.id,
    title: 'Essay',
    retention_days: null,
  });
  const s1 = await id.getOrCreateStudent('a@example.com');
  const s2 = await id.getOrCreateStudent('b@example.com');
  const t1 = await id.mintToken(assignment.id, s1.id);
  const t2 = await id.mintToken(assignment.id, s2.id);
  assert.notEqual(t1.token, t2.token);
  assert.equal((await id.listTokensByAssignment(assignment.id)).length, 2);
});

test('auth sessions resolve to their instructor and can be revoked', async () => {
  const id = new InMemoryIdentityStore();
  const prof = await id.createUser({ email: 'p3@example.com', password_hash: 'h', role: 'instructor' });
  await id.createAuthSession('tok-abc', prof.id);
  assert.equal((await id.getAuthSession('tok-abc'))?.id, prof.id);
  await id.deleteAuthSession('tok-abc');
  assert.equal(await id.getAuthSession('tok-abc'), null);
});
