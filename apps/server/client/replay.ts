/**
 * The replay viewer (build spec §8, M3).
 *
 * Reconstructs the document by folding confirmed steps from version 0, using the
 * SAME shared schema and prosemirror-transform as the editor and server. It lets
 * an instructor watch composition unfold — scrubbing by version or by receipt
 * time, playing it back, seeing where each step changed the text, and where large
 * insertions happened — so the SHAPE of composition becomes visible.
 *
 * HARD CONSTRAINT (§8): this view shows evidence and asserts NO judgment. No
 * score, no probability, no "likely AI", no flag.
 */
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
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

interface StepView {
  /** Document AFTER this entry's steps (index 0 is the empty document). */
  doc: PMNode;
  /** Changed ranges in this doc's coordinates (what the step(s) produced). */
  changed: Array<[number, number]>;
  receiptAt: string | null;
  version: number;
  stepCount: number;
  insertedExtent: number;
  deletedExtent: number;
}

const params = new URLSearchParams(location.search);
const token = params.get('token');
let sessionId = params.get('session');

function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}
function apiGet(path: string) {
  return fetch(path, { headers: authHeaders(), credentials: 'same-origin' });
}

const $ = (id: string) => document.getElementById(id)!;
const slider = $('scrubber') as HTMLInputElement;
const timelineEl = $('timeline');
const metaEl = $('replay-meta');
const stepReadoutEl = $('step-readout');
const verifyEl = $('verify-status');
const evidenceEl = $('evidence');
const playBtn = $('play') as HTMLButtonElement;
const speedSel = $('speed') as HTMLSelectElement;
const positionEl = $('position-readout');

function emptyDoc(): PMNode {
  return schema.topNodeType.createAndFill()!;
}

// --- read-only document view with change highlighting ----------------------

let currentDeco = DecorationSet.empty;
const decoPlugin = new Plugin({ props: { decorations: () => currentDeco } });
let view: EditorView | null = null;

function mountView(doc: PMNode) {
  view = new EditorView($('replay-doc'), {
    state: EditorState.create({ doc, plugins: [decoPlugin] }),
    editable: () => false,
  });
}

function showVersion(states: StepView[], idx: number) {
  const sv = states[idx];
  currentDeco =
    sv.changed.length === 0
      ? DecorationSet.empty
      : DecorationSet.create(
          sv.doc,
          sv.changed
            .filter(([f, t]) => t > f)
            .map(([f, t]) => Decoration.inline(f, t, { class: 'changed' })),
        );
  view!.updateState(EditorState.create({ doc: sv.doc, plugins: [decoPlugin] }));

  if (idx === 0) {
    metaEl.textContent = 'Version 0 — empty document, before any edit.';
    stepReadoutEl.textContent = '';
  } else {
    const when = sv.receiptAt ? new Date(sv.receiptAt).toLocaleString() : '—';
    metaEl.textContent = `Version ${sv.version} · received ${when} · ${sv.stepCount} step(s)`;
    const parts: string[] = [];
    if (sv.insertedExtent > 0) parts.push(`inserted ${sv.insertedExtent}`);
    if (sv.deletedExtent > 0) parts.push(`deleted ${sv.deletedExtent}`);
    stepReadoutEl.textContent = parts.length
      ? `This step: ${parts.join(' · ')} (highlighted below).`
      : 'This step made a structural change.';
  }
  slider.value = String(idx);
  updateTimelineCursor(states, idx);
  positionEl.textContent = `${idx} / ${states.length - 1}`;
}

// --- build per-version states + changed ranges -----------------------------

