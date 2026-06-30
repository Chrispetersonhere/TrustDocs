-- LTI 1.3 (Core + Advantage) integration (build spec §4 note: the eventual path
-- for identity and roster sync). Added on top of the local-account identity (M2).

-- The tool's own signing key(s), published at the tool JWKS endpoint and used to
-- sign client-credentials assertions for LTI Advantage services.
CREATE TABLE IF NOT EXISTS lti_tool_keys (
  kid         TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  public_jwk  JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A registered platform (LMS) deployment.
CREATE TABLE IF NOT EXISTS lti_platforms (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer         TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  deployment_ids TEXT[] NOT NULL DEFAULT '{}',
  auth_login_url TEXT NOT NULL,
  token_url      TEXT NOT NULL,
  jwks_url       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, client_id)
);

-- Single-use OIDC login state, tying a third-party-initiated login to its launch.
CREATE TABLE IF NOT EXISTS lti_login_state (
  state       TEXT PRIMARY KEY,
  platform_id UUID NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  nonce       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Map an LTI subject (per platform) to a local user.
CREATE TABLE IF NOT EXISTS lti_users (
  platform_id UUID NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  sub         TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (platform_id, sub)
);

-- Bind an assignment to an LTI resource link so launches resolve to it.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS lti_platform_id UUID REFERENCES lti_platforms(id) ON DELETE SET NULL;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS lti_resource_link_id TEXT;
-- Names and Role Provisioning Service endpoint captured at launch, for roster sync.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS lti_nrps_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS assignments_lti_resource_link_idx
  ON assignments (lti_platform_id, lti_resource_link_id)
  WHERE lti_platform_id IS NOT NULL;
