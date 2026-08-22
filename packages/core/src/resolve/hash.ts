import { createHash } from 'node:crypto';

/**
 * The hash that identifies a deployed program.
 *
 * `sha256` over an ELF image with trailing zero bytes removed. The trim is not
 * cosmetic and not optional: a ProgramData account is allocated with room for a
 * larger future upgrade, so Whirlpool's is 10,485,760 bytes of which only
 * 1,537,769 are program. Hashing the untrimmed buffer produces a number that
 * matches nothing.
 *
 * It lives here, apart from both the callers that need it, because they hash
 * different things and the answers have to be comparable. A ProgramData account
 * carries a 45-byte loader header before the ELF; a `.so` built locally is the
 * ELF alone. Trimming one side and not the other would make two copies of the
 * same program hash differently, so both go through this.
 *
 * Confirmed against mainnet during Phase 2: this reproduces the verified-build
 * registry's reported `on_chain_hash` for Whirlpool byte for byte.
 */
export function elfHash(elf: Uint8Array): string {
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end -= 1;

  return createHash('sha256').update(elf.subarray(0, end)).digest('hex');
}
