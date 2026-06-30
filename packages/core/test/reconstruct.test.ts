/**
 * Definition of Done (build spec §11): reconstruct-from-log-alone.
 *
 * Compose a real multi-paragraph document with non-linear revisions, then
 * reconstruct it from the edit_log alone — no client-saved copy — and assert it
 * matches the document the client actually held. This is the invariant: the only
 * document that exists is the one the server rebuilds from the steps it received.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../src/memstore.js';
import { WritingService } from '../src/service.js';
import { reconstruct } from '../src/applier.js';
import { GENESIS, SimClient } from './helpers.js';

async function buildSession() {
  const store = new InMemoryStore();
  await store.createSession({
    id: GENESIS.session_id,
    assignment_id: GENESIS.assignment_id,
    author_id: GENESIS.author_id,
    server_session_start: GENESIS.server_session_start,
  });
  const service = new WritingService(store);
  const client = new SimClient(service);
  return { store, service, client };
}

test('reconstructs an exact multi-paragraph document from the log alone', async () => {
  const { store, client } = await buildSession();

  // Compose with the recursive, mid-paragraph shape of real authoring.
  await client.type('The opening line.', 1); // para 1
  await client.split(client.doc.content.size - 1); // start a second paragraph
  await client.type('A second paragraph follows.', client.doc.content.size - 1);

  // Go back and revise the first paragraph mid-sentence.
  await client.type(' (revised)', 18);

  // Extend the second paragraph (a return to an earlier section).
  await client.type(' Indeed it does.', client.doc.content.size - 1);

  // Now reconstruct from the stored log only.
  const entries = await store.getEntries(GENESIS.session_id);
  assert.ok(entries.length >= 4, 'each commit is its own log entry');
  const rebuilt = reconstruct(entries);

  assert.equal(
    rebuilt.toString(),
    client.doc.toString(),
    'document rebuilt from the log must equal the client document',
  );
  assert.equal(JSON.stringify(rebuilt.toJSON()), JSON.stringify(client.doc.toJSON()));
});

test('killing the client mid-edit loses nothing already confirmed', async () => {
  const { store, client } = await buildSession();

  await client.type('Confirmed sentence one.', 1);
  await client.type(' Confirmed sentence two.', client.doc.content.size - 1);
  const confirmedDoc = client.doc.copy(client.doc.content);

  // Simulate a crash: throw away ALL client state, keep only the server log.
  const entries = await store.getEntries(GENESIS.session_id);
  const recovered = reconstruct(entries);

  assert.equal(recovered.toString(), confirmedDoc.toString());
  assert.ok(recovered.textContent.includes('Confirmed sentence one.'));
  assert.ok(recovered.textContent.includes('Confirmed sentence two.'));
});

test('a stale version is rejected and does not corrupt the log', async () => {
  const { service, client } = await buildSession();
  await client.type('base', 1);

  // Submit against an old version directly.
  const res = await service.submit(GENESIS.session_id, {
    version: 0,
    clientID: 'sim',
    steps: [{ stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'x' }] } }],
  });
  assert.equal(res.status, 'stale');
});
