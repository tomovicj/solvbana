import { describe, expect, it } from 'vitest';
import { flattenAccountKeys, type FlattenInput } from '@solvbana/core';

/**
 * Four static keys arranged as the runtime orders them: writable signers,
 * readonly signers, writable non-signers, readonly non-signers.
 */
const BASE: FlattenInput = {
  staticKeys: ['Signer1', 'Signer2ReadOnly', 'Writable', 'ReadOnly'],
  header: {
    numRequiredSignatures: 2,
    numReadonlySignedAccounts: 1,
    numReadonlyUnsignedAccounts: 1,
  },
  addressTableLookups: undefined,
  loadedAddresses: undefined,
};

describe('flattenAccountKeys', () => {
  it('derives signer and writable flags from the header', () => {
    const { keys } = flattenAccountKeys(BASE);

    expect(keys.map((key) => [key.address, key.signer, key.writable])).toEqual([
      ['Signer1', true, true],
      ['Signer2ReadOnly', true, false],
      ['Writable', false, true],
      ['ReadOnly', false, false],
    ]);
  });

  it('appends loaded addresses in the runtime order: writable, then readonly', () => {
    const { keys, unresolvedLookups } = flattenAccountKeys({
      ...BASE,
      addressTableLookups: [{}],
      loadedAddresses: { writable: ['LoadedW'], readonly: ['LoadedR'] },
    });

    expect(keys.slice(4).map((key) => [key.address, key.index, key.source])).toEqual([
      ['LoadedW', 4, 'lookup-writable'],
      ['LoadedR', 5, 'lookup-readonly'],
    ]);
    expect(unresolvedLookups).toBe(false);
  });

  it('never marks a looked-up address as a signer', () => {
    const { keys } = flattenAccountKeys({
      ...BASE,
      addressTableLookups: [{}],
      loadedAddresses: { writable: ['LoadedW'], readonly: [] },
    });

    expect(keys[4]?.signer).toBe(false);
  });

  it('flags unresolved lookups instead of guessing the missing addresses', () => {
    // Reading the lookup table now would resolve against its current contents,
    // which may have been extended since the failing slot.
    const { keys, unresolvedLookups } = flattenAccountKeys({
      ...BASE,
      addressTableLookups: [{ accountKey: 'Table', writableIndexes: [4], readonlyIndexes: [7] }],
      loadedAddresses: undefined,
    });

    expect(unresolvedLookups).toBe(true);
    expect(keys).toHaveLength(4);
  });

  it('does not flag a transaction that declares no lookups', () => {
    expect(flattenAccountKeys({ ...BASE, addressTableLookups: [] }).unresolvedLookups).toBe(false);
  });
});
