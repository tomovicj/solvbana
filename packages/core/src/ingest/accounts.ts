import type { AccountKey, AccountKeys, RawTransaction } from './types.ts';

export interface FlattenInput {
  staticKeys: readonly string[];
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  };
  /** Present when the transaction loads addresses from lookup tables. */
  addressTableLookups: readonly unknown[] | undefined;
  loadedAddresses: { writable: readonly string[]; readonly: readonly string[] } | undefined;
}

/**
 * Whether a *static* account key is writable, per the message header.
 *
 * The static list is ordered in four runs: writable signers, readonly signers,
 * writable non-signers, readonly non-signers. The header gives the boundaries as
 * counts rather than indices, so both ends have to be computed.
 */
function isStaticKeyWritable(
  index: number,
  count: number,
  header: FlattenInput['header'],
): boolean {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = header;

  if (index < numRequiredSignatures) {
    return index < numRequiredSignatures - numReadonlySignedAccounts;
  }
  return index < count - numReadonlyUnsignedAccounts;
}

/**
 * Flatten static and lookup-table addresses into the single list that
 * instruction indices actually reference.
 *
 * The runtime's order is fixed and load-bearing: static keys, then the addresses
 * loaded as writable, then those loaded as readonly. Getting it wrong misnames
 * every account in the report.
 *
 * When a transaction declares `addressTableLookups` but the RPC omitted
 * `meta.loadedAddresses`, this returns the static keys alone and sets
 * `unresolvedLookups`. Fetching the lookup table to fill the gap would read its
 * *current* contents, which may have been extended since the failing slot — the
 * same class of bug as diagnosing against a current program binary. An honest
 * gap beats a plausible wrong address.
 */
export function flattenAccountKeys(input: FlattenInput): AccountKeys {
  const { staticKeys, header, addressTableLookups, loadedAddresses } = input;

  const keys: AccountKey[] = staticKeys.map((address, index) => ({
    index,
    address,
    source: 'static' as const,
    signer: index < header.numRequiredSignatures,
    writable: isStaticKeyWritable(index, staticKeys.length, header),
  }));

  // Addresses loaded from a lookup table are never signers — only statically
  // declared accounts can sign.
  for (const address of loadedAddresses?.writable ?? []) {
    keys.push({
      index: keys.length,
      address,
      source: 'lookup-writable',
      signer: false,
      writable: true,
    });
  }
  for (const address of loadedAddresses?.readonly ?? []) {
    keys.push({
      index: keys.length,
      address,
      source: 'lookup-readonly',
      signer: false,
      writable: false,
    });
  }

  const usesLookups = (addressTableLookups?.length ?? 0) > 0;
  return { keys, unresolvedLookups: usesLookups && loadedAddresses === undefined };
}

/** Pull the flatten inputs off a raw response and resolve them. */
export function accountKeysFrom(raw: RawTransaction): AccountKeys {
  const message = raw.transaction.message;
  const meta = raw.meta;

  return flattenAccountKeys({
    staticKeys: message.accountKeys,
    header: message.header,
    addressTableLookups: message.addressTableLookups,
    loadedAddresses: meta?.loadedAddresses,
  });
}

/** Resolve an instruction's account index, or `null` when it falls outside the resolved list. */
export function addressAt(accounts: AccountKeys, index: number): string | null {
  return accounts.keys[index]?.address ?? null;
}
