/**
 * The student editor (build spec §5, §6).
 *
 * ProseMirror core + prosemirror-collab. Steps are submitted EAGERLY in small
 * batches so the server's receipt time tracks authorship closely (connectivity
 * is required in v1). The editor imports the SAME shared schema the server uses.
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
const sessionId = params.get('session');
const clientID = Math.floor(Math.random() * 0xffffffff);

const statusEl = document.getElementById('status')!;
const setStatus = (msg: string, kind: 'ok' | 'warn' | 'err' = 'ok') => {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
};

// Paste detection: a purely client-asserted, UNTRUSTED annotation (build spec §8).
// We set a flag when a paste happens; the next submitted batch carries it in
// client_meta. The server marks it untrusted and never derives timing from it.
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok && res.status !== 409) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function start() {
  if (!sessionId) {
    setStatus('No ?session= in URL', 'err');
    return;
  }

  const initial = await api<{ version: number; doc: unknown }>(
    `/api/sessions/${sessionId}/doc`,
  );
  const doc = PMNode.fromJSON(schema, initial.doc as object);

  let inFlight = false;

  const state = EditorState.create({
    doc,
    plugins: [
      ...exampleSetup({ schema, history: false }),
      collab({ version: initial.version, clientID }),
      pastePlugin,
    ],
  });

  const view = new EditorView(document.getElementById('editor'), {
    state,
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr);
      view.updateState(newState);
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
        // Another batch landed first; pull events, apply, and the next sync rebases.
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
      // v1 requires connectivity; retry shortly so steps land in order.
      setTimeout(() => void sync(), 1500);
    } finally {
      inFlight = false;
      // Drain anything queued while we were sending.
      if (sendableSteps(view.state)) void sync();
    }
  }

  setStatus('Ready — start typing. The server records every edit.', 'ok');
  view.focus();
}

start().catch((err) => setStatus(String(err), 'err'));
