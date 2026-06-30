/**
 * LTI 1.3 service tests (build spec §4 note — identity & roster sync path).
 *
 * A mock platform plays the LMS: it signs launch JWTs with its own key, serves a
 * JWKS, and answers the token + NRPS endpoints. We assert the full launch →
 * provision flow and the security checks (signature, replay, nonce, audience,
 * expiry).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryIdentityStore } from '../src/identity/memIdentity.js';
import { InMemoryLtiStore } from '../src/lti/store.js';
import { LtiService } from '../src/lti/service.js';
import { generateToolKey, signJwt, verifyJwt, _clearJwksCache } from '../src/lti/jose.js';
import { CLAIM, MESSAGE_TYPE, ROLE } from '../src/lti/types.js';

const NOW_MS = 1_750_000_000_000; // fixed clock
const nowS = Math.floor(NOW_MS / 1000);

// One platform signing key reused across the suite.
const platformKey = generateToolKey();

let jwksUrlCounter = 0;

function makeFetch(opts: {
  jwksUrl: string;
  tokenUrl?: string;
  nrpsUrl?: string;
  members?: unknown[];
}): typeof fetch {
  const fake = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (url === opts.jwksUrl) return ok({ keys: [platformKey.publicJwk] });
    if (opts.tokenUrl && url === opts.tokenUrl) {
      void init;
      return ok({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 300 });
    }
    if (opts.nrpsUrl && url === opts.nrpsUrl) return ok({ members: opts.members ?? [] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return fake as unknown as typeof fetch;
}

function build(fetchImpl: typeof fetch) {
  const identity = new InMemoryIdentityStore();
  const lti = new InMemoryLtiStore();
  const service = new LtiService(lti, identity, {
    toolBaseUrl: 'https://tool.example.edu',
    fetchImpl,
    now: () => NOW_MS,
  });
  return { identity, lti, service };
}

async function registerPlatform(lti: InMemoryLtiStore, jwksUrl: string, extra?: Partial<any>) {
  return lti.createPlatform({
    issuer: 'https://lms.example.edu',
    client_id: 'client-123',
    deployment_ids: ['dep-1'],
    auth_login_url: 'https://lms.example.edu/auth',
    token_url: 'https://lms.example.edu/token',
    jwks_url: jwksUrl,
    ...extra,
  });
}

interface LaunchOpts {
  nonce: string;
  role?: 'instructor' | 'student';
  sub?: string;
  email?: string;
  resourceLinkId?: string;
  contextTitle?: string;
  nrpsUrl?: string;
  deploymentId?: string;
  exp?: number;
  audience?: string;
}

function makeIdToken(o: LaunchOpts): string {
  const roles = o.role === 'student' ? [ROLE.learner] : [ROLE.instructor];
  return signJwt(
    {
      iss: 'https://lms.example.edu',
      aud: o.audience ?? 'client-123',
      sub: o.sub ?? 'lms-user-1',
      nonce: o.nonce,
      iat: nowS,
      exp: o.exp ?? nowS + 600,
      email: o.email,
      name: 'Test User',
      [CLAIM.messageType]: MESSAGE_TYPE.resourceLinkRequest,
      [CLAIM.version]: '1.3.0',
      [CLAIM.deploymentId]: o.deploymentId ?? 'dep-1',
      [CLAIM.roles]: roles,
      [CLAIM.resourceLink]: { id: o.resourceLinkId ?? 'rl-1', title: 'Essay 1' },
      [CLAIM.context]: { id: 'course-1', title: o.contextTitle ?? 'Course 1' },
      ...(o.nrpsUrl
        ? { [CLAIM.nrps]: { context_memberships_url: o.nrpsUrl } }
        : {}),
    },
    { privatePem: platformKey.privatePem, kid: platformKey.kid },
  );
}

/** Run a login to obtain a real (state, nonce) pair, as the OIDC flow would. */
async function login(service: LtiService): Promise<{ state: string; nonce: string }> {
  const redirect = await service.buildLoginRedirect({
    iss: 'https://lms.example.edu',
    login_hint: 'user-1',
    target_link_uri: 'https://tool.example.edu/lti/launch',
    client_id: 'client-123',
  });
  const u = new URL(redirect);
  return { state: u.searchParams.get('state')!, nonce: u.searchParams.get('nonce')! };
}

