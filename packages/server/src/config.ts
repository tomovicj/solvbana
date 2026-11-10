import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  HOST: Type.String({ minLength: 1, default: '127.0.0.1' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  /** Primary RPC endpoint. Public nodes retain roughly two days of history. */
  SOLANA_RPC_URL: Type.String({ minLength: 1 }),
  /** Optional archive endpoint for signatures older than the primary node's retention. */
  SOLANA_ARCHIVE_RPC_URL: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Verified-build registry, used to map a deployed binary's hash to a repository
   * and commit. Set to an empty string to disable the lookup — the diagnosis then
   * says so rather than quietly omitting source provenance.
   */
  SOLVBANA_VERIFY_REGISTRY_URL: Type.String({ default: 'https://verify.osec.io' }),
  /**
   * Directory backing the artifact store, holding IDLs and program binaries
   * developers have uploaded.
   *
   * Roughly 94% of the programs that fail on mainnet publish neither an on-chain
   * IDL nor a verified build, so for those this is the only route to an error
   * name. Unset disables the store entirely, and a diagnosis says so rather than
   * quietly omitting the possibility.
   */
  SOLVBANA_ARTIFACT_DIR: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Largest request body accepted, in bytes.
   *
   * Fastify defaults to 1MB, which rejects most real program uploads: corpus
   * binaries reach 1.5MB of ELF, and base64 adds a third again. The default here
   * is sized for that with room to spare rather than left to be discovered as a
   * 413 on a developer's first upload.
   */
  SOLVBANA_MAX_BODY_BYTES: Type.Integer({ minimum: 1024, default: 32 * 1024 * 1024 }),
  /**
   * API keys, as comma-separated `tenant:sha256hex` pairs.
   *
   * `tenant` matches `^[a-z0-9][a-z0-9_-]{0,63}$` and the hex is the SHA-256 of
   * the secret key (64 lowercase hex characters), so the server never holds a
   * plaintext key. A tenant owns its uploaded artifacts and no one else sees
   * them. Unset or empty is a configuration error unless
   * `SOLVBANA_ALLOW_UNAUTHENTICATED` is set, whatever `NODE_ENV` says: a
   * deployment that forgot a variable must not come up open.
   */
  SOLVBANA_API_KEYS: Type.Optional(Type.String()),
  /**
   * Run without authentication, as the single tenant `local`. Only valid with no
   * keys configured; setting both is ambiguous and refused.
   */
  SOLVBANA_ALLOW_UNAUTHENTICATED: Type.Boolean({ default: false }),
  /**
   * Trust `X-Forwarded-For` when deriving the client IP.
   *
   * The per-IP rate limit applies to callers who have not authenticated. Behind
   * a reverse proxy without this, they all share the proxy's address and so one
   * bucket. Enable it only when a proxy in front overwrites `X-Forwarded-For`;
   * otherwise any client can set the header and pick its own bucket.
   */
  SOLVBANA_TRUST_PROXY: Type.Boolean({ default: false }),
  /**
   * Requests allowed per tenant per minute (per client IP before authentication
   * succeeds). Each `/diagnose` spends paid RPC calls, so this is a cost control
   * as much as an abuse control. `/health` is exempt.
   */
  SOLVBANA_RATE_LIMIT_PER_MINUTE: Type.Integer({ minimum: 1, default: 60 }),
});

export type AppConfig = Static<typeof ConfigSchema>;

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; errors: string[] };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Shared with the tenant stores, which re-check it before joining a name to a path. */
export const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface ApiKeyEntry {
  tenant: string;
  /** SHA-256 of the secret key, as 32 bytes. */
  hash: Buffer;
}

export type ApiKeysResult = { ok: true; keys: ApiKeyEntry[] } | { ok: false; errors: string[] };

/**
 * Parse `SOLVBANA_API_KEYS`. Errors never echo the hash text: it is not secret
 * in itself, but a malformed entry may be a pasted plaintext key.
 */
