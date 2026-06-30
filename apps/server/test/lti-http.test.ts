/**
 * LTI 1.3 over the real HTTP surface: JWKS, OIDC login redirect, and a signed
 * launch that signs the user in (cookie) and lands a student in their bound
 * writing session — which they can then write to with that cookie.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Transform } from 'prosemirror-transform';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '@scriptorium/schema';
import { InMemoryStore, WritingService } from '@scriptorium/core';
import { createApp } from '../src/app.js';
import { InMemoryIdentityStore } from '../src/identity/memIdentity.js';
import { InMemoryLtiStore } from '../src/lti/store.js';
import { LtiService } from '../src/lti/service.js';
import { generateToolKey, signJwt, _clearJwksCache } from '../src/lti/jose.js';
import { CLAIM, MESSAGE_TYPE, ROLE } from '../src/lti/types.js';

const NOW_MS = 1_750_000_000_000;
const nowS = Math.floor(NOW_MS / 1000);
const platformKey = generateToolKey();
const JWKS_URL = 'https://lms.example.edu/jwks-http';

let server: Server;
let base: string;
let ltiService: LtiService;

const fakeFetch = (async (input: string | URL) => {
  if (String(input) === JWKS_URL) {
    return { ok: true, status: 200, json: async () => ({ keys: [platformKey.publicJwk] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}) as unknown as typeof fetch;

before(async () => {
  _clearJwksCache();
  const store = new InMemoryStore();
  const identity = new InMemoryIdentityStore();
  const ltiStore = new InMemoryLtiStore();
  ltiService = new LtiService(ltiStore, identity, {
    toolBaseUrl: 'http://127.0.0.1',
    fetchImpl: fakeFetch,
    now: () => NOW_MS,
  });
  await ltiService.ensureToolKey();
  await ltiStore.createPlatform({
    issuer: 'https://lms.example.edu',
    client_id: 'client-123',
    deployment_ids: ['dep-1'],
    auth_login_url: 'https://lms.example.edu/auth',
    token_url: 'https://lms.example.edu/token',
    jwks_url: JWKS_URL,
  });
  const service = new WritingService(store);
  const app = createApp({ store, identity, service, lti: { ltiService, ltiStore } });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server?.close());

test('the tool publishes a JWKS with one signing key', async () => {
  const jwks = await fetch(`${base}/lti/jwks`).then((r) => r.json());
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].kty, 'RSA');
  assert.ok(jwks.keys[0].kid);
});

test('OIDC login initiation redirects to the platform auth endpoint', async () => {
  const res = await fetch(
    `${base}/lti/login?iss=${encodeURIComponent('https://lms.example.edu')}&client_id=client-123&login_hint=u1&target_link_uri=${encodeURIComponent(base + '/lti/launch')}`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 302);
  const loc = res.headers.get('location')!;
  assert.ok(loc.startsWith('https://lms.example.edu/auth'));
  assert.ok(new URL(loc).searchParams.get('state'));
});

function studentToken(nonce: string): string {
  return signJwt(
    {
      iss: 'https://lms.example.edu',
      aud: 'client-123',
      sub: 'stu-http-1',
      nonce,
      iat: nowS,
      exp: nowS + 600,
      email: 'stu-http@lms.edu',
      [CLAIM.messageType]: MESSAGE_TYPE.resourceLinkRequest,
      [CLAIM.version]: '1.3.0',
      [CLAIM.deploymentId]: 'dep-1',
      [CLAIM.roles]: [ROLE.learner],
      [CLAIM.resourceLink]: { id: 'rl-http', title: 'HTTP Essay' },
      [CLAIM.context]: { id: 'course-1', title: 'Course' },
    },
    { privatePem: platformKey.privatePem, kid: platformKey.kid },
  );
}

test('a signed student launch signs in via cookie and lands in the bound session', async () => {
  // Obtain a real (state, nonce) by exercising the login the same way the route does.
  const redirect = await ltiService.buildLoginRedirect({
    iss: 'https://lms.example.edu',
    login_hint: 'u1',
    target_link_uri: `${base}/lti/launch`,
    client_id: 'client-123',
  });
  const u = new URL(redirect);
  const state = u.searchParams.get('state')!;
  const nonce = u.searchParams.get('nonce')!;

  const launch = await fetch(`${base}/lti/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: studentToken(nonce), state }).toString(),
    redirect: 'manual',
  });
  assert.equal(launch.status, 302);
  const loc = launch.headers.get('location')!;
  assert.match(loc, /^\/\?session=/, 'student is redirected to their editor session');
  const sessionId = new URL(loc, base).searchParams.get('session')!;
  const cookie = (launch.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.startsWith('sid='), 'a session cookie was set by the launch');

  // The cookie authorizes the student to read and write THEIR session.
  const docRes = await fetch(`${base}/api/sessions/${sessionId}/doc`, { headers: { cookie } });
  assert.equal(docRes.status, 200);
  const docJson = await docRes.json();
  const doc = PMNode.fromJSON(schema, docJson.doc);

  const tr = new Transform(doc);
  tr.insert(doc.content.size - 1, schema.text('Written after an LTI launch. '));
  const write = await fetch(`${base}/api/sessions/${sessionId}/steps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ version: docJson.version, clientID: 'lti', steps: tr.steps.map((s) => s.toJSON()) }),
  }).then((r) => r.json());
  assert.equal(write.status, 'accepted');

  // Without the cookie, the same session is denied.
  const denied = await fetch(`${base}/api/sessions/${sessionId}/doc`);
  assert.equal(denied.status, 403);
});
