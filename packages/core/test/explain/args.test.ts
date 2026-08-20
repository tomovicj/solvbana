import { describe, expect, it } from 'vitest';
import { decodeArgs, describeType, type IdlArg } from '@solvbana/core';

/** Eight discriminator bytes, then the argument data. */
function data(...bytes: number[]): Uint8Array {
  return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, ...bytes]);
}

describe('describeType', () => {
  it('renders both IDL spellings as Rust', () => {
    expect(describeType('u64')).toBe('u64');
    expect(describeType({ vec: 'pubkey' })).toBe('Vec<pubkey>');
    expect(describeType({ option: { vec: 'u8' } })).toBe('Option<Vec<u8>>');
    expect(describeType({ array: ['u8', 32] })).toBe('[u8; 32]');
    expect(describeType({ defined: { name: 'SwapParams' } })).toBe('SwapParams');
  });
});

describe('decodeArgs', () => {
  it('skips the discriminator and reads little-endian integers', () => {
    const args: IdlArg[] = [{ name: 'amount', type: 'u64' }];
    const { decoded } = decodeArgs(data(1, 2, 0, 0, 0, 0, 0, 0), args);

    expect(decoded).toEqual([{ name: 'amount', type: 'u64', value: '513' }]);
  });

  it('reads signed widths as two’s complement', () => {
    const { decoded } = decodeArgs(data(0xff, 0xff), [{ name: 'tick', type: 'i16' }]);

    expect(decoded[0]?.value).toBe('-1');
  });

  it('seeds an integer with the same little-endian bytes Anchor uses', () => {
    // Anchor writes `index.to_le_bytes()` in the seed expression, which is
    // exactly the encoding already on the wire — so the seed is not the borsh
    // encoding, it is the same span read twice.
    const { seeds } = decodeArgs(data(5, 0), [{ name: 'index', type: 'u16' }]);

    expect([...(seeds.get('index') ?? [])]).toEqual([5, 0]);
  });

  it('seeds a string without its length prefix', () => {
    // Borsh writes a u32 length before the bytes; `as_bytes()` in a seed
    // expression does not. Carrying the prefix into the seed derives a
    // different address.
    const bytes = data(2, 0, 0, 0, 0x68, 0x69);
    const { decoded, seeds } = decodeArgs(bytes, [{ name: 'label', type: 'string' }]);

    expect(decoded[0]?.value).toBe('hi');
    expect([...(seeds.get('label') ?? [])]).toEqual([0x68, 0x69]);
  });

  it('stops at the first unsupported type rather than reading past it', () => {
    // A composite type has an unknown width here, so every argument after it
    // would be decoded from a shifted offset and still look like a number.
    const args: IdlArg[] = [
      { name: 'first', type: 'u8' },
      { name: 'params', type: { defined: { name: 'SwapParams' } } },
      { name: 'third', type: 'u8' },
    ];
    const { decoded } = decodeArgs(data(7, 9, 9, 9), args);

    expect(decoded.map((arg) => arg.value)).toEqual(['7', null, null]);
  });

  it('reports a short read rather than throwing', () => {
    // An IDL that has drifted from the binary describes arguments the data does
    // not contain. That is a disagreement to report, not a crash.
    const { decoded } = decodeArgs(data(1), [{ name: 'amount', type: 'u64' }]);

    expect(decoded[0]?.value).toBeNull();
  });
});
