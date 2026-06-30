/**
 * Minimal JOSE (RS256) for LTI 1.3, built on node:crypto so the tool stays
 * dependency-light and self-hostable with no native build.
 *
 * LTI 1.3 launches are platform-signed JWTs; we verify them against the
 * platform's published JWKS. The tool also signs its own client-credentials
 * assertions (for LTI Advantage services) and publishes its public key at the
 * tool JWKS endpoint.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type JsonWebKey,
} from 'node:crypto';

export function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export interface JwtHeader {
  alg: 'RS256';
  typ?: string;
  kid?: string;
}

/** Sign a JWT with RS256. `privatePem` is a PKCS#8 PEM string. */
export function signJwt(
  payload: Record<string, unknown>,
  opts: { privatePem: string; kid: string; typ?: string },
): string {
  const header: JwtHeader = { alg: 'RS256', typ: opts.typ ?? 'JWT', kid: opts.kid };
  const signingInput =
    b64urlEncode(JSON.stringify(header)) + '.' + b64urlEncode(JSON.stringify(payload));
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(createPrivateKey(opts.privatePem));
  return signingInput + '.' + b64urlEncode(signature);
}

export interface DecodedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

/** Decode without verifying — used to read the `kid` before key selection. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt_malformed');
  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as JwtHeader;
  const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
  return {
    header,
    payload,
    signingInput: parts[0] + '.' + parts[1],
    signature: b64urlDecode(parts[2]),
  };
}

/** Verify an RS256 JWT signature against a public key (JWK). Returns the payload. */
export function verifyJwt(token: string, publicJwk: JsonWebKey): Record<string, unknown> {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== 'RS256') throw new Error('jwt_alg_unsupported');
  const key = createPublicKey({ key: publicJwk, format: 'jwk' });
  const ok = createVerify('RSA-SHA256').update(decoded.signingInput).verify(key, decoded.signature);
  if (!ok) throw new Error('jwt_signature_invalid');
  return decoded.payload;
}

/** RFC 7638 JWK thumbprint (used as a stable `kid`). */
export function jwkThumbprint(jwk: JsonWebKey): string {
  const ordered = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash('sha256').update(ordered).digest('base64url');
}

export interface ToolKey {
  kid: string;
  privatePem: string;
  publicJwk: JsonWebKey;
}

/** Generate an RSA 2048 tool signing key, with a thumbprint `kid`. */
export function generateToolKey(): ToolKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const kid = jwkThumbprint(publicJwk);
  return { kid, privatePem, publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' } };
}

/** A JWKS document with one or more public keys, for the tool JWKS endpoint. */
export function toJwks(publicJwks: JsonWebKey[]): { keys: JsonWebKey[] } {
  return { keys: publicJwks };
}

/**
 * Fetch and cache a platform's JWKS, returning the JWK matching `kid`.
 * Platforms rotate keys, so we re-fetch on a cache miss for an unknown kid.
 */
const jwksCache = new Map<string, { fetchedAt: number; keys: JsonWebKey[] }>();
const JWKS_TTL_MS = 5 * 60_000;

export async function fetchPlatformKey(
  jwksUrl: string,
  kid: string | undefined,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<JsonWebKey> {
  const cached = jwksCache.get(jwksUrl);
  const fresh = cached && now - cached.fetchedAt < JWKS_TTL_MS;
  const match = (keys: JsonWebKey[]) =>
    kid ? keys.find((k) => k.kid === kid) : keys[0];

  if (fresh) {
    const k = match(cached!.keys);
    if (k) return k;
  }

  const res = await fetchImpl(jwksUrl);
  if (!res.ok) throw new Error(`jwks_fetch_failed:${res.status}`);
  const body = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache.set(jwksUrl, { fetchedAt: now, keys: body.keys ?? [] });
  const k = match(body.keys ?? []);
  if (!k) throw new Error('jwks_kid_not_found');
  return k;
}

/** For tests: clear the JWKS cache. */
export function _clearJwksCache(): void {
  jwksCache.clear();
}

export { createPublicKey };
