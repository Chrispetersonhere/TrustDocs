/**
 * Hash-chain verification CLI (build spec §11, M4).
 *
 * Two modes:
 *   verify --bundle <file.json>      Re-verify an exported bundle OFFLINE. Needs
 *                                    no database and no running server.
 *   verify --session <id>            Verify a live session from the database
 *                                    (requires DATABASE_URL).
 *
 * Exit code 0 = chain intact; 1 = divergence (prints the first diverging entry).
 */
import { readFileSync } from 'node:fs';
import { verifyBundle, verifyChain, type EvidenceBundle } from '@scriptorium/core';

function parseArgs(argv: string[]): { bundle?: string; session?: string } {
  const out: { bundle?: string; session?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle') out.bundle = argv[++i];
    else if (argv[i] === '--session') out.session = argv[++i];
  }
  return out;
}

async function verifyBundleFile(path: string): Promise<number> {
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as EvidenceBundle;
  const result = verifyBundle(bundle);
  if (result.ok) {
    console.log(`OK: bundle for session ${bundle.session?.id} verifies.`);
    console.log(`    ${result.chain.message}`);
    console.log(`    Reconstructed document is ${result.reconstructedText?.length ?? 0} characters.`);
    return 0;
  }
  console.error('FAIL: bundle did not verify.');
  if (!result.formatOk) console.error('    Unrecognized bundle format.');
  console.error(`    ${result.chain.message}`);
  if (result.chain.firstDivergenceIndex !== null) {
    console.error(`    First divergence at entry index ${result.chain.firstDivergenceIndex}.`);
  }
  return 1;
}

async function verifySession(sessionId: string): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('--session requires DATABASE_URL to be set.');
    return 2;
  }
  const { PgStore } = await import('../db/pgStore.js');
  const { closePool } = await import('../db/pool.js');
  try {
    const store = new PgStore();
    const session = await store.getSession(sessionId);
    if (!session) {
      console.error(`Unknown session ${sessionId}`);
      return 2;
    }
    const entries = await store.getEntries(sessionId);
    const genesis = {
      assignment_id: session.assignment_id,
      author_id: session.author_id,
      session_id: session.id,
      server_session_start: session.server_session_start,
    };
    const result = verifyChain(genesis, entries);
    if (result.ok) {
      console.log(`OK: session ${sessionId} — ${result.message}`);
      return 0;
    }
    console.error(`FAIL: session ${sessionId} — ${result.message}`);
    console.error(`    First divergence at entry index ${result.firstDivergenceIndex}.`);
    return 1;
  } finally {
    await closePool();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let code: number;
  if (args.bundle) code = await verifyBundleFile(args.bundle);
  else if (args.session) code = await verifySession(args.session);
  else {
    console.error('Usage: verify --bundle <file.json> | --session <id>');
    code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
