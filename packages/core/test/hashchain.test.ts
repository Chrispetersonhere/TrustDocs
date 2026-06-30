/**
 * Hash-chain and canonicalization unit tests (build spec §7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/canonical.js';
import { genesisHash, chainEntry, computeEntryHash, verifyChain } from '../src/hashchain.js';
import { GENESIS } from './helpers.js';

test('canonicalJson sorts keys deterministically regardless of insertion order', () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('canonicalJson preserves array order and rejects non-finite numbers', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.throws(() => canonicalJson(Number.NaN));
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY));
});

test('canonicalJson drops undefined object properties like JSON does', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('genesis hash binds to the session context', () => {
  const h1 = genesisHash(GENESIS);
  const h2 = genesisHash({ ...GENESIS, session_id: 'other' });
  assert.notEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('entry hash depends on prev_hash, version, steps, and receipt time', () => {
  const core = {
    version: 1,
    steps_json: [{ stepType: 'replace', from: 1, to: 1 }],
    server_received_at: '2026-01-01T00:00:01.000Z',
  };
  const prev = genesisHash(GENESIS);
  const base = computeEntryHash(core, prev);
  assert.notEqual(base, computeEntryHash({ ...core, version: 2 }, prev));
  assert.notEqual(base, computeEntryHash({ ...core, server_received_at: '2026-01-01T00:00:02.000Z' }, prev));
  assert.notEqual(base, computeEntryHash(core, genesisHash({ ...GENESIS, author_id: 'x' })));
});

test('a hand-built chain verifies forward from genesis', () => {
  const prev0 = genesisHash(GENESIS);
  const e1 = chainEntry(
    { version: 1, steps_json: [{ s: 1 }], server_received_at: '2026-01-01T00:00:01.000Z' },
    prev0,
  );
  const e2 = chainEntry(
    { version: 2, steps_json: [{ s: 2 }], server_received_at: '2026-01-01T00:00:02.000Z' },
    e1.entry_hash,
  );
  assert.equal(e2.prev_hash, e1.entry_hash);
  assert.equal(verifyChain(GENESIS, [e1, e2]).ok, true);
});

test('an empty chain verifies (genesis well-formed)', () => {
  assert.equal(verifyChain(GENESIS, []).ok, true);
});