function buildStates(entries: Entry[]): StepView[] {
  const states: StepView[] = [
    {
      doc: emptyDoc(),
      changed: [],
      receiptAt: null,
      version: 0,
      stepCount: 0,
      insertedExtent: 0,
      deletedExtent: 0,
    },
  ];
  let doc = states[0].doc;

  for (const entry of entries) {
    let ranges: Array<[number, number]> = [];
    let inserted = 0;
    let deleted = 0;
    for (const sj of entry.steps_json) {
      let step: Step;
      try {
        step = Step.fromJSON(schema, sj as object);
      } catch {
        continue;
      }
      const map = step.getMap();
      // Carry existing ranges through this step's mapping.
      ranges = ranges.map(([f, t]) => [map.map(f, -1), map.map(t, 1)]);
      // Record this step's own changed region(s) in the new coordinates.
      map.forEach((oldStart: number, oldEnd: number, newStart: number, newEnd: number) => {
        ranges.push([newStart, newEnd]);
        inserted += Math.max(0, newEnd - newStart);
        deleted += Math.max(0, oldEnd - oldStart);
      });
      const applied = step.apply(doc);
      if (applied.doc) doc = applied.doc;
    }
    const size = doc.content.size;
    const clamped = ranges
      .map(([f, t]): [number, number] => [Math.max(0, Math.min(f, size)), Math.max(0, Math.min(t, size))])
      .filter(([f, t]) => t >= f);
    states.push({
      doc,
      changed: clamped,
      receiptAt: entry.server_received_at,
      version: entry.version,
      stepCount: entry.steps_json.length,
      insertedExtent: inserted,
      deletedExtent: deleted,
    });
  }
  return states;
}

// --- timeline --------------------------------------------------------------

interface TimelineModel {
  states: StepView[];
  mode: 'version' | 'time';
  largeVersions: Set<number>;
  pasteVersions: Set<number>;
  sessions: Array<{ startedAt: string; endedAt: string }>;
}

let timeline: TimelineModel | null = null;

/** x in [0,1] for a given state index, under the current mode. */
function positionOf(idx: number): number {
  if (!timeline) return 0;
  const { states, mode } = timeline;
  const last = states.length - 1;
  if (last <= 0) return 0;
  if (mode === 'version') return idx / last;
  // time mode: proportional to receipt time across the whole span
  const times = states.slice(1).map((s) => Date.parse(s.receiptAt!));
  const min = times[0];
  const max = times[times.length - 1];
  if (idx === 0) return 0;
  if (max === min) return idx / last;
  return (Date.parse(states[idx].receiptAt!) - min) / (max - min);
}

function renderTimeline() {
  if (!timeline) return;
  const { states, largeVersions, pasteVersions, sessions, mode } = timeline;
  timelineEl.innerHTML = '';

  // Working-session bands (time mode only — they are time spans).
  if (mode === 'time' && states.length > 1) {
    const times = states.slice(1).map((s) => Date.parse(s.receiptAt!));
    const min = times[0];
    const max = times[times.length - 1];
    const span = Math.max(1, max - min);
    for (const s of sessions) {
      const a = (Date.parse(s.startedAt) - min) / span;
      const b = (Date.parse(s.endedAt) - min) / span;
      const band = document.createElement('div');
      band.className = 'tl-band';
      band.style.left = `${a * 100}%`;
      band.style.width = `${Math.max(0.5, (b - a) * 100)}%`;
      timelineEl.appendChild(band);
    }
  }

  // Axis line.
  const axis = document.createElement('div');
  axis.className = 'tl-axis';
  timelineEl.appendChild(axis);

  // One marker per edit.
  for (let i = 1; i < states.length; i++) {
    const m = document.createElement('button');
    m.type = 'button';
    const isLarge = largeVersions.has(states[i].version);
    const isPaste = pasteVersions.has(states[i].version);
    m.className = 'tl-mark' + (isLarge ? ' tl-large' : '') + (isPaste ? ' tl-paste' : '');
    m.style.left = `${positionOf(i) * 100}%`;
    const when = states[i].receiptAt ? new Date(states[i].receiptAt!).toLocaleString() : '';
    m.title =
      `v${states[i].version} · ${when}` +
      (isLarge ? ' · large insertion (server-derived)' : '') +
      (isPaste ? ' · client-claimed paste (untrusted)' : '');
    m.dataset.index = String(i);
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      stopPlay();
      goTo(i);
    });
    timelineEl.appendChild(m);
  }

  // Cursor.
  const cursor = document.createElement('div');
  cursor.className = 'tl-cursor';
  cursor.id = 'tl-cursor';
  timelineEl.appendChild(cursor);
  updateTimelineCursor(states, Number(slider.value));
}

