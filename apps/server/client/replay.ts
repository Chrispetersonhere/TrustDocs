/**
 * The replay viewer (build spec §8).
 *
 * Reconstructs the document by folding confirmed steps from version 0, using the
 * SAME shared schema and prosemirror-transform as the editor and server. A
 * scrubber moves by version index and by receipt time. This is where the SHAPE
 * of composition becomes visible.
 *
 * HARD CONSTRAINT (§8): this view shows evidence and asserts NO judgment.
 */
import { Node as PMNode } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { DOMSerializer } from 'prosemirror-model';
import { schema } from '@scriptorium/schema';

interface Entry {
  id: number;
  version: number;
  steps_json: unknown[];
  server_received_at: string;
  client_meta: unknown | null;
  prev_hash: string;
  entry_hash: string;
}

const params = new URLSearchParams(location.search);
const token = params.get('token');
let sessionId = params.get('session');

/** Student requests carry a bearer token; instructor requests carry the cookie. */
function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}
function apiGet(path: string) {
  return fetch(path, { headers: authHeaders(), credentials: 'same-origin' });
}

const slider = document.getElementById('scrubber') as HTMLInputElement;
const docEl = document.getElementById('replay-doc')!;
const metaEl = document.getElementById('replay-meta')!;
const verifyEl = document.getElementById('verify-status')!;
const evidenceEl = document.getElementById('evidence')!;

const serializer = DOMSerializer.fromSchema(schema);

function emptyDoc(): PMNode {
  return schema.topNodeType.createAndFill()!;
}

/** Precompute the document at every version by folding steps once. */
function buildStates(entries: Entry[]): PMNode[] {
  const states: PMNode[] = [emptyDoc()];
  let doc = states[0];
  for (const entry of entries) {
    for (const sj of entry.steps_json) {
      const step = Step.fromJSON(schema, sj as object);
      const result = step.apply(doc);
      if (result.doc) doc = result.doc;
    }
    states.push(doc);
  }
  return states;
}

function render(doc: PMNode) {
  docEl.replaceChildren(serializer.serializeFragment(doc.content));
}

async function main() {
  // A student arrives with a capability token; exchange it for their session id.
  if (token && !sessionId) {
    const redeemed = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then((r) => r.json() as Promise<{ sessionId: string }>);
    sessionId = redeemed.sessionId;
  }
  if (!sessionId) {
    metaEl.textContent = 'Open this page from your link (?token=…) or an instructor session URL.';
    return;
  }
  const bundleLink = document.getElementById('bundle-link') as HTMLAnchorElement | null;
  if (bundleLink) {
    bundleLink.href = token
      ? `/api/sessions/${sessionId}/bundle?token=${token}`
      : `/api/sessions/${sessionId}/bundle`;
  }

  const res = await apiGet(`/api/sessions/${sessionId}/log`);
  if (!res.ok) {
    metaEl.textContent =
      res.status === 401 || res.status === 403
        ? 'Not authorized to view this session.'
        : `Could not load session (${res.status}).`;
    return;
  }
  const { session, entries } = (await res.json()) as { session: unknown; entries: Entry[] };
  void session;

  const states = buildStates(entries);
  slider.max = String(states.length - 1);
  slider.value = String(states.length - 1);

  const update = () => {
    const idx = Number(slider.value);
    render(states[idx]);
    if (idx === 0) {
      metaEl.textContent = 'Version 0 — empty document (before any edit).';
    } else {
      const e = entries[idx - 1];
      const when = new Date(e.server_received_at).toLocaleString();
      metaEl.textContent = `Version ${e.version} · received ${when} · ${e.steps_json.length} step(s)`;
    }
  };
  slider.addEventListener('input', update);
  update();

  // Verification badge (recomputed from genesis, server-side).
  const v = await apiGet(`/api/sessions/${sessionId}/verify`).then((r) => r.json());
  verifyEl.textContent = v.ok
    ? `Chain intact — all ${v.verifiedCount} entries verify from genesis.`
    : `Chain BROKEN at entry ${v.firstDivergenceIndex}: ${v.message}`;
  verifyEl.dataset.kind = v.ok ? 'ok' : 'err';

  // Evidence panel: server-derived signals only, with explicit disclaimer.
  const ev = await apiGet(`/api/sessions/${sessionId}/evidence`).then((r) => r.json());
  renderEvidence(ev);
}

function fmtMs(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function renderEvidence(ev: any) {
  const parts: string[] = [];
  parts.push(`<p class="disclaimer">${ev.disclaimer}</p>`);

  const li = ev.largeInsertions;
  parts.push(`<h3>Large insertions <small>(server-derived, &gt; ${li.thresholdChars} chars)</small></h3>`);
  if (!li.events.length) {
    parts.push('<p class="muted">None above threshold.</p>');
  } else {
    parts.push('<ul>');
    for (const e of li.events) {
      parts.push(
        `<li>v${e.version}: ${e.insertedChars} chars inserted in one step · ${new Date(
          e.server_received_at,
        ).toLocaleString()}</li>`,
      );
    }
    parts.push('</ul>');
  }

  if (ev.clientAssertedAnnotations?.length) {
    parts.push('<h3>Client-asserted annotations <small>(UNTRUSTED · spoofable)</small></h3><ul>');
    for (const a of ev.clientAssertedAnnotations) {
      parts.push(`<li>v${a.version}: ${JSON.stringify(a.client_meta)} — client-claimed only</li>`);
    }
    parts.push('</ul>');
  }

  const at = ev.activeTime;
  parts.push('<h3>Active time <small>(receipt-based, not an effort claim)</small></h3>');
  parts.push(
    `<p>Active: <strong>${fmtMs(at.activeMs)}</strong> · Wall-clock span: ${fmtMs(
      at.wallClockMs,
    )} · Working sessions: ${at.workingSessions.length}</p>`,
  );
  parts.push(
    `<p class="muted">Idle threshold ${at.idleThresholdMs / 1000}s · session split ${
      at.sessionGapMs / 60000
    }m · basis: ${at.basis}.</p>`,
  );

  evidenceEl.innerHTML = parts.join('\n');
}

main().catch((err) => {
  metaEl.textContent = String(err);
});
