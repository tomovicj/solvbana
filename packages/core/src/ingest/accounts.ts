import type { AccountKey, AccountKeys, RawTransaction } from './types.ts';

export interface FlattenInput {
  staticKeys: readonly string[];
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  };
  /**
   * Present when the transaction loads addresses from lookup tables. Version 1
   * messages have no such key at all, so absence is ordinary rather than a gap.
   */
  addressTableLookups?: readonly unknown[] | undefined;
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

/**
 * What a version 1 record must look like for its account list to be trusted.
 *
 * Version 1 messages carry at most 64 static keys and no lookup tables, so the
 * flattened list is the static list and `meta.preBalances` lines up with it one
 * to one. Those three facts held across every version 1 transaction checked, and
 * they are what make flattening by header alone correct. A record that breaks
 * one is not the shape this was verified against, so each violation is returned
 * as a sentence and the caller degrades instead of indexing into a list that may
 * be wrong. Empty for any other version.
 */
export function versionOneViolations(raw: RawTransaction): string[] {
  if (raw.version !== 1) return [];

  const violations: string[] = [];
  const message = raw.transaction.message as { addressTableLookups?: readonly unknown[] };
  const lookups = message.addressTableLookups?.length ?? 0;
  if (lookups > 0) {
    violations.push(
      `its message declares ${String(lookups)} address table lookup(s), which version 1 does not have`,
    );
  }

  const loaded = raw.meta?.loadedAddresses;
  const loadedCount = (loaded?.writable.length ?? 0) + (loaded?.readonly.length ?? 0);
  if (loadedCount > 0) {
    violations.push(
      `\`meta.loadedAddresses\` lists ${String(loadedCount)} address(es), but version 1 loads none`,
    );
  }

  const balances = raw.meta?.preBalances.length;
  if (balances !== undefined && balances !== raw.transaction.message.accountKeys.length) {
    violations.push(
      `\`meta.preBalances\` has ${String(balances)} entries against ` +
        `${String(raw.transaction.message.accountKeys.length)} account keys`,
    );
  }

  return violations;
}

/** Pull the flatten inputs off a raw response and resolve them. */
export function accountKeysFrom(raw: RawTransaction): AccountKeys {
  const message = raw.transaction.message;
  const meta = raw.meta;

  // A version 1 record that breaks the shape it was verified against is flattened
  // from its static keys alone and flagged unresolved, the same degrade a missing
  // `loadedAddresses` gets: indices beyond the static list are then unresolved
  // rather than named from a list that may be wrong.
  if (versionOneViolations(raw).length > 0) {
    const flattened = flattenAccountKeys({
      staticKeys: message.accountKeys,
      header: message.header,
      addressTableLookups: undefined,
      loadedAddresses: undefined,
    });
    return { ...flattened, unresolvedLookups: true };
  }

  return flattenAccountKeys({
    staticKeys: message.accountKeys,
    header: message.header,
    // Optional by type, not just by habit: a version 1 message omits the key.
    addressTableLookups: (message as { addressTableLookups?: readonly unknown[] })
      .addressTableLookups,
    loadedAddresses: meta?.loadedAddresses,
  });
}

/** Resolve an instruction's account index, or `null` when it falls outside the resolved list. */
export function addressAt(accounts: AccountKeys, index: number): string | null {
  return accounts.keys[index]?.address ?? null;
}