function updateTimelineCursor(_states: StepView[], idx: number) {
  const cursor = document.getElementById('tl-cursor');
  if (cursor) cursor.style.left = `${positionOf(idx) * 100}%`;
}

// --- playback + navigation -------------------------------------------------

let states: StepView[] = [];
let playTimer: number | null = null;

function goTo(idx: number) {
  const clamped = Math.max(0, Math.min(idx, states.length - 1));
  showVersion(states, clamped);
}

function stopPlay() {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = '▶ Play';
  }
}

function startPlay() {
  if (states.length <= 1) return;
  if (Number(slider.value) >= states.length - 1) goTo(0);
  playBtn.textContent = '⏸ Pause';
  const tick = () => {
    const next = Number(slider.value) + 1;
    if (next >= states.length) {
      stopPlay();
      return;
    }
    goTo(next);
  };
  playTimer = window.setInterval(tick, Number(speedSel.value));
}

playBtn.addEventListener('click', () => (playTimer === null ? startPlay() : stopPlay()));
speedSel.addEventListener('change', () => {
  if (playTimer !== null) {
    stopPlay();
    startPlay();
  }
});
slider.addEventListener('input', () => {
  stopPlay();
  goTo(Number(slider.value));
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    if (timeline) timeline.mode = radio.value as 'version' | 'time';
    renderTimeline();
  });
}

// --- bootstrap -------------------------------------------------------------

async function main() {
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
  const bundleLink = $('bundle-link') as HTMLAnchorElement;
  bundleLink.href = token
    ? `/api/sessions/${sessionId}/bundle?token=${token}`
    : `/api/sessions/${sessionId}/bundle`;

  const res = await apiGet(`/api/sessions/${sessionId}/log`);
  if (!res.ok) {
    metaEl.textContent =
      res.status === 401 || res.status === 403
        ? 'Not authorized to view this session.'
        : `Could not load session (${res.status}).`;
    return;
  }
  const { entries } = (await res.json()) as { entries: Entry[] };

  states = buildStates(entries);
  slider.max = String(states.length - 1);
  mountView(states[states.length - 1].doc);

  const ev = await apiGet(`/api/sessions/${sessionId}/evidence`).then((r) => r.json());
  timeline = {
    states,
    mode: 'version',
    largeVersions: new Set<number>((ev.largeInsertions?.events ?? []).map((e: { version: number }) => e.version)),
    pasteVersions: new Set<number>(
      (ev.clientAssertedAnnotations ?? []).map((a: { version: number }) => a.version),
    ),
    sessions: ev.activeTime?.workingSessions ?? [],
  };
  renderTimeline();
  setupTimelineClick();
  renderEvidence(ev);

  goTo(states.length - 1); // start at the finished document

  // Verification badge (recomputed from genesis, server-side).
  const v = await apiGet(`/api/sessions/${sessionId}/verify`).then((r) => r.json());
  verifyEl.textContent = v.ok
    ? `Chain intact — all ${v.verifiedCount} entries verify from genesis.`
    : `Chain BROKEN at entry ${v.firstDivergenceIndex}: ${v.message}`;
  verifyEl.dataset.kind = v.ok ? 'ok' : 'err';
}

// --- evidence panel --------------------------------------------------------

