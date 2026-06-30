/**
 * The HTTP surface: the collab authority, the evidence/integrity layer, and the
 * M2 identity layer (accounts, assignments, per-student capability links).
 *
 * Trust discipline (build spec §2, §6, §8):
 *   - receipt time is stamped by the server inside WritingService.submit, never
 *     read from the request,
 *   - no endpoint returns a verdict, score, probability, or "cheating" flag,
 *   - client-asserted annotations live only in the untrusted client_meta field.
 *
 * Authorization (build spec §9) is deny-by-default: the bound student may read
 * and write their own session; the owning instructor may read it; nobody else.
 */
import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
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
  type WritingSessionRecord,
} from '@scriptorium/core';
import type { IdentityStore, User } from './identity/types.js';
import {
  authorizeSession,
  clearSessionCookie,
  getInstructor,
  setSessionCookie,
} from './auth/middleware.js';
import { hashPassword, randomToken, verifyPassword } from './auth/password.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export interface AppDeps {
  store: Store;
  identity: IdentityStore;
  service: WritingService;
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

const isEmail = (s: unknown): s is string =>
  typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function createApp(deps: AppDeps): Express {
  const {
    store,
    identity,
    service,
    allowHardDelete = false,
    idleThresholdMs = 120_000,
    sessionGapMs = 30 * 60_000,
    largeInsertionThreshold = 240,
  } = deps;

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  // --- Auth (instructors) ---------------------------------------------------

  app.post(
    '/api/auth/register',
    asyncRoute(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (!isEmail(email) || typeof password !== 'string' || password.length < 8) {
        return void res
          .status(400)
          .json({ error: 'invalid_credentials', message: 'Valid email and 8+ char password required.' });
      }
      let user: User;
      try {
        user = await identity.createUser({
          email,
          password_hash: await hashPassword(password),
          role: 'instructor',
        });
      } catch (err) {
        if (String((err as Error).message) === 'email_taken') {
          return void res.status(409).json({ error: 'email_taken' });
        }
        throw err;
      }
      const token = randomToken();
      await identity.createAuthSession(token, user.id);
      setSessionCookie(res, token);
      res.json({ user });
    }),
  );

  app.post(
    '/api/auth/login',
    asyncRoute(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        return void res.status(400).json({ error: 'bad_request' });
      }
      const record = await identity.getUserByEmail(email);
      if (!record || record.role !== 'instructor' || !(await verifyPassword(password, record.password_hash))) {
        return void res.status(401).json({ error: 'invalid_credentials' });
      }
      const token = randomToken();
      await identity.createAuthSession(token, record.id);
      setSessionCookie(res, token);
      res.json({ user: { id: record.id, email: record.email, role: record.role } });
    }),
  );

  app.post(
    '/api/auth/logout',
    asyncRoute(async (req, res) => {
      const cookie = req.headers.cookie ?? '';
      const m = /(?:^|;)\s*sid=([^;]+)/.exec(cookie);
      if (m) await identity.deleteAuthSession(decodeURIComponent(m[1]));
      clearSessionCookie(res);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/auth/me',
    asyncRoute(async (req, res) => {
      const instructor = await getInstructor(req, identity);
      if (!instructor) return void res.status(401).json({ error: 'unauthenticated' });
      res.json({ user: instructor });
    }),
  );

  // Guard helper for instructor-only routes.
  const requireInstructor = async (req: Request, res: Response): Promise<User | null> => {
    const instructor = await getInstructor(req, identity);
    if (!instructor) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    return instructor;
  };

  // --- Assignments & per-student links (instructors) ------------------------

  app.post(
    '/api/assignments',
    asyncRoute(async (req, res) => {
      const instructor = await requireInstructor(req, res);
      if (!instructor) return;
      const { title, retention_days } = req.body ?? {};
      if (typeof title !== 'string' || title.trim().length === 0) {
        return void res.status(400).json({ error: 'title_required' });
      }
      const retention =
        retention_days == null
          ? null
          : Number.isInteger(retention_days) && retention_days > 0
            ? retention_days
            : null;
      const assignment = await identity.createAssignment({
        instructor_id: instructor.id,
        title: title.trim(),
        retention_days: retention,
      });
      res.json({ assignment });
    }),
  );

  app.get(
    '/api/assignments',
    asyncRoute(async (req, res) => {
      const instructor = await requireInstructor(req, res);
      if (!instructor) return;
      const assignments = await identity.listAssignmentsByInstructor(instructor.id);
      const withCounts = await Promise.all(
        assignments.map(async (a) => {
          const sessions = await store.listSessions(a.id);
          return { ...a, sessionCount: sessions.length };
        }),
      );
      res.json({ assignments: withCounts });
    }),
  );

  app.post(
    '/api/assignments/:id/students',
    asyncRoute(async (req, res) => {
      const instructor = await requireInstructor(req, res);
      if (!instructor) return;
      const assignment = await identity.getAssignment(req.params.id);
      if (!assignment || assignment.instructor_id !== instructor.id) {
        return void res.status(404).json({ error: 'unknown_assignment' });
      }
      const { email } = req.body ?? {};
      if (!isEmail(email)) return void res.status(400).json({ error: 'invalid_email' });
      let student;
      try {
        student = await identity.getOrCreateStudent(email);
      } catch {
        return void res.status(409).json({ error: 'email_belongs_to_non_student' });
      }
      const token = await identity.mintToken(assignment.id, student.id);
      res.json({ student, token: token.token, link: `/?token=${token.token}` });
    }),
  );

  app.get(
    '/api/assignments/:id',
    asyncRoute(async (req, res) => {
      const instructor = await requireInstructor(req, res);
      if (!instructor) return;
      const assignment = await identity.getAssignment(req.params.id);
      if (!assignment || assignment.instructor_id !== instructor.id) {
        return void res.status(404).json({ error: 'unknown_assignment' });
      }
      const tokens = await identity.listTokensByAssignment(assignment.id);
      const sessions = await store.listSessions(assignment.id);
      const sessionByAuthor = new Map(sessions.map((s) => [s.author_id, s]));

      const students = await Promise.all(
        tokens.map(async (t) => {
          const session = sessionByAuthor.get(t.student_id);
          return {
            email: t.student_email,
            link: `/?token=${t.token}`,
            token: t.token,
            session: session ? await sessionStats(session) : null,
          };
        }),
      );
      res.json({ assignment, students });
    }),
  );

  async function sessionStats(session: WritingSessionRecord) {
    const entries = await store.getEntries(session.id);
    const genesis = {
      assignment_id: session.assignment_id,
      author_id: session.author_id,
      session_id: session.id,
      server_session_start: session.server_session_start,
    };
    const verification = verifyChain(genesis, entries);
    return {
      sessionId: session.id,
      version: entries.length ? entries[entries.length - 1].version : 0,
      entryCount: entries.length,
      firstReceiptAt: entries[0]?.server_received_at ?? null,
      lastReceiptAt: entries[entries.length - 1]?.server_received_at ?? null,
      chainOk: verification.ok,
    };
  }

  // --- Student redemption: token -> bound writing_session (build spec §9) ----

  app.post(
    '/api/session',
    asyncRoute(async (req, res) => {
      const tokenStr =
        (typeof req.body?.token === 'string' && req.body.token) ||
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7).trim()
          : '');
      if (!tokenStr) return void res.status(400).json({ error: 'token_required' });
      const resolved = await identity.getToken(tokenStr);
      if (!resolved) return void res.status(401).json({ error: 'invalid_token' });

      // Find or create the session unforgeably bound to (assignment, student).
      const existing = (await store.listSessions(resolved.assignment.id)).find(
        (s) => s.author_id === resolved.student.id,
      );
      const session =
        existing ??
        (await store.createSession({
          id: randomUUID(),
          assignment_id: resolved.assignment.id,
          author_id: resolved.student.id,
          server_session_start: new Date().toISOString(),
        }));

      const { version, doc } = await service.currentDoc(session.id);
      res.json({
        sessionId: session.id,
        assignmentTitle: resolved.assignment.title,
        studentEmail: resolved.student.email,
        version,
        doc: doc.toJSON(),
      });
    }),
  );

  // --- Collab authority (authorized) ----------------------------------------

  /** Resolve access or end the response; returns null if denied. */
  const access = async (req: Request, res: Response, write: boolean) => {
    const a = await authorizeSession(req, { identity, store }, req.params.id);
    if (!a) {
      res.status(await store.getSession(req.params.id) ? 403 : 404).json({ error: 'forbidden' });
      return null;
    }
    if (write && !a.canWrite) {
      res.status(403).json({ error: 'read_only' });
      return null;
    }
    return a;
  };

  app.get(
    '/api/sessions/:id/doc',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
      const { version, doc } = await service.currentDoc(req.params.id);
      res.json({ version, doc: doc.toJSON() });
    }),
  );

  app.get(
    '/api/sessions/:id/events',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
      const since = Number.parseInt(String(req.query.since ?? '0'), 10) || 0;
      res.json(await service.eventsSince(req.params.id, since));
    }),
  );

  app.post(
    '/api/sessions/:id/steps',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, true))) return;
      const { version, clientID, steps, client_meta } = req.body ?? {};
      if (typeof version !== 'number' || !Array.isArray(steps)) {
        return void res.status(400).json({ error: 'bad_request' });
      }
      const outcome = await service.submit(req.params.id, {
        version,
        clientID: String(clientID ?? 'anon'),
        steps,
        ...(client_meta !== undefined ? { client_meta } : {}),
      } as never);
      res.status(outcome.status === 'invalid' ? 409 : 200).json(outcome);
    }),
  );

  // --- Evidence & integrity (authorized, read-only, no verdicts) ------------

  app.get(
    '/api/sessions/:id/log',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
      const session = await store.getSession(req.params.id);
      res.json({ session, entries: await store.getEntries(req.params.id) });
    }),
  );

  app.get(
    '/api/sessions/:id/verify',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
      const session = (await store.getSession(req.params.id))!;
      const entries = await store.getEntries(req.params.id);
      res.json(
        verifyChain(
          {
            assignment_id: session.assignment_id,
            author_id: session.author_id,
            session_id: session.id,
            server_session_start: session.server_session_start,
          },
          entries,
        ),
      );
    }),
  );

  app.get(
    '/api/sessions/:id/evidence',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
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
        clientAssertedAnnotations: entries
          .filter((e) => e.client_meta != null)
          .map((e) => ({ version: e.version, client_meta: e.client_meta, trusted: false })),
        activeTime: activeTime(entries, idleThresholdMs, sessionGapMs),
      });
    }),
  );

  app.get(
    '/api/sessions/:id/bundle',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
      const session = (await store.getSession(req.params.id))!;
      const entries = await store.getEntries(req.params.id);
      const bundle = buildBundle(session, entries);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="evidence-${session.id}.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    }),
  );

  app.get(
    '/api/sessions/:id/text',
    asyncRoute(async (req, res) => {
      if (!(await access(req, res, false))) return;
      const entries = await store.getEntries(req.params.id);
      const doc = reconstruct(entries);
      res.json({ text: doc.textBetween(0, doc.content.size, '\n', '\n') });
    }),
  );

  app.delete(
    '/api/sessions/:id',
    asyncRoute(async (req, res) => {
      if (!allowHardDelete) return void res.status(403).json({ error: 'hard_delete_disabled' });
      const a = await access(req, res, false);
      if (!a) return;
      if (a.principal !== 'instructor') return void res.status(403).json({ error: 'forbidden' });
      const ok = await store.deleteSession(req.params.id);
      res.status(ok ? 200 : 404).json({ deleted: ok });
    }),
  );

  // --- Static client --------------------------------------------------------
  app.use(express.static(publicDir));

  return app;
}
