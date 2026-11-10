import { describe, expect, it } from 'vitest';
import {
  accountKeysFrom,
  flattenAccountKeys,
  reviveRawTransaction,
  type FlattenInput,
} from '@solvbana/core';
import { readJson } from '../fixtures.ts';

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

describe('version 1 messages', () => {
  // The widest recorded version 1 transaction: 64 static keys, which is the
  // version 1 cap, and no `addressTableLookups` key at all.
  const SIGNATURE =
    '2WCoeS1dpMjPuG8PjGvAaMJ9eGHz9P1o1UhE5we3GbBaQtoLs9UoDoYgBM8EcT1szgG1bYUJcLb4HezC5CVGRxVC';

  it('flattens a message with no addressTableLookups key, keeping the header boundaries', () => {
    const raw = reviveRawTransaction(readJson('transactions', `${SIGNATURE}.json`));
    expect('addressTableLookups' in raw.transaction.message).toBe(false);

    const { keys, unresolvedLookups } = accountKeysFrom(raw);

    expect(unresolvedLookups).toBe(false);
    expect(keys).toHaveLength(64);
    // numRequiredSignatures 1, no readonly signers, 51 readonly unsigned of 64.
    expect(keys.filter((key) => key.signer)).toHaveLength(1);
    expect(keys[0]).toMatchObject({ signer: true, writable: true });
    expect(keys.filter((key) => !key.signer && key.writable)).toHaveLength(12);
    expect(keys.filter((key) => !key.writable)).toHaveLength(51);
    expect(keys.every((key) => key.source === 'static')).toBe(true);
  });

  it('degrades to the static keys, unresolved, when an invariant is violated', () => {
    const raw = reviveRawTransaction(readJson('synthetic', 'v1-with-lookups.json'));

    const { keys, unresolvedLookups } = accountKeysFrom(raw);

    expect(unresolvedLookups).toBe(true);
    expect(keys).toHaveLength(4);
  });
});
