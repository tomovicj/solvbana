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
  if (urlErrors.length > 0) return { ok: false, errors: urlErrors };

  return { ok: true, config };
}
