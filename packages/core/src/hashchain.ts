/**
 * Hash chain construction and verification (build spec §7).
 *
 * The confirmed-step log is append-only and hash-chained: altering any entry
 * invalidates that entry and every entry after it, detectably. This module is
 * the *only* place the chain math lives, so write-time and verify-time use the
 * identical construction.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export interface GenesisContext {
  assignment_id: string;
  author_id: string;
  session_id: string;
  /** ISO 8601 UTC. The server-stamped start of the writing session. */
  server_session_start: string;
}

/** The fields of an entry that are bound into its hash. */
export interface EntryCore {
  /** Monotonic per-session document version after these steps applied. */
  version: number;
  /** The confirmed ProseMirror steps for this entry, as step.toJSON() objects. */
  steps_json: unknown[];
  /** ISO 8601 UTC, authoritative server receipt time. */
  server_received_at: string;
}

/** A fully-chained entry as stored / exported. */
export interface ChainedEntry extends EntryCore {
  prev_hash: string;
  entry_hash: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The genesis hash binds the chain to its (assignment, author, session) context,
 * so a log cannot be lifted wholesale from one session into another.
 */
export function genesisHash(ctx: GenesisContext): string {
  const genesisInput = canonicalJson({
    assignment_id: ctx.assignment_id,
    author_id: ctx.author_id,
    server_session_start: ctx.server_session_start,
    session_id: ctx.session_id,
  });
  return sha256Hex(genesisInput);
}

/**
 * Compute entry_hash from the entry core and the prev_hash of *this* entry.
 *
 *   entry_hash = SHA256( prev_hash + "\n" + canonical_json(entry_core) )
 *
 * where entry_core also carries prev_hash, exactly as in the spec.
 */
export function computeEntryHash(core: EntryCore, prevHash: string): string {
  const entryCore = {
    prev_hash: prevHash,
    server_received_at: core.server_received_at,
    steps_json: core.steps_json,
    version: core.version,
  };
  return sha256Hex(prevHash + '\n' + canonicalJson(entryCore));
}

/** Chain one new entry onto a known prev_hash. */
export function chainEntry(core: EntryCore, prevHash: string): ChainedEntry {
  const entry_hash = computeEntryHash(core, prevHash);
  return { ...core, prev_hash: prevHash, entry_hash };
}

export interface VerificationResult {
  ok: boolean;
  /** Number of entries that verified contiguously from genesis. */
  verifiedCount: number;
  /**
   * Index (0-based, into the entries array) of the first entry that fails to
   * verify, or null if all entries verify. Per the spec tamper test, a single
   * altered row fails at that entry and every entry after it.
   */
  firstDivergenceIndex: number | null;
  message: string;
}

/**
 * Recompute the chain forward from genesis and report the first divergence.
 *
 * Entries must be supplied in ascending version order. Verification checks, per
 * entry, that (a) its stored prev_hash equals the running hash, and (b) its
 * stored entry_hash equals the recomputed entry_hash. The first failure ends
 * the contiguous verified prefix.
 */
export function verifyChain(ctx: GenesisContext, entries: ChainedEntry[]): VerificationResult {
  let prevHash = genesisHash(ctx);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.prev_hash !== prevHash) {
      return {
        ok: false,
        verifiedCount: i,
        firstDivergenceIndex: i,
        message: `Entry ${i} (version ${e.version}): prev_hash does not match the running chain hash. The chain is broken at or before this entry.`,
      };
    }

    const recomputed = computeEntryHash(e, prevHash);
    if (recomputed !== e.entry_hash) {
      return {
        ok: false,
        verifiedCount: i,
        firstDivergenceIndex: i,
        message: `Entry ${i} (version ${e.version}): entry_hash does not match recomputed hash. This entry was altered after it was logged.`,
      };
    }

    prevHash = e.entry_hash;
  }

  return {
    ok: true,
    verifiedCount: entries.length,
    firstDivergenceIndex: null,
    message:
      entries.length === 0
        ? 'Chain is empty; genesis is well-formed.'
        : `All ${entries.length} entries verify contiguously from genesis.`,
  };
}
