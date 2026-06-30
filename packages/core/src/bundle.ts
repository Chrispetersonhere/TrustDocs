/**
 * Exportable, self-verifying evidence bundle (build spec §9, §11).
 *
 * A bundle contains everything needed to re-verify a session's hash chain and
 * reconstruct its document OFFLINE, with the server down: the genesis context and
 * every chained log entry. Verification needs no secret — tamper-evidence comes
 * from the SHA-256 chain itself, so a review board or the student can re-run it
 * independently.
 */
import { reconstruct } from './applier.js';
import { verifyChain, type ChainedEntry, type GenesisContext } from './hashchain.js';
import type { EditLogEntry, WritingSessionRecord } from './types.js';

export const BUNDLE_FORMAT = 'scriptorium.evidence-bundle.v1';

export interface EvidenceBundle {
  format: typeof BUNDLE_FORMAT;
  genesis: GenesisContext;
  session: {
    id: string;
    assignment_id: string;
    author_id: string;
    server_session_start: string;
    status: string;
  };
  entries: Array<
    ChainedEntry & {
      id: number;
      client_meta: unknown | null;
    }
  >;
  /** Computed at export time as a convenience; re-derivable from `entries`. */
  exportedFinalVersion: number;
}

export function buildBundle(
  session: WritingSessionRecord,
  entries: EditLogEntry[],
): EvidenceBundle {
  return {
    format: BUNDLE_FORMAT,
    genesis: {
      assignment_id: session.assignment_id,
      author_id: session.author_id,
      session_id: session.id,
      server_session_start: session.server_session_start,
    },
    session: {
      id: session.id,
      assignment_id: session.assignment_id,
      author_id: session.author_id,
      server_session_start: session.server_session_start,
      status: session.status,
    },
    entries: entries.map((e) => ({
      id: e.id,
      version: e.version,
      steps_json: e.steps_json,
      server_received_at: e.server_received_at,
      client_meta: e.client_meta,
      prev_hash: e.prev_hash,
      entry_hash: e.entry_hash,
    })),
    exportedFinalVersion: entries.length === 0 ? 0 : entries[entries.length - 1].version,
  };
}

export interface BundleVerification {
  ok: boolean;
  formatOk: boolean;
  chain: ReturnType<typeof verifyChain>;
  /** The document text reconstructed from the bundle's steps, if the chain is intact. */
  reconstructedText: string | null;
}

/**
 * Re-verify a bundle with no server and no database. This is the function a third
 * party runs against an exported file.
 */
export function verifyBundle(bundle: EvidenceBundle): BundleVerification {
  const formatOk = bundle.format === BUNDLE_FORMAT;
  const entries: ChainedEntry[] = (bundle.entries ?? []).map((e) => ({
    version: e.version,
    steps_json: e.steps_json,
    server_received_at: e.server_received_at,
    prev_hash: e.prev_hash,
    entry_hash: e.entry_hash,
  }));
  const chain = verifyChain(bundle.genesis, entries);

  let reconstructedText: string | null = null;
  if (chain.ok) {
    const doc = reconstruct(entries);
    reconstructedText = doc.textBetween(0, doc.content.size, '\n', '\n');
  }

  return { ok: formatOk && chain.ok, formatOk, chain, reconstructedText };
}
