/**
 * LTI 1.3 HTTP endpoints, mounted under /lti.
 *
 *   GET|POST /lti/login   OIDC third-party-initiated login -> redirect to platform
 *   POST     /lti/launch  signed launch (form_post) -> validate, provision, sign in
 *   GET      /lti/jwks    the tool's public JWKS (platforms fetch this)
 *   POST     /lti/assignments/:id/roster-sync   NRPS roster sync (instructor)
 */
import express, { type Request, type Response, type Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Store } from '@scriptorium/core';
import type { IdentityStore } from '../identity/types.js';
import { getInstructor, setSessionCookie } from '../auth/middleware.js';
import { randomToken } from '../auth/password.js';
import type { LtiService } from './service.js';
import type { LtiStore } from './store.js';

export interface LtiDeps {
  ltiService: LtiService;
  ltiStore: LtiStore;
  identity: IdentityStore;
  store: Store;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[lti]', err);
      if (!res.headersSent) res.status(400).json({ error: 'lti_error', message: String(err?.message ?? err) });
    });
  };
}

export function ltiRouter(deps: LtiDeps): Router {
  const { ltiService, identity, store } = deps;
  const router = express.Router();
  // Platforms post form-encoded login/launch bodies.
  router.use(express.urlencoded({ extended: false }));

  // Tool JWKS — platforms verify our service assertions against this.
  router.get(
    '/jwks',
    asyncRoute(async (_req, res) => {
      const keys = await deps.ltiStore.listPublicJwks();
      res.json({ keys });
    }),
  );

  const loginHandler = asyncRoute(async (req, res) => {
    const src = { ...req.query, ...req.body } as Record<string, string>;
    if (!src.iss || !src.login_hint || !src.target_link_uri) {
      return void res.status(400).json({ error: 'missing_oidc_params' });
    }
    const redirect = await ltiService.buildLoginRedirect({
      iss: src.iss,
      login_hint: src.login_hint,
      target_link_uri: src.target_link_uri,
      client_id: src.client_id,
      lti_message_hint: src.lti_message_hint,
      lti_deployment_id: src.lti_deployment_id,
    });
    res.redirect(302, redirect);
  });
  router.get('/login', loginHandler);
  router.post('/login', loginHandler);

  // The signed launch lands here (response_mode=form_post).
  router.post(
    '/launch',
    asyncRoute(async (req, res) => {
      const idToken = String(req.body.id_token ?? '');
      const state = String(req.body.state ?? '');
      if (!idToken || !state) return void res.status(400).json({ error: 'missing_launch_params' });

      const ctx = await ltiService.validateLaunch(idToken, state);
      const { user, assignment } = await ltiService.provision(ctx);

      // Establish a server-side session and set the cookie. The launch — not the
      // client — vouches for who this is.
      const sessionToken = randomToken();
      await identity.createAuthSession(sessionToken, user.id);
      setSessionCookie(res, sessionToken);

      if (ctx.role === 'instructor') {
        return void res.redirect(302, '/dashboard.html');
      }

      // Student: find or create the writing session bound to (assignment, student).
      const existing = (await store.listSessions(assignment.id)).find(
        (s) => s.author_id === user.id,
      );
      const writing =
        existing ??
        (await store.createSession({
          id: randomUUID(),
          assignment_id: assignment.id,
          author_id: user.id,
          server_session_start: new Date().toISOString(),
        }));
      res.redirect(302, `/?session=${writing.id}`);
    }),
  );

  // NRPS roster sync — instructor pulls the course roster for an LTI assignment.
  router.post(
    '/assignments/:id/roster-sync',
    asyncRoute(async (req, res) => {
      const instructor = await getInstructor(req, identity);
      if (!instructor) return void res.status(401).json({ error: 'unauthenticated' });
      const assignment = await identity.getAssignment(req.params.id);
      if (!assignment || assignment.instructor_id !== instructor.id) {
        return void res.status(404).json({ error: 'unknown_assignment' });
      }
      if (!assignment.lti_nrps_url) {
        return void res.status(400).json({ error: 'not_an_lti_assignment_or_no_nrps' });
      }
      const members = await ltiService.syncRoster(assignment);
      res.json({ members });
    }),
  );

  return router;
}
