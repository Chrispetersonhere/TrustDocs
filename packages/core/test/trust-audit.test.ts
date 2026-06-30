/**
 * Definition of Done (build spec §11): the two trust audits, enforced as tests so
 * a regression fails CI.
 *
 *  - Trust audit — no score: no source file exposes a verdict / probability /
 *    classification / "cheating" flag.
 *  - Trust audit — time: receipt time is always server-stamped; a client-asserted
 *    time may only live in the explicitly-untrusted client_meta field.
 *
 * These are necessarily heuristic, but they make the constraint executable and
 * catch the obvious regressions (a new `aiScore` field, a `Date.parse(req.body
 * .clientTime)` feeding a timing field, etc.).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'public') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'helpers.ts')
      acc.push(full);
  }
  return acc;
}

// Words that would denote a verdict/score if they appeared as an identifier or
// user-facing string. Comments in this repo deliberately discuss "no score", so
// we strip line/block comments before scanning.
const VERDICT_PATTERNS = [
  /\baiScore\b/i,
  /\bcheat(ing|er)?Flag\b/i,
  /\bplagiarismScore\b/i,
  /\blikelihood(OfAi|Ai)\b/i,
  /\bisCheating\b/i,
  /\bguiltScore\b/i,
  /\bsuspicionScore\b/i,
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('trust audit — no score/verdict identifiers leak into source', () => {
  const files = sourceFiles(repoRoot);
  assert.ok(files.length > 0, 'found source files to audit');
  const offenders: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const pat of VERDICT_PATTERNS) {
      if (pat.test(code)) offenders.push(`${relative(repoRoot, f)} matched ${pat}`);
    }
  }
  assert.deepEqual(offenders, [], `verdict-like identifiers found:\n${offenders.join('\n')}`);
});

test('trust audit — server never reads a client-supplied time into a trusted field', () => {
  const files = sourceFiles(repoRoot).filter(
    (f) => !f.includes(join('packages', 'core', 'test')),
  );
  const offenders: string[] = [];
  // A receipt/timing assignment that pulls from a request/client body is a red flag.
  const bad = [
    /server_received_at\s*[:=]\s*(req|request|body|client|payload)\b/i,
    /received_at\s*[:=].*\bclient/i,
  ];
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const pat of bad) {
      if (pat.test(code)) offenders.push(`${relative(repoRoot, f)} matched ${pat}`);
    }
  }
  assert.deepEqual(offenders, [], `client-time-as-trusted found:\n${offenders.join('\n')}`);
});
