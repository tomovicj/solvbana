import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyEntry } from './config.ts';

/** The tenant used only when `SOLVBANA_ALLOW_UNAUTHENTICATED=true` and no keys are configured. */
export const ANONYMOUS_TENANT = 'local';

const BEARER = /^Bearer ([^\s]+)$/;

/**
 * Who the caller is, from an `Authorization: Bearer <key>` header.
 *
 * The presented key is hashed and compared against every configured hash with
 * `timingSafeEqual`, with no early exit, so neither which entry matched nor how
 * many bytes agreed is visible in the response time. Returns `null` for a
 * missing, malformed or unknown key.
 */
export function authenticate(
  header: string | undefined,
  keys: readonly ApiKeyEntry[],
): string | null {
  if (header === undefined) return null;
  const match = BEARER.exec(header);
  if (match?.[1] === undefined) return null;

  const presented = createHash('sha256').update(match[1]).digest();
  let tenant: string | null = null;
  for (const entry of keys) {
    if (timingSafeEqual(presented, entry.hash) && tenant === null) tenant = entry.tenant;
  }
  return tenant;
}