function fmtMs(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function jumpToVersion(version: number) {
  const idx = states.findIndex((s) => s.version === version);
  if (idx >= 0) {
    stopPlay();
    goTo(idx);
  }
}

/** Click anywhere on the timeline to jump to the nearest edit under the cursor. */
function setupTimelineClick() {
  timelineEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('tl-mark')) return;
    if (states.length <= 1) return;
    const rect = timelineEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let best = 1;
    let bestDist = Infinity;
    for (let i = 1; i < states.length; i++) {
      const d = Math.abs(positionOf(i) - frac);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    stopPlay();
    goTo(best);
  });
}

function renderEvidence(ev: {
  disclaimer: string;
  largeInsertions: { thresholdChars: number; events: Array<{ version: number; server_received_at: string; insertedChars: number }> };
  clientAssertedAnnotations: Array<{ version: number; client_meta: unknown }>;
  activeTime: {
    activeMs: number;
    wallClockMs: number;
    idleThresholdMs: number;
    sessionGapMs: number;
    basis: string;
    workingSessions: Array<{ startedAt: string; endedAt: string; activeMs: number; entryCount: number }>;
  };
}) {
  const frag = document.createDocumentFragment();
  const el = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d;
  };

  frag.appendChild(el(`<p class="disclaimer">${ev.disclaimer}</p>`));

  const li = ev.largeInsertions;
  const liBlock = el(
    `<h3>Large insertions <small>server-derived · &gt; ${li.thresholdChars} chars</small></h3>`,
  );
  if (!li.events.length) {
    liBlock.appendChild(el('<p class="muted">None above threshold.</p>'));
  } else {
    const ul = document.createElement('ul');
    for (const e of li.events) {
      const item = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = `v${e.version}: ${e.insertedChars} chars in one step`;
      a.addEventListener('click', (ePrevent) => {
        ePrevent.preventDefault();
        jumpToVersion(e.version);
      });
      item.appendChild(a);
      item.appendChild(document.createTextNode(` · ${new Date(e.server_received_at).toLocaleString()}`));
      ul.appendChild(item);
    }
    liBlock.appendChild(ul);
  }
  frag.appendChild(liBlock);

  if (ev.clientAssertedAnnotations?.length) {
    const blk = el('<h3>Client-asserted annotations <small>UNTRUSTED · spoofable</small></h3>');
    const ul = document.createElement('ul');
    for (const a of ev.clientAssertedAnnotations) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = `v${a.version}`;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        jumpToVersion(a.version);
      });
      item.appendChild(link);
      item.appendChild(document.createTextNode(`: ${JSON.stringify(a.client_meta)} — client-claimed only`));
      ul.appendChild(item);
    }
    blk.appendChild(ul);
    frag.appendChild(blk);
  }

  const at = ev.activeTime;
  const atBlock = el('<h3>Active time <small>receipt-based · not an effort claim</small></h3>');
  atBlock.appendChild(
    el(
      `<p>Active: <strong>${fmtMs(at.activeMs)}</strong> · Wall-clock span: ${fmtMs(
        at.wallClockMs,
      )} · Working sessions: ${at.workingSessions.length}</p>`,
    ),
  );
  if (at.workingSessions.length) {
    const ol = document.createElement('ol');
    for (const s of at.workingSessions) {
      const item = document.createElement('li');
      item.textContent = `${new Date(s.startedAt).toLocaleTimeString()} – ${new Date(
        s.endedAt,
      ).toLocaleTimeString()} · active ${fmtMs(s.activeMs)} · ${s.entryCount} edits`;
      ol.appendChild(item);
    }
    atBlock.appendChild(ol);
  }
  atBlock.appendChild(
    el(
      `<p class="muted">Idle threshold ${at.idleThresholdMs / 1000}s · session split ${
        at.sessionGapMs / 60000
      }m · basis: ${at.basis}.</p>`,
    ),
  );
  frag.appendChild(atBlock);

  evidenceEl.replaceChildren(frag);
}

main().catch((err) => {
  metaEl.textContent = String(err);
});