export function parseApiKeys(raw: string | undefined): ApiKeysResult {
  const keys: ApiKeyEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  entries.forEach((entry, i) => {
    const label = `SOLVBANA_API_KEYS entry ${String(i + 1)}`;
    const parts = entry.split(':');
    const [tenant, hash] = parts;
    if (parts.length !== 2 || tenant === undefined || hash === undefined) {
      errors.push(`${label}: expected tenant:sha256hex`);
      return;
    }
    if (!TENANT_PATTERN.test(tenant)) {
      errors.push(`${label}: tenant must match ${TENANT_PATTERN.source}`);
      return;
    }
    if (!KEY_HASH_PATTERN.test(hash)) {
      errors.push(`${label} (${tenant}): key hash must be 64 lowercase hex characters (SHA-256)`);
      return;
    }
    if (seen.has(tenant)) {
      errors.push(`${label}: duplicate tenant ${tenant}`);
      return;
    }
    seen.add(tenant);
    keys.push({ tenant, hash: Buffer.from(hash, 'hex') });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, keys };
}

/**
 * Running without keys is always an explicit choice, never a default.
 * Returns the configuration error, or null when the combination is valid.
 */
export function authenticationProblem(
  keyCount: number,
  allowUnauthenticated: boolean,
): string | null {
  // Strictly `true`: a hand-built config may carry the string 'false'.
  const allowed = allowUnauthenticated === true;
  if (keyCount === 0 && !allowed) {
    return (
      'SOLVBANA_API_KEYS: no API keys configured, and the server will not start open by default. ' +
      'Either set SOLVBANA_API_KEYS to comma-separated tenant:sha256hex pairs, or set ' +
      'SOLVBANA_ALLOW_UNAUTHENTICATED=true to run without authentication as the single tenant "local".'
    );
  }
  if (keyCount > 0 && allowed) {
    return (
      'SOLVBANA_ALLOW_UNAUTHENTICATED: ambiguous with SOLVBANA_API_KEYS; ' +
      'set one or the other, not both.'
    );
  }
  return null;
}

/**
 * Read and validate configuration.
 *
 * Reports every problem at once rather than failing on the first one — being
 * told about `SOLANA_RPC_URL` only after fixing `PORT` wastes a restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  // process.env carries `undefined` values for unset keys, which would defeat
  // schema defaults; drop them so Value.Default can fill the gaps.
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) present[key] = value;
  }

  const withDefaults = Value.Default(ConfigSchema, present);
  // PORT arrives as a string from the environment; Convert coerces to Integer.
  const converted = Value.Convert(ConfigSchema, withDefaults);

  // One line per bad key: a missing value otherwise reports both "required" and
  // "expected string", which reads like two separate problems.
  const firstErrorPerKey = new Map<string, string>();
  for (const error of Value.Errors(ConfigSchema, converted)) {
    const key = error.path.replace(/^\//, '') || '(root)';
    if (!firstErrorPerKey.has(key)) firstErrorPerKey.set(key, error.message);
  }
  const errors = [...firstErrorPerKey].map(([key, message]) => `${key}: ${message}`);

  if (errors.length > 0) return { ok: false, errors };

  const config = Value.Clean(ConfigSchema, converted) as AppConfig;

  const urlErrors: string[] = [];
  if (!isHttpUrl(config.SOLANA_RPC_URL)) {
    urlErrors.push('SOLANA_RPC_URL: must be an http(s) URL');
  }
  if (config.SOLANA_ARCHIVE_RPC_URL !== undefined && !isHttpUrl(config.SOLANA_ARCHIVE_RPC_URL)) {
    urlErrors.push('SOLANA_ARCHIVE_RPC_URL: must be an http(s) URL');
  }
  // Empty is the documented way to turn the registry off, so it is not a bad URL.
  if (
    config.SOLVBANA_VERIFY_REGISTRY_URL !== '' &&
    !isHttpUrl(config.SOLVBANA_VERIFY_REGISTRY_URL)
  ) {
    urlErrors.push('SOLVBANA_VERIFY_REGISTRY_URL: must be an http(s) URL, or empty to disable');
  }
  const keyErrors: string[] = [];
  const keys = parseApiKeys(config.SOLVBANA_API_KEYS);
  if (!keys.ok) keyErrors.push(...keys.errors);
  else {
    const problem = authenticationProblem(keys.keys.length, config.SOLVBANA_ALLOW_UNAUTHENTICATED);
    if (problem !== null) keyErrors.push(problem);
  }
  const allErrors = [...urlErrors, ...keyErrors];
  if (allErrors.length > 0) return { ok: false, errors: allErrors };

  return { ok: true, config };
}
