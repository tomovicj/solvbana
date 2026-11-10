import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearResolutionCache, reviveRawTransaction } from '@solvbana/core';
import { buildApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { corpusAccounts, readJson } from '../../core/test/fixtures.ts';
import { TEST_CONFIG } from './helpers.ts';

const sha = (secret: string) => createHash('sha256').update(secret).digest('hex');
const KEY_A = 'secret-key-for-alpha';
const KEY_B = 'secret-key-for-bravo';
const KEYS = `alpha:${sha(KEY_A)},bravo:${sha(KEY_B)}`;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const PROGRAM = '4F3t3Tpiyoi7Dn8oHytwJFVYJJf8cervvPL7DsZMDnCn';
const SIGNATURE =
  '2L2Z8DkPRKmRDp9PvzjtJyrKpHqchgDDHhpvuPGRNULGpRqfAdERk3ucLPsRvYZR7npRG71WCxayLMPUBAFLtnGi';
const OBSERVED = [0x01, 0x10, 0x18, 0x03, 0x31, 0x1a, 0x59, 0xa3];

/** Names the `Custom(3)` this recorded transaction returned. */
const idlNaming = (errorName: string) => ({
  address: PROGRAM,
  metadata: { name: 'demo', spec: '0.1.0' },
  instructions: [{ name: 'settle', discriminator: OBSERVED, accounts: [], args: [] }],
  errors: [{ code: 3, name: errorName, msg: 'Described by the uploader.' }],
});

const SOURCE = {
  'src/lib.rs':
    '#[error_code(offset = 3)]\npub enum DemoError {\n    VaultDrained,\n}\n\n' +
    'pub fn settle(ctx: Context<Settle>) -> Result<()> {\n' +
    '    require!(ctx.accounts.vault.balance > 0, DemoError::VaultDrained);\n    Ok(())\n}\n',
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function keyedApp(overrides: Partial<AppConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'solvbana-tenants-'));
  directories.push(directory);
  clearResolutionCache();
  const app = buildApp(
    {
      ...TEST_CONFIG,
      SOLVBANA_API_KEYS: KEYS,
      SOLVBANA_ALLOW_UNAUTHENTICATED: false,
      SOLVBANA_ARTIFACT_DIR: directory,
      ...overrides,
    },
    {
      source: {
        fetchTransaction: () =>
          Promise.resolve({
            kind: 'found' as const,
            raw: reviveRawTransaction(readJson('transactions', `${SIGNATURE}.json`)),
            endpoint: 'primary' as const,
          }),
      },
      accounts: corpusAccounts([PROGRAM]),
    },
  );
  return { app, directory };
}

type App = Awaited<ReturnType<typeof keyedApp>>['app'];

const diagnoseAs = async (app: App, key: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/diagnose',
      headers: bearer(key),
      payload: { signature: SIGNATURE },
    })
  ).json<{
    finding: { error: { name: string | null; naming: string } } | null;
    confidence: string;
  }>();

