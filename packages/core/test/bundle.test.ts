/**
 * Definition of Done (build spec §11, M4): a third party can re-verify an
 * exported bundle OFFLINE, with the server down, and reconstruct the document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../src/memstore.js';
import { WritingService } from '../src/service.js';
import { buildBundle, verifyBundle } from '../src/bundle.js';
import { GENESIS, SimClient } from './helpers.js';

async function makeBundle() {
  const store = new InMemoryStore();
  const session = await store.createSession({
    id: GENESIS.session_id,
    assignment_id: GENESIS.assignment_id,
    author_id: GENESIS.author_id,
    server_session_start: GENESIS.server_session_start,
  });
  const client = new SimClient(new WritingService(store));
  await client.type('Paragraph one is here. ', 1);
  await client.type('And a continuation. ', client.doc.content.size - 1);
  await client.split(client.doc.content.size - 1);
  await client.type('Paragraph two.', client.doc.content.size - 1);
  const entries = await store.getEntries(GENESIS.session_id);
  return { bundle: buildBundle(session, entries), client };
}

test('an exported bundle re-verifies offline and reconstructs the document', async () => {
  const { bundle, client } = await makeBundle();

  // Round-trip through JSON, as a real export would (server is now "down").
  const onDisk = JSON.parse(JSON.stringify(bundle));
  const result = verifyBundle(onDisk);

  assert.equal(result.ok, true);
  assert.equal(result.formatOk, true);
  assert.equal(result.chain.ok, true);
  assert.ok(result.reconstructedText && result.reconstructedText.includes('Paragraph one'));
  assert.ok(result.reconstructedText && result.reconstructedText.includes('Paragraph two'));
  assert.equal(result.reconstructedText, client.doc.textBetween(0, client.doc.content.size, '\n', '\n'));
});

test('tampering with a bundle entry is caught by offline verification', async () => {
  const { bundle } = await makeBundle();
  const onDisk = JSON.parse(JSON.stringify(bundle));
  onDisk.entries[1].steps_json = [
    { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'tampered' }] } },
  ];
  const result = verifyBundle(onDisk);
  assert.equal(result.ok, false);
  assert.equal(result.chain.firstDivergenceIndex, 1);
  assert.equal(result.reconstructedText, null);
});

test('a wrong format marker fails the bundle', async () => {
  const { bundle } = await makeBundle();
  const onDisk = JSON.parse(JSON.stringify(bundle));
  onDisk.format = 'something-else';
  assert.equal(verifyBundle(onDisk).ok, false);
});
