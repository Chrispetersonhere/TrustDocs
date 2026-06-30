/**
 * Server-derived evidence tests (build spec §8).
 * These assert signals, never verdicts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../src/memstore.js';
import { WritingService } from '../src/service.js';
import { largeInsertions, activeTime } from '../src/evidence.js';
import { GENESIS, SimClient, steppedClock } from './helpers.js';

async function session(clock?: () => Date) {
  const store = new InMemoryStore();
  await store.createSession({
    id: GENESIS.session_id,
    assignment_id: GENESIS.assignment_id,
    author_id: GENESIS.author_id,
    server_session_start: GENESIS.server_session_start,
  });
  const service = new WritingService(store, clock);
  return { store, client: new SimClient(service) };
}

test('a single large insertion is surfaced from steps alone', async () => {
  const { store, client } = await session();
  await client.type('Small typed start. ', 1);
  const big = 'x'.repeat(300);
  await client.type(big, client.doc.content.size - 1);
  await client.type(' small tail.', client.doc.content.size - 1);

  const entries = await store.getEntries(GENESIS.session_id);
  const events = largeInsertions(entries, 240);
  assert.equal(events.length, 1);
  assert.equal(events[0].insertedChars, 300);
});

test('small insertions never trip the large-insertion threshold', async () => {
  const { store, client } = await session();
  for (let i = 0; i < 10; i++) {
    await client.type('a short edit. ', client.doc.content.size - 1);
  }
  const events = largeInsertions(await store.getEntries(GENESIS.session_id), 240);
  assert.equal(events.length, 0);
});

test('active time sums only sub-idle-threshold gaps and splits working sessions', async () => {
  // Receipts: 0s, +30s, +60s (active), then +45min (new session), then +20s.
  const times = [0, 30_000, 60_000, 60_000 + 45 * 60_000, 60_000 + 45 * 60_000 + 20_000];
  let i = 0;
  const clock = () => new Date(times[i++]);
  const { store, client } = await session(clock);
  for (let k = 0; k < 5; k++) {
    await client.type('w ', client.doc.content.size - 1);
  }

  const report = activeTime(await store.getEntries(GENESIS.session_id), 120_000, 30 * 60_000);
  assert.equal(report.basis, 'server-receipt-time');
  // active = 30s + 30s (first session) + 20s (second session) = 80s
  assert.equal(report.activeMs, 80_000);
  assert.equal(report.workingSessions.length, 2);
});

test('idle gaps above the idle threshold do not count as active time', async () => {
  const times = [0, 5 * 60_000]; // 5 minute gap, below the 30m session split, above 120s idle
  let i = 0;
  const { store, client } = await session(() => new Date(times[i++]));
  await client.type('one ', client.doc.content.size - 1);
  await client.type('two ', client.doc.content.size - 1);
  const report = activeTime(await store.getEntries(GENESIS.session_id));
  assert.equal(report.activeMs, 0);
  assert.equal(report.workingSessions.length, 1);
  assert.equal(report.wallClockMs, 5 * 60_000);
});

test(steppedClock.name + ' helper advances deterministically', () => {
  const c = steppedClock('2026-01-01T00:00:00.000Z', 1000);
  assert.equal(c().toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(c().toISOString(), '2026-01-01T00:00:01.000Z');
});