describe('authentication', () => {
  it('rejects a missing header, a wrong scheme and an unknown key', async () => {
    const { app } = await keyedApp();
    const bad = [{}, { authorization: `Basic ${KEY_A}` }, bearer('not-a-key'), bearer('')];

    for (const headers of bad) {
      for (const [method, url] of [
        ['POST', '/diagnose'],
        ['POST', '/artifacts'],
        ['GET', '/artifacts'],
      ] as const) {
        const response = await app.inject({ method, url, headers, payload: {} });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
      }
    }
  });

  it('leaves /health open', async () => {
    const { app } = await keyedApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('accepts a configured key', async () => {
    const { app } = await keyedApp();
    const response = await app.inject({ method: 'GET', url: '/artifacts', headers: bearer(KEY_A) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ programs: [] });
  });
});

describe('tenant isolation', () => {
  const upload = (app: App, key: string, payload: object) =>
    app.inject({ method: 'POST', url: '/artifacts', headers: bearer(key), payload });

  it('lists only the caller’s artifacts', async () => {
    const { app } = await keyedApp();
    await upload(app, KEY_A, { idl: idlNaming('VaultDrained'), source: SOURCE });

    const own = await app.inject({ method: 'GET', url: '/artifacts', headers: bearer(KEY_A) });
    expect(own.json()).toEqual({ programs: [{ programId: PROGRAM, idl: true, sourceFiles: 1 }] });
    const other = await app.inject({ method: 'GET', url: '/artifacts', headers: bearer(KEY_B) });
    expect(other.json()).toEqual({ programs: [] });
  });

  it('files each tenant under its own directory', async () => {
    const { app, directory } = await keyedApp();
    await upload(app, KEY_A, { idl: idlNaming('VaultDrained') });
    await upload(app, KEY_B, { idl: idlNaming('Other') });

    expect((await readdir(join(directory, 'tenants'))).sort()).toEqual(['alpha', 'bravo']);
    expect(await readdir(join(directory, 'tenants', 'alpha', 'idl'))).toEqual([`${PROGRAM}.json`]);
    expect(await readdir(join(directory, 'tenants', 'bravo', 'idl'))).toEqual([`${PROGRAM}.json`]);
    expect(await readdir(directory)).toEqual(['tenants']);
  });

  it('diagnoses with only the caller’s IDL, and another upload does not change it', async () => {
    const { app } = await keyedApp();
    expect((await diagnoseAs(app, KEY_B)).finding?.error.naming).not.toBe('supplied-idl');

    await upload(app, KEY_A, { idl: idlNaming('VaultDrained') });

    const a = await diagnoseAs(app, KEY_A);
    expect(a.finding?.error).toMatchObject({ name: 'VaultDrained', naming: 'supplied-idl' });
    // The cache is warm for A; B must still not be served A's resolution.
    const b = await diagnoseAs(app, KEY_B);
    expect(b.finding?.error.naming).not.toBe('supplied-idl');
    expect(b.finding?.error.name).not.toBe('VaultDrained');

    await upload(app, KEY_B, { idl: idlNaming('SomethingElse') });
    expect((await diagnoseAs(app, KEY_B)).finding?.error.name).toBe('SomethingElse');
    expect((await diagnoseAs(app, KEY_A)).finding?.error.name).toBe('VaultDrained');
  });
});

describe('rate limiting', () => {
  it('limits one tenant without limiting another, and /health not at all', async () => {
    const { app } = await keyedApp({ SOLVBANA_RATE_LIMIT_PER_MINUTE: 2 });
    const get = (key: string) =>
      app.inject({ method: 'GET', url: '/artifacts', headers: bearer(key) });

    expect((await get(KEY_A)).statusCode).toBe(200);
    expect((await get(KEY_A)).statusCode).toBe(200);
    const limited = await get(KEY_A);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('rate_limited');

    expect((await get(KEY_B)).statusCode).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
  });
});

describe('API key configuration', () => {
  const base = { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' };
  const errorsOf = (env: Record<string, string>) => {
    const result = loadConfig({ ...base, ...env });
    return result.ok ? [] : result.errors.join('\n');
  };

  it('accepts well-formed pairs', () => {
    expect(loadConfig({ ...base, SOLVBANA_API_KEYS: KEYS }).ok).toBe(true);
  });

  it('rejects malformed entries, all at once', () => {
    const errors = errorsOf({
      SOLVBANA_API_KEYS: `Bad Tenant:${sha('x')},ok:short,nocolon,fine:${sha('y').toUpperCase()}`,
    });
    expect(errors).toContain('entry 1');
    expect(errors).toContain('entry 2');
    expect(errors).toContain('entry 3');
    expect(errors).toContain('entry 4');
  });

  it('rejects a duplicate tenant', () => {
    expect(errorsOf({ SOLVBANA_API_KEYS: `a:${sha('x')},a:${sha('y')}` })).toContain('duplicate');
  });

  it('refuses to start open whatever NODE_ENV says', () => {
    const envs: Record<string, string>[] = [
      {},
      { NODE_ENV: 'production' },
      { NODE_ENV: 'test' },
      { NODE_ENV: 'development' },
    ];
    for (const env of envs) {
      const errors = errorsOf(env);
      expect(errors).toContain('SOLVBANA_API_KEYS');
      // Both ways out are named.
      expect(errors).toContain('SOLVBANA_ALLOW_UNAUTHENTICATED=true');
    }
    expect(errorsOf({ SOLVBANA_API_KEYS: '' })).toContain('SOLVBANA_ALLOW_UNAUTHENTICATED=true');
    expect(loadConfig({ ...base, NODE_ENV: 'production', SOLVBANA_API_KEYS: KEYS }).ok).toBe(true);
  });

  it('allows running open only by explicit flag, and not alongside keys', () => {
    expect(loadConfig({ ...base, SOLVBANA_ALLOW_UNAUTHENTICATED: 'true' })).toMatchObject({
      ok: true,
      config: { SOLVBANA_ALLOW_UNAUTHENTICATED: true },
    });
    expect(errorsOf({ SOLVBANA_API_KEYS: KEYS, SOLVBANA_ALLOW_UNAUTHENTICATED: 'true' })).toContain(
      'ambiguous',
    );
  });

  it('buildApp enforces the same rule as loadConfig', () => {
    const open = { ...TEST_CONFIG, NODE_ENV: 'development' as const };
    expect(() => buildApp({ ...open, SOLVBANA_ALLOW_UNAUTHENTICATED: false }, {})).toThrow(
      /SOLVBANA_ALLOW_UNAUTHENTICATED=true/,
    );
    expect(() => buildApp({ ...open, SOLVBANA_API_KEYS: KEYS }, {})).toThrow(/ambiguous/);
  });

  it('opens only for the boolean true, not a string', () => {
    const config = {
      ...TEST_CONFIG,
      SOLVBANA_ALLOW_UNAUTHENTICATED: 'false',
    } as unknown as AppConfig;
    expect(() => buildApp(config, {})).toThrow(/SOLVBANA_ALLOW_UNAUTHENTICATED=true/);
  });

  it('runs as the single tenant `local` with the flag and no keys', async () => {
    const app = buildApp(TEST_CONFIG, {});
    const response = await app.inject({ method: 'GET', url: '/artifacts' });
    // Reaches the route as `local` rather than 401; no store is configured.
    expect(response.statusCode).toBe(503);
  });

  it('defaults SOLVBANA_TRUST_PROXY to off and parses it as a boolean', () => {
    expect(loadConfig({ ...base, SOLVBANA_ALLOW_UNAUTHENTICATED: 'true' })).toMatchObject({
      config: { SOLVBANA_TRUST_PROXY: false },
    });
    expect(
      loadConfig({
        ...base,
        SOLVBANA_ALLOW_UNAUTHENTICATED: 'true',
        SOLVBANA_TRUST_PROXY: 'true',
      }),
    ).toMatchObject({ config: { SOLVBANA_TRUST_PROXY: true } });
  });

  it('only honours X-Forwarded-For when SOLVBANA_TRUST_PROXY is set', async () => {
    const limited = {
      ...TEST_CONFIG,
      SOLVBANA_API_KEYS: KEYS,
      SOLVBANA_ALLOW_UNAUTHENTICATED: false,
      SOLVBANA_RATE_LIMIT_PER_MINUTE: 1,
    };
    const hit = (app: ReturnType<typeof buildApp>, ip: string) =>
      app.inject({
        method: 'GET',
        url: '/artifacts',
        headers: { 'x-forwarded-for': ip },
      });
    const untrusting = buildApp(limited, {});
    expect((await hit(untrusting, '1.1.1.1')).statusCode).toBe(401);
    expect((await hit(untrusting, '2.2.2.2')).statusCode).toBe(429);

    const trusting = buildApp({ ...limited, SOLVBANA_TRUST_PROXY: true }, {});
    expect((await hit(trusting, '1.1.1.1')).statusCode).toBe(401);
    expect((await hit(trusting, '2.2.2.2')).statusCode).toBe(401);
  });
});
