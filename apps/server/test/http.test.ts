/**
 * End-to-end M1 + M2 acceptance over the real HTTP surface (build spec §10).
 *
 * Drives the whole identity flow: register an instructor, create an assignment,
 * enroll a student, redeem the per-student link to establish the bound session,
 * write through the collab endpoint with the capability token, then prove the
 * document reconstructs from the server alone, the chain verifies, the bundle
 * re-verifies offline, and authorization is enforced (deny-by-default).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Transform } from 'prosemirror-transform';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '@scriptorium/schema';
import { verifyBundle, type EvidenceBundle } from '@scriptorium/core';

delete process.env.DATABASE_URL; // force memory mode

let server: Server;
let base: string;
let instructorCookie = '';
let studentToken = '';
let sessionId = '';
let assignmentId = '';

function setCookieFrom(res: Response) {
  const sc = res.headers.get('set-cookie');
  if (sc) instructorCookie = sc.split(';')[0];
}

const asInstructor = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { 'content-type': 'application/json', cookie: instructorCookie, ...(init.headers ?? {}) },
});
const asStudent = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}`, ...(init.headers ?? {}) },
});

before(async () => {
  const { buildApp } = await import('../src/bootstrap.js');
  const { app } = await buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server?.close());

test('an instructor can register and is issued a session cookie', async () => {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'prof@example.com', password: 'supersecret' }),
  });
  assert.equal(res.status, 200);
  setCookieFrom(res);
  assert.ok(instructorCookie.startsWith('sid='));
  const me = await fetch(`${base}/api/auth/me`, asInstructor());
  assert.equal((await me.json()).user.email, 'prof@example.com');
});

test('weak passwords and duplicate emails are rejected', async () => {
  const weak = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', password: 'short' }),
  });
  assert.equal(weak.status, 400);
  const dup = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'prof@example.com', password: 'supersecret' }),
  });
  assert.equal(dup.status, 409);
});

test('instructor creates an assignment and enrolls a student, getting a per-student link', async () => {
  const a = await fetch(
    `${base}/api/assignments`,
    asInstructor({ method: 'POST', body: JSON.stringify({ title: 'Essay 1', retention_days: 30 }) }),
  ).then((r) => r.json());
  assignmentId = a.assignment.id;
  assert.ok(assignmentId);

  const enroll = await fetch(
    `${base}/api/assignments/${assignmentId}/students`,
    asInstructor({ method: 'POST', body: JSON.stringify({ email: 'student@example.com' }) }),
  ).then((r) => r.json());
  studentToken = enroll.token;
  assert.ok(studentToken);
  assert.equal(enroll.link, `/?token=${studentToken}`);
});

test('assignment management requires an instructor session', async () => {
  const res = await fetch(`${base}/api/assignments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'no auth' }),
  });
  assert.equal(res.status, 401);
});

test('redeeming the student link establishes the bound writing session', async () => {
  const redeemed = await fetch(
    `${base}/api/session`,
    asStudent({ method: 'POST', body: JSON.stringify({}) }),
  ).then((r) => r.json());
  sessionId = redeemed.sessionId;
  assert.ok(sessionId);
  assert.equal(redeemed.assignmentTitle, 'Essay 1');
  assert.equal(redeemed.studentEmail, 'student@example.com');

  // Idempotent: redeeming again returns the same session.
  const again = await fetch(
    `${base}/api/session`,
    asStudent({ method: 'POST', body: JSON.stringify({}) }),
  ).then((r) => r.json());
  assert.equal(again.sessionId, sessionId);
});

async function getDoc(): Promise<{ version: number; doc: PMNode }> {
  const r = await fetch(`${base}/api/sessions/${sessionId}/doc`, asStudent()).then((x) => x.json());
  return { version: r.version, doc: PMNode.fromJSON(schema, r.doc) };
}

test('the bound student can write, and edits reconstruct from the server alone', async () => {
  let { version, doc } = await getDoc();
  for (const phrase of ['Hello, world. ', 'A second sentence. ', 'And a third.']) {
    const tr = new Transform(doc);
    tr.insert(doc.content.size - 1, schema.text(phrase));
    const res = await fetch(
      `${base}/api/sessions/${sessionId}/steps`,
      asStudent({
        method: 'POST',
        body: JSON.stringify({ version, clientID: 'http', steps: tr.steps.map((s) => s.toJSON()) }),
      }),
    ).then((x) => x.json());
    assert.equal(res.status, 'accepted');
    version = res.version;
    doc = tr.doc;
  }
  const fromServer = await getDoc();
  assert.equal(fromServer.doc.toString(), doc.toString());
  assert.ok(fromServer.doc.textContent.includes('Hello, world.'));
});

test('a missing or wrong token is denied (deny-by-default)', async () => {
  const noAuth = await fetch(`${base}/api/sessions/${sessionId}/doc`);
  assert.equal(noAuth.status, 403);
  const wrong = await fetch(`${base}/api/sessions/${sessionId}/doc`, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(wrong.status, 403);
});

test('the owning instructor can read the session but cannot write to it', async () => {
  const log = await fetch(`${base}/api/sessions/${sessionId}/log`, asInstructor());
  assert.equal(log.status, 200);
  const { doc } = await getDoc();
  const tr = new Transform(doc);
  tr.insert(1, schema.text('instructor edit'));
  const write = await fetch(
    `${base}/api/sessions/${sessionId}/steps`,
    asInstructor({
      method: 'POST',
      body: JSON.stringify({ version: 999, clientID: 'prof', steps: tr.steps.map((s) => s.toJSON()) }),
    }),
  );
  assert.equal(write.status, 403);
});

test('a second instructor cannot read another instructor\'s session', async () => {
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'other@example.com', password: 'supersecret' }),
  });
  const otherCookie = (reg.headers.get('set-cookie') ?? '').split(';')[0];
  const res = await fetch(`${base}/api/sessions/${sessionId}/log`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(res.status, 403);
});

test('the chain verifies and the exported bundle re-verifies offline', async () => {
  const verify = await fetch(`${base}/api/sessions/${sessionId}/verify`, asStudent()).then((x) =>
    x.json(),
  );
  assert.equal(verify.ok, true);

  const bundle = (await fetch(`${base}/api/sessions/${sessionId}/bundle`, asStudent()).then((x) =>
    x.json(),
  )) as EvidenceBundle;
  const offline = verifyBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(offline.ok, true);
  assert.ok(offline.reconstructedText?.includes('Hello, world.'));
});

test('the instructor dashboard lists the submission with live stats', async () => {
  const detail = await fetch(`${base}/api/assignments/${assignmentId}`, asInstructor()).then((r) =>
    r.json(),
  );
  assert.equal(detail.assignment.title, 'Essay 1');
  const student = detail.students.find((s: { email: string }) => s.email === 'student@example.com');
  assert.ok(student);
  assert.equal(student.session.sessionId, sessionId);
  assert.ok(student.session.entryCount >= 3);
  assert.equal(student.session.chainOk, true);
});

test('evidence endpoint returns server-derived signals and no verdict', async () => {
  const { version, doc } = await getDoc();
  const tr = new Transform(doc);
  tr.insert(doc.content.size - 1, schema.text('Z'.repeat(300)));
  await fetch(
    `${base}/api/sessions/${sessionId}/steps`,
    asStudent({
      method: 'POST',
      body: JSON.stringify({
        version,
        clientID: 'http',
        steps: tr.steps.map((s) => s.toJSON()),
        client_meta: { clientClaimedPaste: true },
      }),
    }),
  );

  const ev = await fetch(`${base}/api/sessions/${sessionId}/evidence`, asStudent()).then((x) =>
    x.json(),
  );
  assert.ok(ev.largeInsertions.events.length >= 1);
  assert.ok(ev.clientAssertedAnnotations.some((a: { trusted: boolean }) => a.trusted === false));
  const { disclaimer, ...rest } = ev;
  assert.ok(typeof disclaimer === 'string' && disclaimer.length > 0);
  const blob = JSON.stringify(rest).toLowerCase();
  for (const banned of ['score', 'probability', 'verdict', 'likelihood', 'cheat']) {
    assert.ok(!blob.includes(banned), `evidence payload must not contain "${banned}"`);
  }
});

test('hard-delete is disabled by default (returns 403)', async () => {
  const r = await fetch(`${base}/api/sessions/${sessionId}`, asInstructor({ method: 'DELETE' }));
  assert.equal(r.status, 403);
});
