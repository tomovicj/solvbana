import { describe, expect, it } from 'vitest';
import { decodeBase58, parseSignature } from '@solvbana/core';

/** A real mainnet signature, used only as a well-formed 64-byte input. */
const VALID =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

describe('decodeBase58', () => {
  it('decodes leading ones as leading zero bytes', () => {
    expect(decodeBase58('1')).toEqual(Uint8Array.from([0]));
    expect(decodeBase58('11')).toEqual(Uint8Array.from([0, 0]));
  });

  it('decodes a known value', () => {
    // 'z' is index 57 in the base58 alphabet.
    expect(decodeBase58('z')).toEqual(Uint8Array.from([57]));
  });

  it('returns null on characters outside the alphabet', () => {
    // '0', 'O', 'I' and 'l' are excluded from base58 precisely because they are ambiguous.
    expect(decodeBase58('0')).toBeNull();
    expect(decodeBase58('O')).toBeNull();
    expect(decodeBase58('not base58!')).toBeNull();
  });
});

describe('parseSignature', () => {
  it('accepts a well-formed signature and trims surrounding whitespace', () => {
    const result = parseSignature(`  ${VALID}\n`);
    expect(result).toEqual({ ok: true, signature: VALID });
  });

  it('rejects an empty input', () => {
    expect(parseSignature('   ')).toMatchObject({ ok: false, code: 'empty' });
  });

  it('rejects characters outside the base58 alphabet', () => {
    expect(parseSignature('not-base58!!')).toMatchObject({ ok: false, code: 'bad-alphabet' });
  });

  it('rejects base58 that does not decode to 64 bytes', () => {
    // Well-formed base58, wrong length: this is a pubkey (32 bytes), not a signature.
    const pubkey = 'So11111111111111111111111111111111111111112';
    expect(parseSignature(pubkey)).toMatchObject({ ok: false, code: 'bad-length' });
  });
});
