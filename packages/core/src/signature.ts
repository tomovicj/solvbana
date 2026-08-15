const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** An Ed25519 signature is 64 bytes, whatever its base58 encoding happens to be. */
const SIGNATURE_BYTES = 64;

export type SignatureParseFailure =
  | { code: 'empty'; message: string }
  | { code: 'bad-alphabet'; message: string }
  | { code: 'bad-length'; message: string };

export type SignatureParseResult =
  { ok: true; signature: string } | ({ ok: false } & SignatureParseFailure);

/**
 * Decode base58 to bytes, or `null` if the input contains characters outside the
 * alphabet. Leading `1`s encode leading zero bytes and are counted separately.
 */
export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) return new Uint8Array(0);

  let value = 0n;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }

  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value % 256n));
    value /= 256n;
  }

  let leadingZeros = 0;
  for (const char of input) {
    if (char !== '1') break;
    leadingZeros += 1;
  }

  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...body]);
}

/**
 * Validate a transaction signature without touching the network.
 *
 * Returns a result rather than throwing so callers can turn a malformed input
 * into a structured 400 instead of an exception. Character-length checks alone
 * are ambiguous — base58 encodes 64 bytes in either 87 or 88 characters — so
 * this decodes and checks the byte length.
 */
export function parseSignature(input: string): SignatureParseResult {
  const candidate = input.trim();

  if (candidate.length === 0) {
    return { ok: false, code: 'empty', message: 'Signature is empty.' };
  }

  const decoded = decodeBase58(candidate);
  if (decoded === null) {
    return {
      ok: false,
      code: 'bad-alphabet',
      message: 'Signature contains characters outside the base58 alphabet.',
    };
  }

  if (decoded.length !== SIGNATURE_BYTES) {
    return {
      ok: false,
      code: 'bad-length',
      message: `Signature decodes to ${String(decoded.length)} bytes; expected ${String(SIGNATURE_BYTES)}.`,
    };
  }

  return { ok: true, signature: candidate };
}
