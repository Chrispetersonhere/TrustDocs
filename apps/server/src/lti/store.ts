/**
 * Storage for the LTI 1.3 registration and launch state.
 */
import { randomUUID } from 'node:crypto';
import type { LoginState, LtiPlatform, ToolKeyRecord } from './types.js';

export interface LtiStore {
  // Tool signing key (for the JWKS endpoint and service assertions).
  saveToolKey(rec: ToolKeyRecord): Promise<void>;
  getToolKey(): Promise<ToolKeyRecord | null>;
  listPublicJwks(): Promise<ToolKeyRecord['public_jwk'][]>;

  // Platform registrations.
  createPlatform(input: Omit<LtiPlatform, 'id' | 'created_at'>): Promise<LtiPlatform>;
  getPlatform(id: string): Promise<LtiPlatform | null>;
  getPlatformByIssuerClient(issuer: string, clientId: string): Promise<LtiPlatform | null>;
  listPlatforms(): Promise<LtiPlatform[]>;

  // OIDC login state (single-use, ties the login request to its launch).
  saveLoginState(state: LoginState): Promise<void>;
  consumeLoginState(state: string): Promise<LoginState | null>;

  // LTI subject -> local user mapping.
  mapLtiUser(platformId: string, sub: string, userId: string): Promise<void>;
  getLtiUser(platformId: string, sub: string): Promise<string | null>;
}

export class InMemoryLtiStore implements LtiStore {
  private toolKey: ToolKeyRecord | null = null;
  private platforms = new Map<string, LtiPlatform>();
  private loginStates = new Map<string, LoginState>();
  private ltiUsers = new Map<string, string>(); // `${platform}|${sub}` -> userId

  async saveToolKey(rec: ToolKeyRecord): Promise<void> {
    this.toolKey = rec;
  }
  async getToolKey(): Promise<ToolKeyRecord | null> {
    return this.toolKey;
  }
  async listPublicJwks(): Promise<ToolKeyRecord['public_jwk'][]> {
    return this.toolKey ? [this.toolKey.public_jwk] : [];
  }

  async createPlatform(input: Omit<LtiPlatform, 'id' | 'created_at'>): Promise<LtiPlatform> {
    const existing = await this.getPlatformByIssuerClient(input.issuer, input.client_id);
    if (existing) {
      const updated: LtiPlatform = { ...existing, ...input };
      this.platforms.set(existing.id, updated);
      return updated;
    }
    const platform: LtiPlatform = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      ...input,
    };
    this.platforms.set(platform.id, platform);
    return platform;
  }
  async getPlatform(id: string): Promise<LtiPlatform | null> {
    return this.platforms.get(id) ?? null;
  }
  async getPlatformByIssuerClient(issuer: string, clientId: string): Promise<LtiPlatform | null> {
    return (
      [...this.platforms.values()].find(
        (p) => p.issuer === issuer && p.client_id === clientId,
      ) ?? null
    );
  }
  async listPlatforms(): Promise<LtiPlatform[]> {
    return [...this.platforms.values()];
  }

  async saveLoginState(state: LoginState): Promise<void> {
    this.loginStates.set(state.state, state);
  }
  async consumeLoginState(state: string): Promise<LoginState | null> {
    const s = this.loginStates.get(state) ?? null;
    if (s) this.loginStates.delete(state);
    return s;
  }

  async mapLtiUser(platformId: string, sub: string, userId: string): Promise<void> {
    this.ltiUsers.set(`${platformId}|${sub}`, userId);
  }
  async getLtiUser(platformId: string, sub: string): Promise<string | null> {
    return this.ltiUsers.get(`${platformId}|${sub}`) ?? null;
  }
}
