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
  if (urlErrors.length > 0) return { ok: false, errors: urlErrors };

  return { ok: true, config };
}
