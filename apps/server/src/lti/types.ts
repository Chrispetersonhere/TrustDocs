/**
 * LTI 1.3 (Core + Advantage) claim URIs and tool-side types.
 * See the IMS Global LTI 1.3 / LTI Advantage specifications.
 */
import type { JsonWebKey } from 'node:crypto';

export const CLAIM = {
  messageType: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  version: 'https://purl.imsglobal.org/spec/lti/claim/version',
  deploymentId: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  targetLinkUri: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  resourceLink: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  context: 'https://purl.imsglobal.org/spec/lti/claim/context',
  roles: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  // LTI Advantage — Names and Role Provisioning Service.
  nrps: 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice',
} as const;

export const MESSAGE_TYPE = {
  resourceLinkRequest: 'LtiResourceLinkRequest',
  deepLinkingRequest: 'LtiDeepLinkingRequest',
} as const;

// Role URIs (context membership). A launch may carry several.
export const ROLE = {
  instructor: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  teachingAssistant: 'http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant',
  learner: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
  administrator: 'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator',
} as const;

export type LtiRole = 'instructor' | 'student';

/** Map the LTI roles array to our two local roles. Instructors/TAs/Admins teach. */
export function mapRoles(roles: unknown): LtiRole {
  const list = Array.isArray(roles) ? roles.map(String) : [];
  const teaches = list.some(
    (r) =>
      r === ROLE.instructor ||
      r === ROLE.teachingAssistant ||
      r === ROLE.administrator ||
      r.endsWith('#Instructor') ||
      r.endsWith('#TeachingAssistant') ||
      r.endsWith('#Administrator'),
  );
  return teaches ? 'instructor' : 'student';
}

export interface LtiPlatform {
  id: string;
  /** The platform's issuer (iss). */
  issuer: string;
  /** OAuth2 client_id the platform assigned to this tool. */
  client_id: string;
  /** Allowed deployment ids for this registration. */
  deployment_ids: string[];
  /** OIDC authorization endpoint (where we redirect the login). */
  auth_login_url: string;
  /** OAuth2 token endpoint (for client-credentials when calling services). */
  token_url: string;
  /** Platform JWKS url (to verify launch signatures). */
  jwks_url: string;
  created_at: string;
}

export interface ToolKeyRecord {
  kid: string;
  private_pem: string;
  public_jwk: JsonWebKey;
}

export interface LoginState {
  state: string;
  platform_id: string;
  nonce: string;
}

/** The salient, validated facts extracted from a launch. */
export interface LaunchContext {
  platform: LtiPlatform;
  sub: string;
  role: LtiRole;
  email: string | null;
  name: string | null;
  context: { id: string; title: string | null } | null;
  resourceLink: { id: string; title: string | null };
  deploymentId: string;
  /** NRPS memberships endpoint, if the platform granted it. */
  nrpsUrl: string | null;
}
