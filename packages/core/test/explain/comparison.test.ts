import { describe, expect, it } from 'vitest';
import {
  passedSide,
  readComparison,
  requiredSide,
  type AccountRow,
  type DecodedArg,
} from '@solvbana/core';

const VAULT = '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk';
const DERIVED = 'GMc58fp264TR3fB7JnS9jVYy4fqJQx3N9Hx4UWw9zspD';

function row(name: string, address: string | null): AccountRow {
  return {
    position: 0,
    index: 0,
    address,
    name,
    signer: false,
    writable: false,
    origin: 'static',
    lamports: null,
    existedBefore: null,
    token: null,
  };
}

describe('readComparison', () => {
  it('proves the orientation when one operand is the blamed account address', () => {
    // The corpus shape: Anchor blames an account, prints the address the
    // instruction passed and the address it derived, and only the first of those
    // appears in the transaction's account list.
    const read = readComparison({ left: VAULT, right: DERIVED }, 'vault', [row('vault', VAULT)]);

    expect(read.passed).toBe('left');
    expect(passedSide(read)).toBe(VAULT);
    expect(requiredSide(read)).toBe(DERIVED);
    expect(read.account).toBe(VAULT);
  });

  it('proves it just as readily in the other direction', () => {
    // Nothing may depend on Anchor's ordering; the proof is the address match,
    // so the mirrored pair must resolve the other way round.
    const read = readComparison({ left: DERIVED, right: VAULT }, 'vault', [row('vault', VAULT)]);

    expect(read.passed).toBe('right');
    expect(passedSide(read)).toBe(VAULT);
    expect(requiredSide(read)).toBe(DERIVED);
  });

  it('claims nothing when the blamed account has no row', () => {
    // The `ConstraintOwner` fixture: the IDL never names the blamed field, so
    // there is no address to match and Anchor's ordering is all that is left —
    // which is exactly what must not be relied on.
    const read = readComparison({ left: VAULT, right: DERIVED }, 'encoded_vaa', []);

    expect(read.passed).toBeNull();
    expect(read.account).toBeNull();
    expect(passedSide(read)).toBeNull();
    expect(requiredSide(read)).toBeNull();
  });

  it('claims nothing when the account address matches neither operand', () => {
    const read = readComparison({ left: VAULT, right: DERIVED }, 'vault', [
      row('vault', '11111111111111111111111111111111'),
    ]);

    expect(read.passed).toBeNull();
    expect(read.account).toBe('11111111111111111111111111111111');
  });

  it('claims nothing when both operands match, since equal sides prove no roles', () => {
    const read = readComparison({ left: VAULT, right: VAULT }, 'vault', [row('vault', VAULT)]);
    expect(read.passed).toBeNull();
  });

  it('claims nothing when the failure blamed no account at all', () => {
    const read = readComparison({ left: VAULT, right: DERIVED }, null, [row('vault', VAULT)]);
    expect(read.passed).toBeNull();
    expect(read.account).toBeNull();
  });

  it('reports the gap between two integers', () => {
    const read = readComparison({ left: '412250202354', right: '428963556055' }, null, []);

    expect(read.numeric?.difference).toBe(16713353701n);
    expect(read.numeric?.equal).toBe(false);
    expect(read.numeric?.relative).toBeCloseTo(0.038962, 5);
  });

  it('flags an equal pair rather than reporting a zero gap', () => {
    // `require_gt!(0, 0)` is the whole diagnosis for two corpus fixtures: it
    // failed on equality, not on magnitude, and the fixes differ.
    const read = readComparison({ left: '0', right: '0' }, null, []);

    expect(read.numeric?.equal).toBe(true);
    expect(read.numeric?.difference).toBe(0n);
    // Undefined against a zero denominator rather than reported as 0%, which
    // would read as "no difference" for a pair that may well differ.
    expect(read.numeric?.relative).toBeNull();
  });

  it('carries amounts that do not survive a double', () => {
    const read = readComparison(
      { left: '18446744073709551615', right: '18446744073709551614' },
      null,
      [],
    );
    expect(read.numeric?.difference).toBe(1n);
  });

  it('reads nothing numeric unless both operands are integers', () => {
    // Half a numeric comparison says nothing, the same rule `comparisonIn`
    // applies to half an operand pair.
    expect(readComparison({ left: '100', right: VAULT }, null, []).numeric).toBeNull();
    expect(readComparison({ left: VAULT, right: DERIVED }, null, []).numeric).toBeNull();
  });

  it('refuses operands that only look numeric', () => {
    // `BigInt('')` is 0n and `BigInt(' 7 ')` is 7n, either of which would turn
    // an operand that is not a number into a confident quantity.
    expect(readComparison({ left: '', right: '0' }, null, []).numeric).toBeNull();
    expect(readComparison({ left: ' 7', right: '8' }, null, []).numeric).toBeNull();
    expect(readComparison({ left: '1.5', right: '2' }, null, []).numeric).toBeNull();
    expect(readComparison({ left: '0x10', right: '2' }, null, []).numeric).toBeNull();
  });

  it('reads a negative pair by absolute difference', () => {
    const read = readComparison({ left: '-5', right: '5' }, null, []);
    expect(read.numeric?.difference).toBe(10n);
    expect(read.numeric?.relative).toBeCloseTo(2, 5);
  });
});