test('JOSE: sign and verify round-trips; tampering fails', () => {
  const tok = signJwt({ hello: 'world' }, { privatePem: platformKey.privatePem, kid: platformKey.kid });
  assert.equal(verifyJwt(tok, platformKey.publicJwk).hello, 'world');
  const otherKey = generateToolKey();
  assert.throws(() => verifyJwt(tok, otherKey.publicJwk), /signature_invalid/);
});

test('login redirect carries OIDC params and persists single-use state', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);
  const redirect = await service.buildLoginRedirect({
    iss: 'https://lms.example.edu',
    login_hint: 'user-1',
    target_link_uri: 'https://tool.example.edu/lti/launch',
    client_id: 'client-123',
  });
  const u = new URL(redirect);
  assert.equal(u.searchParams.get('response_type'), 'id_token');
  assert.equal(u.searchParams.get('response_mode'), 'form_post');
  assert.equal(u.searchParams.get('client_id'), 'client-123');
  assert.ok(u.searchParams.get('state'));
  assert.ok(u.searchParams.get('nonce'));
});

test('a valid instructor launch validates and provisions an owned assignment', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const nrpsUrl = 'https://lms.example.edu/nrps/course-1';
  const { service, lti, identity } = build(makeFetch({ jwksUrl, nrpsUrl }));
  await registerPlatform(lti, jwksUrl);

  const { state, nonce } = await login(service);
  const ctx = await service.validateLaunch(
    makeIdToken({ nonce, role: 'instructor', sub: 'prof-1', email: 'prof@lms.edu', nrpsUrl }),
    state,
  );
  assert.equal(ctx.role, 'instructor');
  assert.equal(ctx.resourceLink.id, 'rl-1');
  assert.equal(ctx.nrpsUrl, nrpsUrl);

  const { user, assignment } = await service.provision(ctx);
  assert.equal(user.role, 'instructor');
  assert.equal(assignment.instructor_id, user.id);
  assert.equal(assignment.lti_resource_link_id, 'rl-1');
  assert.equal(assignment.lti_nrps_url, nrpsUrl);
  // The assignment is now visible on that instructor's dashboard.
  const mine = await identity.listAssignmentsByInstructor(user.id);
  assert.equal(mine.length, 1);
});

test('student launches join the same assignment; a later instructor claims ownership', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti, identity } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);

  // Student launches first → assignment created, owned by a service instructor.
  let { state, nonce } = await login(service);
  const sctx = await service.validateLaunch(
    makeIdToken({ nonce, role: 'student', sub: 'stu-1', email: 'stu1@lms.edu' }),
    state,
  );
  const s1 = await service.provision(sctx);
  assert.equal(s1.user.role, 'student');
  assert.notEqual(s1.assignment.instructor_id, s1.user.id);
  const serviceOwner = s1.assignment.instructor_id;

  // Second student, same resource link → same assignment.
  ({ state, nonce } = await login(service));
  const s2 = await service.provision(
    await service.validateLaunch(
      makeIdToken({ nonce, role: 'student', sub: 'stu-2', email: 'stu2@lms.edu' }),
      state,
    ),
  );
  assert.equal(s2.assignment.id, s1.assignment.id);
  assert.notEqual(s2.user.id, s1.user.id);

  // Instructor launches → claims ownership of the existing assignment.
  ({ state, nonce } = await login(service));
  const ic = await service.provision(
    await service.validateLaunch(
      makeIdToken({ nonce, role: 'instructor', sub: 'prof-1', email: 'prof@lms.edu' }),
      state,
    ),
  );
  assert.equal(ic.assignment.id, s1.assignment.id);
  assert.equal(ic.assignment.instructor_id, ic.user.id);
  assert.notEqual(ic.assignment.instructor_id, serviceOwner);
  assert.equal((await identity.listAssignmentsByInstructor(ic.user.id)).length, 1);
});

