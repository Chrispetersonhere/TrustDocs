/**
 * The HTTP surface for the collab authority and evidence layer.
 *
 * Trust discipline (build spec §2, §6, §8):
 *   - receipt time is stamped by the server inside WritingService.submit, never
 *     read from the request,
 *   - no endpoint returns a verdict, score, probability, or "cheating" flag,
 *   - client-asserted annotations live only in the untrusted client_meta field.
 */
import express, { type Express, type Request, type Response } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeTime,
  buildBundle,
  largeInsertions,
  reconstruct,
  verifyChain,
  WritingService,
  type Store,
} from '@scriptorium/core';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export interface AppDeps {
  store: Store;
  service: WritingService;
  /** Allow the destructive hard-delete endpoint (build spec §9). Off by default. */
  allowHardDelete?: boolean;
  idleThresholdMs?: number;
  sessionGapMs?: number;
  largeInsertionThreshold?: number;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}

export function createApp(deps: AppDeps): Express {
  const {
    store,
    service,
    allowHardDelete = false,
    idleThresholdMs = 120_000,
    sessionGapMs = 30 * 60_000,
    largeInsertionThreshold = 240,
  } = deps;

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // --- Collab authority -----------------------------------------------------

  // Current authoritative document, reconstructed from the log alone.
  app.get(
    '/api/sessions/:id/doc',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const { version, doc } = await service.currentDoc(req.params.id);
      res.json({ version, doc: doc.toJSON() });
    }),
  );

  // Confirmed steps after `since`, for client catch-up / rebase.
  app.get(
    '/api/sessions/:id/events',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const since = Number.parseInt(String(req.query.since ?? '0'), 10) || 0;
      res.json(await service.eventsSince(req.params.id, since));
    }),
  );

  // Submit a batch of steps. THE one write path. No file-upload path exists.
  app.post(
    '/api/sessions/:id/steps',
    asyncRoute(async (req, res) => {
      const { version, clientID, steps, client_meta } = req.body ?? {};
      if (typeof version !== 'number' || !Array.isArray(steps)) {
        return void res.status(400).json({ error: 'bad_request' });
      }
      const outcome = await service.submit(req.params.id, {
        version,
        clientID: String(clientID ?? 'anon'),
        steps,
        // client_meta is forwarded but treated as untrusted by the service.
        ...(client_meta !== undefined ? { client_meta } : {}),
      } as never);
      const code = outcome.status === 'invalid' ? 409 : 200;
      res.status(code).json(outcome);
    }),
  );

  // --- Evidence & integrity (read-only, no verdicts) ------------------------

  // The raw chained log, for replay and verification UIs.
  app.get(
    '/api/sessions/:id/log',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const entries = await store.getEntries(req.params.id);
      res.json({ session, entries });
    }),
  );

  // Hash-chain verification recomputed from genesis (build spec §11, M4).
  app.get(
    '/api/sessions/:id/verify',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const entries = await store.getEntries(req.params.id);
      const genesis = {
        assignment_id: session.assignment_id,
        author_id: session.author_id,
        session_id: session.id,
        server_session_start: session.server_session_start,
      };
      res.json(verifyChain(genesis, entries));
    }),
  );

  // Server-derived evidence: large insertions + active time. No interpretation.
  app.get(
    '/api/sessions/:id/evidence',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const entries = await store.getEntries(req.params.id);
      res.json({
        disclaimer:
          'Uninterpreted, server-derived evidence. This tool computes no score, ' +
          'probability, or judgment. A human interprets these signals.',
        largeInsertions: {
          basis: 'server-derived',
          thresholdChars: largeInsertionThreshold,
          events: largeInsertions(entries, largeInsertionThreshold),
        },
        // Client-asserted paste annotations, surfaced but flagged untrusted.
        clientAssertedAnnotations: entries
          .filter((e) => e.client_meta != null)
          .map((e) => ({ version: e.version, client_meta: e.client_meta, trusted: false })),
        activeTime: activeTime(entries, idleThresholdMs, sessionGapMs),
      });
    }),
  );

  // Exportable self-verifying bundle (build spec §9, §11).
  app.get(
    '/api/sessions/:id/bundle',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const entries = await store.getEntries(req.params.id);
      const bundle = buildBundle(session, entries);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="evidence-${session.id}.json"`,
      );
      res.send(JSON.stringify(bundle, null, 2));
    }),
  );

  // Reconstructed plain text, a convenience for the replay header.
  app.get(
    '/api/sessions/:id/text',
    asyncRoute(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return void res.status(404).json({ error: 'unknown_session' });
      const entries = await store.getEntries(req.params.id);
      const doc = reconstruct(entries);
      res.json({ text: doc.textBetween(0, doc.content.size, '\n', '\n') });
    }),
  );

  app.get(
    '/api/sessions',
    asyncRoute(async (req, res) => {
      const assignmentId = req.query.assignment ? String(req.query.assignment) : undefined;
      res.json({ sessions: await store.listSessions(assignmentId) });
    }),
  );

  // Sanctioned hard-delete (build spec §9). Off unless explicitly enabled.
  app.delete(
    '/api/sessions/:id',
    asyncRoute(async (req, res) => {
      if (!allowHardDelete) return void res.status(403).json({ error: 'hard_delete_disabled' });
      const ok = await store.deleteSession(req.params.id);
      res.status(ok ? 200 : 404).json({ deleted: ok });
    }),
  );

  // --- Static client --------------------------------------------------------
  app.use(express.static(publicDir));

  return app;
}
