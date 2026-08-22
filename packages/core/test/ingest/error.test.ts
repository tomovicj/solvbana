import { describe, expect, it } from 'vitest';
import {
  describeTransactionError,
  failingInstructionIndex,
  parseInstructionError,
  parseTransactionError,
} from '@solvbana/core';

describe('parseTransactionError', () => {
  it('parses a custom program error', () => {
    expect(parseTransactionError({ InstructionError: [1, { Custom: 6001 }] })).toEqual({
      kind: 'instruction-error',
      index: 1,
      error: { kind: 'custom', code: 6001 },
    });
  });

  it('parses a named instruction error', () => {
    expect(parseTransactionError({ InstructionError: [0, 'MissingRequiredSignature'] })).toEqual({
      kind: 'instruction-error',
      index: 0,
      error: { kind: 'named', name: 'MissingRequiredSignature' },
    });
  });

  it('parses the bigint form the RPC client actually produces', () => {
    // @solana/kit upcasts the integers inside `meta.err` to bigint while leaving
    // structural indices elsewhere as number. A number-only check reports every
    // real error as unrecognized, which is how this reached a running server.
    expect(parseTransactionError({ InstructionError: [0n, { Custom: 2003n }] })).toEqual({
      kind: 'instruction-error',
      index: 0,
      error: { kind: 'custom', code: 2003 },
    });
    expect(parseTransactionError({ InsufficientFundsForRent: { account_index: 3n } })).toEqual({
      kind: 'insufficient-funds-for-rent',
      accountIndex: 3,
    });
    expect(parseTransactionError({ DuplicateInstruction: 2n })).toEqual({
      kind: 'duplicate-instruction',
      index: 2,
    });
  });

  it('renders an unrecognized payload containing bigints without throwing', () => {
    // JSON.stringify throws on bigint, and unparsed payloads are full of them.
    const raw = { SomeFutureVariant: { index: 7n } };
    expect(describeTransactionError(parseTransactionError(raw))).toContain('"7"');
  });

  it('parses a bare transaction-level variant', () => {
    expect(parseTransactionError('AlreadyProcessed')).toEqual({
      kind: 'simple',
      name: 'AlreadyProcessed',
    });
  });

  it('parses the payload-carrying transaction-level variants', () => {
    expect(parseTransactionError({ InsufficientFundsForRent: { account_index: 3 } })).toEqual({
      kind: 'insufficient-funds-for-rent',
      accountIndex: 3,
    });
    expect(parseTransactionError({ DuplicateInstruction: 2 })).toEqual({
      kind: 'duplicate-instruction',
      index: 2,
    });
  });

  it('retains the raw value for a variant it does not recognize', () => {
    // New runtime variants ship independently of this parser. Throwing here
    // would turn a diagnosable transaction into a crash, so the raw value has to
    // survive into the output.
    const raw = { SomeFutureRuntimeVariant: { detail: 42 } };
    expect(parseTransactionError(raw)).toEqual({ kind: 'unrecognized', raw });
  });

  it('does not throw on structurally invalid input', () => {
    expect(parseTransactionError(null)).toEqual({ kind: 'unrecognized', raw: null });
    expect(parseTransactionError([1, 2])).toMatchObject({ kind: 'unrecognized' });
    expect(parseTransactionError({ InstructionError: [1] })).toMatchObject({
      kind: 'unrecognized',
    });
  });
});

describe('parseInstructionError', () => {
  it('parses BorshIoError from its wire shape', () => {
    // The RPC emits `{"BorshIoError": "..."}` even though @solana/kit's declared
    // type has it as a bare string — which is why this parser reads from unknown.
    expect(parseInstructionError({ BorshIoError: 'Unknown' })).toEqual({
      kind: 'borsh-io-error',
      message: 'Unknown',
    });
  });
});

describe('failingInstructionIndex', () => {
  it('is null for a failure no single instruction owns', () => {
    expect(failingInstructionIndex({ kind: 'simple', name: 'AlreadyProcessed' })).toBeNull();
    expect(
      failingInstructionIndex({ kind: 'insufficient-funds-for-rent', accountIndex: 1 }),
    ).toBeNull();
  });

  it('is the instruction index for an instruction error', () => {
    expect(
      failingInstructionIndex({
        kind: 'instruction-error',
        index: 4,
        error: { kind: 'custom', code: 6001 },
      }),
    ).toBe(4);
  });
});

describe('describeTransactionError', () => {
  it('renders a custom code without pretending to name it', () => {
    expect(
      describeTransactionError({
        kind: 'instruction-error',
        index: 0,
        error: { kind: 'custom', code: 6001 },
      }),
    ).toBe('Custom(6001)');
  });
});