function arg(name: string, value: string | null): DecodedArg {
  return { name, type: 'u64', value };
}

describe('readComparison, oriented by the instruction arguments', () => {
  it('proves orientation when one argument carries one operand', () => {
    // A value the client encoded into the instruction data and that then shows
    // up as an operand is a value the client supplied. This is the only proof
    // available for a numeric comparison, which has no address to match.
    const read = readComparison(
      { left: '412250202354', right: '428963556055' },
      null,
      [],
      [arg('spendable_quote_in', '800000000'), arg('min_base_amount_out', '428963556055')],
    );

    expect(read.argument).toEqual({ name: 'min_base_amount_out', side: 'right' });
    expect(read.passed).toBe('right');
    expect(passedSide(read)).toBe('428963556055');
    expect(requiredSide(read)).toBe('412250202354');
  });

  it('names the argument but claims no side when the operands are equal', () => {
    // `require_gt!(0, 0)` against `minimum_amount_out = 0`. The zero provably
    // came from that argument; which zero it is remains undetermined, and
    // collapsing the two claims would assert the second from the first.
    const read = readComparison(
      { left: '0', right: '0' },
      null,
      [],
      [arg('amount_in', '1'), arg('minimum_amount_out', '0')],
    );

    expect(read.argument).toEqual({ name: 'minimum_amount_out', side: null });
    expect(read.passed).toBeNull();
    expect(requiredSide(read)).toBeNull();
  });

  it('claims nothing when two arguments carry the same value', () => {
    const read = readComparison(
      { left: '5', right: '9' },
      null,
      [],
      [arg('minimum', '5'), arg('floor', '5')],
    );

    expect(read.argument).toBeNull();
    expect(read.passed).toBeNull();
  });

  it('matches integers by value rather than by text', () => {
    // A formatting difference between how an argument renders and how the
    // program printed it must not silently break the match.
    const read = readComparison({ left: '7', right: '10' }, null, [], [arg('cap', '007')]);
    expect(read.argument).toEqual({ name: 'cap', side: 'left' });
  });

  it('ignores arguments whose type this tier could not decode', () => {
    const read = readComparison({ left: '1', right: '2' }, null, [], [arg('opaque', null)]);
    expect(read.argument).toBeNull();
  });

  it('keeps the address proof when the argument agrees with it', () => {
    const read = readComparison(
      { left: VAULT, right: DERIVED },
      'vault',
      [row('vault', VAULT)],
      [arg('target', VAULT)],
    );

    expect(read.passed).toBe('left');
    expect(read.argument).toEqual({ name: 'target', side: 'left' });
  });

  it('refuses when the two proofs disagree', () => {
    // They are independent reads of the same record, so a conflict means one is
    // wrong about this transaction and nothing licenses choosing which.
    const read = readComparison(
      { left: VAULT, right: DERIVED },
      'vault',
      [row('vault', VAULT)],
      [arg('target', DERIVED)],
    );

    expect(read.passed).toBeNull();
    expect(read.argument).toEqual({ name: 'target', side: 'right' });
  });
});
