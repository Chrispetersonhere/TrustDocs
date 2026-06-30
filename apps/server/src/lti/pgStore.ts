/**
 * Postgres LtiStore.
 */
import type pg from 'pg';
import { getPool } from '../db/pool.js';
import type { LtiStore } from './store.js';
import type { LoginState, LtiPlatform, ToolKeyRecord } from './types.js';

function rowToPlatform(r: any): LtiPlatform {
  return {
    id: r.id,
    issuer: r.issuer,
    client_id: r.client_id,
    deployment_ids: r.deployment_ids ?? [],
    auth_login_url: r.auth_login_url,
    token_url: r.token_url,
    jwks_url: r.jwks_url,
    created_at: new Date(r.created_at).toISOString(),
  };
}

export class PgLtiStore implements LtiStore {
  private pool: pg.Pool;
  constructor(pool: pg.Pool = getPool()) {
    this.pool = pool;
  }

  async saveToolKey(rec: ToolKeyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO lti_tool_keys (kid, private_pem, public_jwk)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (kid) DO NOTHING`,
      [rec.kid, rec.private_pem, JSON.stringify(rec.public_jwk)],
    );
  }
  async getToolKey(): Promise<ToolKeyRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT kid, private_pem, public_jwk FROM lti_tool_keys ORDER BY created_at DESC LIMIT 1',
    );
    return rows[0]
      ? { kid: rows[0].kid, private_pem: rows[0].private_pem, public_jwk: rows[0].public_jwk }
      : null;
  }
  async listPublicJwks(): Promise<ToolKeyRecord['public_jwk'][]> {
    const { rows } = await this.pool.query(
      'SELECT public_jwk FROM lti_tool_keys ORDER BY created_at DESC',
    );
    return rows.map((r: any) => r.public_jwk);
  }

  async createPlatform(input: Omit<LtiPlatform, 'id' | 'created_at'>): Promise<LtiPlatform> {
    const { rows } = await this.pool.query(
      `INSERT INTO lti_platforms (issuer, client_id, deployment_ids, auth_login_url, token_url, jwks_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (issuer, client_id) DO UPDATE SET
         deployment_ids = EXCLUDED.deployment_ids,
         auth_login_url = EXCLUDED.auth_login_url,
         token_url = EXCLUDED.token_url,
         jwks_url = EXCLUDED.jwks_url
       RETURNING *`,
      [
        input.issuer,
        input.client_id,
        input.deployment_ids,
        input.auth_login_url,
        input.token_url,
        input.jwks_url,
      ],
    );
    return rowToPlatform(rows[0]);
  }
  async getPlatform(id: string): Promise<LtiPlatform | null> {
    const { rows } = await this.pool.query('SELECT * FROM lti_platforms WHERE id = $1', [id]);
    return rows[0] ? rowToPlatform(rows[0]) : null;
  }
  async getPlatformByIssuerClient(issuer: string, clientId: string): Promise<LtiPlatform | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM lti_platforms WHERE issuer = $1 AND client_id = $2',
      [issuer, clientId],
    );
    return rows[0] ? rowToPlatform(rows[0]) : null;
  }
  async listPlatforms(): Promise<LtiPlatform[]> {
    const { rows } = await this.pool.query('SELECT * FROM lti_platforms ORDER BY created_at');
    return rows.map(rowToPlatform);
  }

  async saveLoginState(state: LoginState): Promise<void> {
    await this.pool.query(
      'INSERT INTO lti_login_state (state, platform_id, nonce) VALUES ($1, $2, $3)',
      [state.state, state.platform_id, state.nonce],
    );
  }
  async consumeLoginState(state: string): Promise<LoginState | null> {
    const { rows } = await this.pool.query(
      'DELETE FROM lti_login_state WHERE state = $1 RETURNING state, platform_id, nonce',
      [state],
    );
    return rows[0] ? { state: rows[0].state, platform_id: rows[0].platform_id, nonce: rows[0].nonce } : null;
  }

  async mapLtiUser(platformId: string, sub: string, userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO lti_users (platform_id, sub, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (platform_id, sub) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [platformId, sub, userId],
    );
  }
  async getLtiUser(platformId: string, sub: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT user_id FROM lti_users WHERE platform_id = $1 AND sub = $2',
      [platformId, sub],
    );
    return rows[0]?.user_id ?? null;
  }
}
