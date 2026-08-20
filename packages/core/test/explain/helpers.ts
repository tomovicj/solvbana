import type { FailedTransaction, IdlHandler, InstructionNode, TokenBalance } from '@solvbana/core';

/** Real mainnet addresses, because kit validates base58 length on every use. */
export const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export const ADDRESSES = [
  '2N2Zsv5PpGMqNo6eJA17jCB6d2v3uuRQW3zwxe4fGun8',
  'D5dn4onVZucPxFmhsWcw43W5shmyPo6LNq3xuEfLaNyn',
  'DTGWeDVPAvr7TdY7sdbfjz2bi4QihVMMn9KhyKH1pump',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  '9ogmbo77xhkTgCae4CGYdChocZ9FgTNMjcAgKF2Sy6Ux',
];

/** An IDL handler declaring the given account names, optionally optional from an index. */
export function handlerWith(
  names: readonly string[],
  options: { optionalFrom?: number; seeds?: Record<string, IdlHandler['accounts'][number]> } = {},
): IdlHandler {
  return {
    name: 'handler',
    discriminator: '0000000000000000',
    args: [],
    accounts: names.map((name, index) => ({
      name,
      seeds: null,
      program: null,
      optional: options.optionalFrom !== undefined && index >= options.optionalFrom,
    })),
  };
}

export function instruction(accountIndexes: number[], data = '1'): InstructionNode {
  return {
    outerIndex: 0,
    stackHeight: 1,
    programIdIndex: 0,
    programId: PROGRAM,
    accountIndexes,
    data,
    children: [],
    cpiDepthUnavailable: false,
  };
}

/** A minimal transaction carrying only what the explanation tier reads. */
export function failedTransaction(
  options: {
    lamports?: bigint[];
    tokenBalances?: TokenBalance[];
    addresses?: string[];
    instructions?: InstructionNode[];
  } = {},
): FailedTransaction {
  const lamports = options.lamports ?? [];
  const addresses = options.addresses ?? lamports.map((_, index) => ADDRESSES[index] ?? PROGRAM);

  return {
    signature: 'sig',
    slot: 1n,
    blockTime: null,
    version: 0,
    fee: 5000n,
    computeUnitsConsumed: null,
    accounts: {
      keys: addresses.map((address, index) => ({
        index,
        address,
        source: 'static',
        signer: index === 0,
        writable: true,
      })),
      unresolvedLookups: false,
    },
    error: { kind: 'instruction-error', index: 0, error: { kind: 'custom', code: 1 } },
    instructions: options.instructions ?? [],
    lamports: lamports.map((value, index) => ({ index, pre: value, post: value })),
    tokenBalances: options.tokenBalances ?? [],
    logs: { truncated: false, absent: true, lines: [] },
    degradations: [],
  };
}