test('the same LTI subject maps to a stable local user across launches', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);

  let { state, nonce } = await login(service);
  const a = await service.provision(
    await service.validateLaunch(makeIdToken({ nonce, role: 'student', sub: 'stu-9' }), state),
  );
  ({ state, nonce } = await login(service));
  const b = await service.provision(
    await service.validateLaunch(makeIdToken({ nonce, role: 'student', sub: 'stu-9' }), state),
  );
  assert.equal(a.user.id, b.user.id);
});

test('replayed state is rejected (single-use)', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);
  const { state, nonce } = await login(service);
  await service.validateLaunch(makeIdToken({ nonce }), state);
  await assert.rejects(
    service.validateLaunch(makeIdToken({ nonce }), state),
    /invalid_state/,
  );
});

test('a nonce mismatch is rejected', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);
  const { state } = await login(service);
  await assert.rejects(
    service.validateLaunch(makeIdToken({ nonce: 'wrong-nonce' }), state),
    /nonce_mismatch/,
  );
});

test('a wrong audience is rejected', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);
  const { state, nonce } = await login(service);
  await assert.rejects(
    service.validateLaunch(makeIdToken({ nonce, audience: 'someone-else' }), state),
    /aud_mismatch/,
  );
});

test('a signature from the wrong key is rejected', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);
  const { state, nonce } = await login(service);
  const impostor = generateToolKey();
  const forged = signJwt(
    {
      iss: 'https://lms.example.edu',
      aud: 'client-123',
      sub: 'x',
      nonce,
      iat: nowS,
      exp: nowS + 600,
      [CLAIM.messageType]: MESSAGE_TYPE.resourceLinkRequest,
      [CLAIM.version]: '1.3.0',
      [CLAIM.deploymentId]: 'dep-1',
      [CLAIM.roles]: [ROLE.learner],
      [CLAIM.resourceLink]: { id: 'rl-1' },
    },
    { privatePem: impostor.privatePem, kid: platformKey.kid }, // claims our kid, wrong key
  );
  await assert.rejects(service.validateLaunch(forged, state), /signature_invalid/);
});

test('an expired token is rejected', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const { service, lti } = build(makeFetch({ jwksUrl }));
  await registerPlatform(lti, jwksUrl);
  const { state, nonce } = await login(service);
  await assert.rejects(
    service.validateLaunch(makeIdToken({ nonce, exp: nowS - 1000 }), state),
    /token_expired/,
  );
});

test('NRPS roster sync provisions a student per active member', async () => {
  _clearJwksCache();
  const jwksUrl = `https://lms.example.edu/jwks-${jwksUrlCounter++}`;
  const nrpsUrl = 'https://lms.example.edu/nrps/course-1';
  const members = [
    { user_id: 'm1', name: 'Ann', email: 'ann@lms.edu', roles: [ROLE.learner], status: 'Active' },
    { user_id: 'm2', name: 'Bo', email: 'bo@lms.edu', roles: [ROLE.learner], status: 'Active' },
    { user_id: 'm3', name: 'Gone', email: 'gone@lms.edu', roles: [ROLE.learner], status: 'Inactive' },
  ];
  const { service, lti, identity } = build(
    makeFetch({ jwksUrl, tokenUrl: 'https://lms.example.edu/token', nrpsUrl, members }),
  );
  await registerPlatform(lti, jwksUrl);

  const { state, nonce } = await login(service);
  const { assignment } = await service.provision(
    await service.validateLaunch(
      makeIdToken({ nonce, role: 'instructor', sub: 'prof-1', email: 'prof@lms.edu', nrpsUrl }),
      state,
    ),
  );

  const roster = await service.syncRoster(assignment);
  assert.equal(roster.length, 2, 'inactive members are skipped');
  assert.ok(await identity.getUserByEmail('ann@lms.edu'));
  assert.ok(await identity.getUserByEmail('bo@lms.edu'));
});
