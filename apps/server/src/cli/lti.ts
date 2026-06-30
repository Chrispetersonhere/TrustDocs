/**
 * LTI 1.3 administration CLI (requires DATABASE_URL).
 *
 *   lti keygen
 *       Ensure the tool signing key exists; print its kid and public JWK.
 *
 *   lti register --issuer <iss> --client-id <id> \
 *                --auth-login-url <url> --token-url <url> --jwks-url <url> \
 *                [--deployment-id <id> ...]
 *       Register (or update) a platform deployment.
 *
 *   lti list
 *       List registered platforms.
 */
import { closePool } from '../db/pool.js';

function parse(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let key = '_';
  for (const a of argv) {
    if (a.startsWith('--')) {
      key = a.slice(2);
      out[key] = out[key] ?? [];
    } else {
      (out[key] = out[key] ?? []).push(a);
    }
  }
  return out;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('lti CLI requires DATABASE_URL.');
    return 2;
  }
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parse(rest);
  const one = (k: string) => args[k]?.[0];

  const { PgLtiStore } = await import('../lti/pgStore.js');
  const { PgIdentityStore } = await import('../identity/pgIdentity.js');
  const { LtiService } = await import('../lti/service.js');
  const ltiStore = new PgLtiStore();
  const ltiService = new LtiService(ltiStore, new PgIdentityStore(), {
    toolBaseUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  });

  if (cmd === 'keygen') {
    const key = await ltiService.ensureToolKey();
    console.log(`tool key kid: ${key.kid}`);
    console.log('public JWK:');
    console.log(JSON.stringify(key.public_jwk, null, 2));
    return 0;
  }

  if (cmd === 'register') {
    const required = ['issuer', 'client-id', 'auth-login-url', 'token-url', 'jwks-url'];
    const missing = required.filter((k) => !one(k));
    if (missing.length) {
      console.error(`Missing required flags: ${missing.map((m) => '--' + m).join(', ')}`);
      return 2;
    }
    const platform = await ltiStore.createPlatform({
      issuer: one('issuer')!,
      client_id: one('client-id')!,
      deployment_ids: args['deployment-id'] ?? [],
      auth_login_url: one('auth-login-url')!,
      token_url: one('token-url')!,
      jwks_url: one('jwks-url')!,
    });
    console.log(`Registered platform ${platform.id}`);
    console.log(`  issuer:    ${platform.issuer}`);
    console.log(`  client_id: ${platform.client_id}`);
    const base = process.env.PUBLIC_URL ?? 'http://localhost:3000';
    console.log('\nConfigure these tool URLs in the platform:');
    console.log(`  OIDC login init:  ${base}/lti/login`);
    console.log(`  Launch / redirect: ${base}/lti/launch`);
    console.log(`  Tool JWKS:        ${base}/lti/jwks`);
    return 0;
  }

  if (cmd === 'list') {
    const platforms = await ltiStore.listPlatforms();
    if (!platforms.length) console.log('No platforms registered.');
    for (const p of platforms) {
      console.log(`${p.id}  ${p.issuer}  (client_id ${p.client_id})`);
    }
    return 0;
  }

  console.error('Usage: lti <keygen|register|list> [flags]');
  return 2;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
