/**
 * Definition of Done (build spec §11, M4 acceptance): the tamper test.
 *
 * Altering one edit_log entry's steps_json causes verification to fail AT that
 * entry and EVERY entry after it, and NOWHERE before it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../src/memstore.js';
import { WritingService } from '../src/service.js';
import { verifyChain, type ChainedEntry } from '../src/hashchain.js';
import { GENESIS, SimClient } from './helpers.js';

async function buildChain(commits = 6): Promise<{ store: InMemoryStore }> {
  const store = new InMemoryStore();
  await store.createSession({
    id: GENESIS.session_id,
    assignment_id: GENESIS.assignment_id,
    author_id: GENESIS.author_id,
    server_session_start: GENESIS.server_session_start,
  });
  const client = new SimClient(new WritingService(store));
  await client.type('Start. ', 1);
  for (let i = 1; i < commits; i++) {
    await client.type(`edit number ${i}. `, client.doc.content.size - 1);
  }
  return { store };
}

function toChained(entries: Awaited<ReturnType<InMemoryStore['getEntries']>>): ChainedEntry[] {
  return entries.map((e) => ({
    version: e.version,
    steps_json: e.steps_json,
    server_received_at: e.server_received_at,
    prev_hash: e.prev_hash,
    entry_hash: e.entry_hash,
  }));
}

test('an untampered chain verifies fully', async () => {
  const { store } = await buildChain();
  const entries = toChained(await store.getEntries(GENESIS.session_id));
  const result = verifyChain(GENESIS, entries);
  assert.equal(result.ok, true);
  assert.equal(result.firstDivergenceIndex, null);
  assert.equal(result.verifiedCount, entries.length);
});

test('altering one entry fails verification at that entry and every entry after — and nowhere before', async () => {
  const { store } = await buildChain(7);
  const entries = toChained(await store.getEntries(GENESIS.session_id));
  const tamperIndex = 3;

  // Tamper: rewrite steps_json of entry 3 to insert different text. The stored
  // entry_hash is left as-is (an attacker who can't recompute the whole forward
  // chain), modeling a raw DB row edit.
  const tampered = entries.map((e, i) =>
    i === tamperIndex
      ? {
          ...e,
          steps_json: [
            { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'SECRETLY CHANGED' }] } },
          ],
        }
      : e,
  );

  const result = verifyChain(GENESIS, tampered);
  assert.equal(result.ok, false);
  assert.equal(result.firstDivergenceIndex, tamperIndex, 'fails exactly at the tampered entry');
  assert.equal(result.verifiedCount, tamperIndex, 'entries before it verify');

  // Every entry strictly before the tamper verifies on its own prefix.
  const prefix = tampered.slice(0, tamperIndex);
  assert.equal(verifyChain(GENESIS, prefix).ok, true, 'the untouched prefix is intact');
});

test('a sophisticated attacker who recomputes the tampered entry hash still fails at the next entry', async () => {
  const { store } = await buildChain(6);
  const entries = toChained(await store.getEntries(GENESIS.session_id));
  const tamperIndex = 2;

  // Recompute entry_hash for the tampered entry so it is internally consistent.
  // The chain still breaks at the NEXT entry, whose prev_hash no longer matches.
  const { computeEntryHash } = await import('../src/hashchain.js');
  const tampered = entries.map((e) => ({ ...e }));
  tampered[tamperIndex].steps_json = [
    { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'FORGED' }] } },
  ];
  tampered[tamperIndex].entry_hash = computeEntryHash(tampered[tamperIndex], tampered[tamperIndex].prev_hash);

  const result = verifyChain(GENESIS, tampered);
  assert.equal(result.ok, false);
  assert.equal(
    result.firstDivergenceIndex,
    tamperIndex + 1,
    'the forward link is broken at the entry following the tamper',
  );
});

test('deleting a middle entry breaks the chain (append-only is enforced by verification)', async () => {
  const { store } = await buildChain(6);
  const entries = toChained(await store.getEntries(GENESIS.session_id));
  const without = [...entries.slice(0, 3), ...entries.slice(4)];
  const result = verifyChain(GENESIS, without);
  assert.equal(result.ok, false);
  assert.equal(result.firstDivergenceIndex, 3);
});
