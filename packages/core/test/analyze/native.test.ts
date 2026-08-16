import { describe, expect, it } from 'vitest';
import { explainRuntimeVariant, isNativeProgram, nativeError } from '@solvbana/core';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';

describe('nativeError', () => {
  it('resolves a code against the program that defines it', () => {
    expect(nativeError(TOKEN, 3)).toEqual({
      name: 'MintMismatch',
      message: 'Account not associated with this mint.',
    });
    expect(nativeError(SYSTEM, 1)).toMatchObject({ name: 'ResultWithNegativeLamports' });
  });

  it('gives Token-2022 the same table for the codes it inherits', () => {
    expect(nativeError(TOKEN_2022, 4)).toEqual(nativeError(TOKEN, 4));
  });

  it('resolves nothing for a program with no published table', () => {
    // The same code number means something different in every program, which is
    // the whole reason the lookup is keyed on identity rather than on the number.
    expect(nativeError('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 3)).toBeNull();
    expect(nativeError(null, 3)).toBeNull();
  });

  it('resolves nothing for a code the table does not define', () => {
    expect(nativeError(TOKEN, 9999)).toBeNull();
  });
});

describe('isNativeProgram', () => {
  it('recognizes the pinned addresses and nothing else', () => {
    expect(isNativeProgram(TOKEN)).toBe(true);
    expect(isNativeProgram('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(true);
    expect(isNativeProgram('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')).toBe(false);
    expect(isNativeProgram(null)).toBe(false);
  });
});

describe('explainRuntimeVariant', () => {
  it('explains every variant the fixture corpus actually produces', () => {
    for (const variant of [
      'InvalidAccountData',
      'InvalidInstructionData',
      'IllegalOwner',
      'IncorrectProgramId',
      'ProgramFailedToComplete',
      'ComputationalBudgetExceeded',
      'InsufficientFunds',
    ]) {
      expect(explainRuntimeVariant(variant), variant).toMatch(/\w{40,}|\w+ \w+/);
    }
  });

  it('returns null for a variant it has nothing to say about', () => {
    expect(explainRuntimeVariant('SomeFutureVariant')).toBeNull();
  });
});
