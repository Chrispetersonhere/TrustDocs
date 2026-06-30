/**
 * LTI 1.3 service: OIDC third-party login, launch validation, identity
 * provisioning, and NRPS roster sync (build spec §4 note — the eventual path for
 * identity and roster sync).
 *
 * The unforgeable binding the rest of the tool needs comes from the
 * platform-signed launch JWT: the platform vouches for who the user is, their
 * role, and which course/resource link they launched. We never trust the client
 * for any of that. (As elsewhere, we still never trust the client for time or
 * final document state.)
 */
import { randomToken } from '../auth/password.js';
import type { IdentityStore, User } from '../identity/types.js';
import type { Assignment } from '../identity/types.js';
import {
  fetchPlatformKey,
  generateToolKey,
  signJwt,
  decodeJwt,
  verifyJwt,
} from './jose.js';
import type { LtiStore } from './store.js';
import {
  CLAIM,
  MESSAGE_TYPE,
  mapRoles,
  type LaunchContext,
  type LtiPlatform,
  type ToolKeyRecord,
} from './types.js';

export interface OidcLoginParams {
  iss: string;
  login_hint: string;
  target_link_uri: string;
  client_id?: string;
  lti_message_hint?: string;
  lti_deployment_id?: string;
}

const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
const CLOCK_SKEW_S = 300;

