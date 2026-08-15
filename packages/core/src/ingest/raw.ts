import type { RawTransaction } from './types.ts';

/**
 * Fields the RPC sends as JSON numbers but the typed shape carries as `bigint`.
 *
 * The list is explicit rather than inferred so it doubles as documentation of
 * exactly where precision matters. Slots and lamport amounts exceed `Number`'s
 * safe integer range in principle, and silently rounding a slot would break the
 * slot-accurate binary resolution that Phase 2 depends on.
 */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  return null;
}

function reviveArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return (value as unknown[]).map((entry) => toBigInt(entry) ?? entry);
}

/**
 * Upcast every integer inside a value, however deeply nested.
 *
 * Used for `meta.err` alone, because that is exactly where the RPC client
 * upcasts indiscriminately — the failing instruction index and a `Custom` error
 * code both arrive as `bigint`, while structural indices elsewhere in the
 * response stay `number`. Reproducing that asymmetry is the point: a fixture
 * that revived `meta.err` as plain numbers would exercise a shape production
 * never sees, and the parser bug would live on behind a green suite.
 */
function reviveDeep(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return (value as unknown[]).map(reviveDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        reviveDeep(entry),
      ]),
    );
  }
  return value;
}

/**
 * Turn a `getTransaction` result parsed by `JSON.parse` into the typed raw shape.
 *
 * Fixtures are stored as the wire JSON verbatim — readable and diffable, which
 * matters for a corpus that serves as the project's spec — so the `bigint`
 * fields the RPC client would otherwise produce have to be restored on load.
 * Reviving here rather than in test helpers keeps the scripts that record
 * fixtures and the suite that reads them on one definition.
 */
export function reviveRawTransaction(value: unknown): RawTransaction {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Expected a getTransaction result object.');
  }

  const raw = { ...(value as Record<string, unknown>) };
  raw['slot'] = toBigInt(raw['slot']) ?? 0n;
  raw['blockTime'] = toBigInt(raw['blockTime']);

  const meta = raw['meta'];
  if (typeof meta === 'object' && meta !== null) {
    const revivedMeta = { ...(meta as Record<string, unknown>) };
    revivedMeta['err'] = reviveDeep(revivedMeta['err']);
    revivedMeta['fee'] = toBigInt(revivedMeta['fee']) ?? 0n;
    revivedMeta['preBalances'] = reviveArray(revivedMeta['preBalances']);
    revivedMeta['postBalances'] = reviveArray(revivedMeta['postBalances']);

    for (const key of ['computeUnitsConsumed', 'costUnits'] as const) {
      if (revivedMeta[key] !== undefined && revivedMeta[key] !== null) {
        revivedMeta[key] = toBigInt(revivedMeta[key]);
      }
    }

    if (Array.isArray(revivedMeta['rewards'])) {
      revivedMeta['rewards'] = (revivedMeta['rewards'] as Record<string, unknown>[]).map(
        (reward) => ({
          ...reward,
          lamports: toBigInt(reward['lamports']) ?? 0n,
          postBalance: toBigInt(reward['postBalance']) ?? 0n,
        }),
      );
    }

    raw['meta'] = revivedMeta;
  }

  return raw as unknown as RawTransaction;
}
