/**
 * End-to-end M1 acceptance over the real HTTP surface (build spec §10, M1).
 *
 * Boots the app with the in-memory store, submits real ProseMirror steps to the
 * collab endpoint, then proves: the document reconstructs from the server alone,
 * the chain verifies, and the exported bundle re-verifies offline.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Transform } from 'prosemirror-transform';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '@scriptorium/schema';
import { verifyBundle, type EvidenceBundle } from '@scriptorium/core';

// Force memory mode regardless of the ambient environment.
delete process.env.DATABASE_URL;

let server: Server;
let base: string;
let sessionId: string;

before(async () => {
  const { buildApp, DEMO } = await import('../src/bootstrap.js');
  sessionId = DEMO.sessionId;
  const { app } = await buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
});

async function getDoc(): Promise<{ version: number; doc: PMNode }> {
  const r = await fetch(`${base}/api/sessions/${sessionId}/doc`).then((x) => x.json());
  return { version: r.version, doc: PMNode.fromJSON(schema, r.doc) };
}

async function submit(version: number, tr: Transform, clientMeta?: unknown) {
  return fetch(`${base}/api/sessions/${sessionId}/steps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version,
      clientID: 'http-test',
      steps: tr.steps.map((s) => s.toJSON()),
      ...(clientMeta ? { client_meta: clientMeta } : {}),
    }),
  }).then((x) => x.json());
}

test('healthz responds', async () => {
  const r = await fetch(`${base}/healthz`).then((x) => x.json());
  assert.equal(r.status, 'ok');
});

test('typed steps land server-side in order and reconstruct from the server alone', async () => {
  let { version, doc } = await getDoc();

  // Type three eager batches, advancing the version each time.
  for (const phrase of ['Hello, world. ', 'A second sentence. ', 'And a third.']) {
    const tr = new Transform(doc);
    tr.insert(doc.content.size - 1, schema.text(phrase));
    const res = await submit(version, tr);
    assert.equal(res.status, 'accepted');
    version = res.version;
    doc = tr.doc;
  }

  // Re-fetch the document from the server (rebuilt from the log alone).
  const fromServer = await getDoc();
  assert.equal(fromServer.doc.toString(), doc.toString());
  assert.ok(fromServer.doc.textContent.includes('Hello, world.'));
  assert.ok(fromServer.doc.textContent.includes('And a third.'));
});

test('a stale submission is reported as stale, not applied', async () => {
  const tr = new Transform((await getDoc()).doc);
  tr.insert(1, schema.text('x'));
  const res = await submit(0, tr); // version 0 is long stale now
  assert.equal(res.status, 'stale');
});

test('the chain verifies and the exported bundle re-verifies offline', async () => {
  const verify = await fetch(`${base}/api/sessions/${sessionId}/verify`).then((x) => x.json());
  assert.equal(verify.ok, true);
  assert.equal(verify.firstDivergenceIndex, null);

  const bundle = (await fetch(`${base}/api/sessions/${sessionId}/bundle`).then((x) =>
    x.json(),
  )) as EvidenceBundle;
  // Simulate the server being down: verify the parsed bundle purely in-process.
  const offline = verifyBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(offline.ok, true);
  assert.ok(offline.reconstructedText?.includes('Hello, world.'));
});

test('evidence endpoint returns server-derived signals and no verdict', async () => {
  // Insert one large block to trip the server-derived large-insertion signal.
  const { version, doc } = await getDoc();
  const tr = new Transform(doc);
  tr.insert(doc.content.size - 1, schema.text('Z'.repeat(300)));
  const res = await submit(version, tr, { clientClaimedPaste: true });
  assert.equal(res.status, 'accepted');

  const ev = await fetch(`${base}/api/sessions/${sessionId}/evidence`).then((x) => x.json());
  assert.ok(ev.largeInsertions.events.length >= 1);
  assert.equal(ev.largeInsertions.events.at(-1).insertedChars, 300);
  // The client-claimed paste is surfaced but explicitly untrusted.
  assert.ok(ev.clientAssertedAnnotations.some((a: { trusted: boolean }) => a.trusted === false));
  // No verdict/score field anywhere in the payload. The disclaimer legitimately
  // names these words to say the tool computes none of them, so exclude it.
  const { disclaimer, ...rest } = ev;
  assert.ok(typeof disclaimer === 'string' && disclaimer.length > 0);
  const blob = JSON.stringify(rest).toLowerCase();
  for (const banned of ['score', 'probability', 'verdict', 'likelihood', 'cheat']) {
    assert.ok(!blob.includes(banned), `evidence payload must not contain "${banned}"`);
  }
});

test('hard-delete is disabled by default (returns 403)', async () => {
  const r = await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' });
  assert.equal(r.status, 403);
});