export class LtiService {
  constructor(
    private lti: LtiStore,
    private identity: IdentityStore,
    private opts: { toolBaseUrl: string; fetchImpl?: typeof fetch; now?: () => number } = {
      toolBaseUrl: 'http://localhost:3000',
    },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  private fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /** Ensure the tool has a signing key, generating and persisting one if absent. */
  async ensureToolKey(): Promise<ToolKeyRecord> {
    const existing = await this.lti.getToolKey();
    if (existing) return existing;
    const k = generateToolKey();
    const rec: ToolKeyRecord = { kid: k.kid, private_pem: k.privatePem, public_jwk: k.publicJwk };
    await this.lti.saveToolKey(rec);
    return rec;
  }

  // --- OIDC third-party-initiated login ------------------------------------

  /**
   * Build the redirect to the platform's authorization endpoint. The platform
   * initiates login by calling our /lti/login with these params; we answer with
   * an OIDC auth request (response_mode=form_post, response_type=id_token).
   */
  async buildLoginRedirect(p: OidcLoginParams): Promise<string> {
    const platform = await this.resolvePlatform(p.iss, p.client_id);
    if (!platform) throw new Error('unknown_platform');

    const state = randomToken();
    const nonce = randomToken();
    await this.lti.saveLoginState({ state, platform_id: platform.id, nonce });

    const url = new URL(platform.auth_login_url);
    const params: Record<string, string> = {
      scope: 'openid',
      response_type: 'id_token',
      response_mode: 'form_post',
      prompt: 'none',
      client_id: platform.client_id,
      redirect_uri: `${this.opts.toolBaseUrl}/lti/launch`,
      state,
      nonce,
      login_hint: p.login_hint,
    };
    if (p.lti_message_hint) params.lti_message_hint = p.lti_message_hint;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async resolvePlatform(iss: string, clientId?: string): Promise<LtiPlatform | null> {
    if (clientId) return this.lti.getPlatformByIssuerClient(iss, clientId);
    // No client_id supplied: fall back to a unique registration for this issuer.
    const matches = (await this.lti.listPlatforms()).filter((p) => p.issuer === iss);
    return matches.length === 1 ? matches[0] : null;
  }

  // --- Launch validation ----------------------------------------------------

  /**
   * Validate a launch id_token against the platform that issued the login state.
   * Throws on any failure (bad signature, replay, wrong audience, expired,
   * unexpected message type). Returns the salient launch facts.
   */
  async validateLaunch(idToken: string, state: string): Promise<LaunchContext> {
    const login = await this.lti.consumeLoginState(state);
    if (!login) throw new Error('invalid_state'); // unknown or already used (replay)

    const platform = await this.lti.getPlatform(login.platform_id);
    if (!platform) throw new Error('unknown_platform');

    const { header, payload } = decodeJwt(idToken);

    // iss/aud must match the registration tied to this login.
    if (payload.iss !== platform.issuer) throw new Error('iss_mismatch');
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(platform.client_id) : aud === platform.client_id;
    if (!audOk) throw new Error('aud_mismatch');

    // Signature against the platform JWKS (by kid).
    const jwk = await fetchPlatformKey(platform.jwks_url, header.kid, this.now(), this.fetch());
    verifyJwt(idToken, jwk);

    // Temporal + replay checks.
    const nowS = Math.floor(this.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp + CLOCK_SKEW_S < nowS)
      throw new Error('token_expired');
    if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > nowS)
      throw new Error('token_future');
    if (payload.nonce !== login.nonce) throw new Error('nonce_mismatch');

    // LTI message shape.
    if (payload[CLAIM.messageType] !== MESSAGE_TYPE.resourceLinkRequest)
      throw new Error('unsupported_message_type');
    if (payload[CLAIM.version] !== '1.3.0') throw new Error('unsupported_lti_version');

    const deploymentId = String(payload[CLAIM.deploymentId] ?? '');
    if (
      platform.deployment_ids.length > 0 &&
      deploymentId &&
      !platform.deployment_ids.includes(deploymentId)
    ) {
      throw new Error('unknown_deployment');
    }

    const resourceLink = payload[CLAIM.resourceLink] as { id?: string; title?: string } | undefined;
    if (!resourceLink?.id) throw new Error('missing_resource_link');

    const context = payload[CLAIM.context] as { id?: string; title?: string } | undefined;
    const nrps = payload[CLAIM.nrps] as { context_memberships_url?: string } | undefined;

    return {
      platform,
      sub: String(payload.sub ?? ''),
      role: mapRoles(payload[CLAIM.roles]),
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof payload.name === 'string' ? payload.name : null,
      context: context?.id ? { id: context.id, title: context.title ?? null } : null,
      resourceLink: { id: resourceLink.id, title: resourceLink.title ?? null },
      deploymentId,
      nrpsUrl: nrps?.context_memberships_url ?? null,
    };
  }

  // --- Provisioning ---------------------------------------------------------

  /** Map an LTI subject to a local user, creating one on first sight. */
  private async provisionUser(ctx: LaunchContext): Promise<User> {
    const mapped = await this.lti.getLtiUser(ctx.platform.id, ctx.sub);
    if (mapped) {
      const u = await this.identity.getUserById(mapped);
      if (u) return u;
    }
    const synthEmail = `lti-${ctx.platform.id}-${ctx.sub}@lti.local`.toLowerCase();
    let user: User | null = null;

    if (ctx.email) {
      const existing = await this.identity.getUserByEmail(ctx.email);
      if (existing && existing.role === ctx.role) {
        user = { id: existing.id, email: existing.email, role: existing.role };
      } else if (!existing) {
        try {
          user =
            ctx.role === 'student'
              ? await this.identity.getOrCreateStudent(ctx.email)
              : await this.identity.createUser({
                  email: ctx.email,
                  password_hash: '!',
                  role: 'instructor',
                });
        } catch {
          user = null;
        }
      }
    }
    if (!user) {
      user =
        ctx.role === 'student'
          ? await this.identity.getOrCreateStudent(synthEmail)
          : await this.identity.createUser({
              email: synthEmail,
              password_hash: '!',
              role: 'instructor',
            });
    }
    await this.lti.mapLtiUser(ctx.platform.id, ctx.sub, user.id);
    return user;
  }

  /** Find or create the assignment bound to the launched resource link. */
  private async provisionAssignment(ctx: LaunchContext, owner: User): Promise<Assignment> {
    const existing = await this.identity.getAssignmentByResourceLink(
      ctx.platform.id,
      ctx.resourceLink.id,
    );
    const title = ctx.resourceLink.title || ctx.context?.title || 'LTI Assignment';

    if (existing) {
      // An instructor launch claims ownership and records the NRPS endpoint.
      if (ctx.role === 'instructor') {
        await this.identity.transferAssignmentOwner(existing.id, owner.id);
        if (ctx.nrpsUrl && !existing.lti_nrps_url) {
          await this.identity.setAssignmentNrpsUrl(existing.id, ctx.nrpsUrl);
        }
      }
      return (await this.identity.getAssignment(existing.id)) ?? existing;
    }

    // First launch creates the assignment. If a student launches first, the
    // owner is a per-platform service instructor; a later instructor launch
    // transfers ownership so it appears on their dashboard.
    const ownerId =
      ctx.role === 'instructor' ? owner.id : (await this.serviceInstructor(ctx.platform)).id;
    return this.identity.createAssignment({
      instructor_id: ownerId,
      title,
      retention_days: null,
      lti_platform_id: ctx.platform.id,
      lti_resource_link_id: ctx.resourceLink.id,
      lti_nrps_url: ctx.nrpsUrl ?? null,
    });
  }

  private async serviceInstructor(platform: LtiPlatform): Promise<User> {
    const email = `lti-service-${platform.id}@lti.local`;
    const existing = await this.identity.getUserByEmail(email);
    if (existing) return { id: existing.id, email: existing.email, role: existing.role };
    return this.identity.createUser({ email, password_hash: '!', role: 'instructor' });
  }

  /** Full provisioning for a validated launch. */
  async provision(ctx: LaunchContext): Promise<{ user: User; assignment: Assignment }> {
    const user = await this.provisionUser(ctx);
    const assignment = await this.provisionAssignment(ctx, user);
    return { user, assignment };
  }

  // --- NRPS roster sync (LTI Advantage) ------------------------------------

  /** Obtain a client-credentials access token from the platform token endpoint. */
  private async serviceAccessToken(platform: LtiPlatform, scope: string): Promise<string> {
    const key = await this.ensureToolKey();
    const nowS = Math.floor(this.now() / 1000);
    const assertion = signJwt(
      {
        iss: platform.client_id,
        sub: platform.client_id,
        aud: platform.token_url,
        iat: nowS,
        exp: nowS + 300,
        jti: randomToken(16),
      },
      { privatePem: key.private_pem, kid: key.kid },
    );

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      scope,
    });
    const res = await this.fetch()(platform.token_url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`token_request_failed:${res.status}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('no_access_token');
    return json.access_token;
  }

  /**
   * Sync the course roster for an LTI assignment and provision a local student
   * user per member. Returns the provisioned members. Requires that an
   * instructor launch captured the NRPS endpoint.
   */
  async syncRoster(
    assignment: Assignment,
  ): Promise<Array<{ email: string; name: string | null; role: 'instructor' | 'student' }>> {
    if (!assignment.lti_platform_id || !assignment.lti_nrps_url) {
      throw new Error('no_nrps_endpoint');
    }
    const platform = await this.lti.getPlatform(assignment.lti_platform_id);
    if (!platform) throw new Error('unknown_platform');

    const accessToken = await this.serviceAccessToken(platform, NRPS_SCOPE);
    const res = await this.fetch()(assignment.lti_nrps_url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
      },
    });
    if (!res.ok) throw new Error(`nrps_request_failed:${res.status}`);
    const body = (await res.json()) as {
      members?: Array<{ user_id: string; name?: string; email?: string; roles?: string[]; status?: string }>;
    };

    const out: Array<{ email: string; name: string | null; role: 'instructor' | 'student' }> = [];
    for (const m of body.members ?? []) {
      if (m.status === 'Inactive') continue;
      const role = mapRoles(m.roles);
      // Provision the user (reusing the same mapping as a launch would).
      await this.provisionUser({
        platform,
        sub: m.user_id,
        role,
        email: m.email ?? null,
        name: m.name ?? null,
        context: null,
        resourceLink: { id: '', title: null },
        deploymentId: '',
        nrpsUrl: null,
      });
      out.push({ email: m.email ?? `lti-${platform.id}-${m.user_id}@lti.local`, name: m.name ?? null, role });
    }
    return out;
  }
}
