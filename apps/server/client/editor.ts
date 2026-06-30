/**
 * The student editor (build spec §5, §6, §9).
 *
 * ProseMirror core + prosemirror-collab. The student arrives via their
 * per-assignment capability link (/?token=...). The token is exchanged for the
 * writing_session unforgeably bound to (student, assignment) and then sent as a
 * bearer credential on every request. The editor imports the SAME shared schema
 * the server uses.
 *
 * The client is never trusted for time or final state: it only proposes steps;
 * the server orders, stamps, and reconstructs.
 */
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-menu/style/menu.css';
import 'prosemirror-example-setup/style/style.css';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { collab, receiveTransaction, sendableSteps, getVersion } from 'prosemirror-collab';
import { exampleSetup } from 'prosemirror-example-setup';
import { schema } from '@scriptorium/schema';

const params = new URLSearchParams(location.search);
const token = params.get('token');
const clientID = Math.floor(Math.random() * 0xffffffff);

const statusEl = document.getElementById('status')!;
const ctxEl = document.getElementById('context');
const setStatus = (msg: string, kind: 'ok' | 'warn' | 'err' = 'ok') => {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
};

let pendingClientPaste = false;
const pastePlugin = new Plugin({
  props: {
    handleDOMEvents: {
      paste() {
        pendingClientPaste = true;
        return false;
      },
    },
  },
});

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: authHeaders(), ...init });
  if (!res.ok && res.status !== 409) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function start() {
  if (!token) {
    setStatus('This editor opens from your per-assignment link (…/?token=…).', 'err');
    return;
  }

  // Exchange the capability token for the bound writing session.
  const redeemed = await api<{
    sessionId: string;
    assignmentTitle: string;
    studentEmail: string;
    version: number;
    doc: unknown;
  }>('/api/session', { method: 'POST', body: JSON.stringify({ token }) });

  const sessionId = redeemed.sessionId;
  if (ctxEl) {
    ctxEl.textContent = `${redeemed.assignmentTitle} · ${redeemed.studentEmail}`;
  }
  const replayLink = document.getElementById('replay-link') as HTMLAnchorElement | null;
  if (replayLink) replayLink.href = `/replay.html?token=${token}`;

  const doc = PMNode.fromJSON(schema, redeemed.doc as object);
  let inFlight = false;

  const state = EditorState.create({
    doc,
    plugins: [
      ...exampleSetup({ schema, history: false }),
      collab({ version: redeemed.version, clientID }),
      pastePlugin,
    ],
  });

  const view = new EditorView(document.getElementById('editor'), {
    state,
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      void sync();
    },
  });

  async function sync(): Promise<void> {
    if (inFlight) return;
    const sendable = sendableSteps(view.state);
    if (!sendable) return;
    inFlight = true;
    setStatus('Saving…', 'warn');

    const clientMeta = pendingClientPaste ? { clientClaimedPaste: true } : undefined;

    try {
      const outcome = await api<{ status: string; version: number; reason?: string }>(
        `/api/sessions/${sessionId}/steps`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: sendable.version,
            clientID,
            steps: sendable.steps.map((s) => s.toJSON()),
            ...(clientMeta ? { client_meta: clientMeta } : {}),
          }),
        },
      );

      if (outcome.status === 'accepted') {
        pendingClientPaste = false;
        const tr = receiveTransaction(
          view.state,
          sendable.steps,
          sendable.steps.map(() => clientID),
          { mapSelectionBackward: true },
        );
        view.updateState(view.state.apply(tr));
        setStatus(`Saved · v${outcome.version}`, 'ok');
      } else if (outcome.status === 'stale') {
        const events = await api<{ version: number; steps: unknown[] }>(
          `/api/sessions/${sessionId}/events?since=${getVersion(view.state)}`,
        );
        if (events.steps.length) {
          const hydrated = events.steps.map((s: unknown) => Step.fromJSON(schema, s as object));
          const tr = receiveTransaction(
            view.state,
            hydrated,
            hydrated.map(() => -1),
          );
          view.updateState(view.state.apply(tr));
        }
        setStatus('Rebasing…', 'warn');
      } else {
        setStatus(`Rejected: ${outcome.reason ?? 'invalid'}`, 'err');
      }
    } catch (err) {
      setStatus(`Offline — retrying. (${String(err)})`, 'err');
      setTimeout(() => void sync(), 1500);
    } finally {
      inFlight = false;
      if (sendableSteps(view.state)) void sync();
    }
  }

  setStatus('Ready — start typing. The server records every edit.', 'ok');
  view.focus();
}

start().catch((err) => setStatus(String(err), 'err'));
