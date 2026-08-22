import { describe, expect, it } from 'vitest';
import { accountTable, nameableCount, type IdlHandler, type InstructionNode } from '@solvbana/core';
import { failedTransaction, handlerWith, instruction } from './helpers.ts';

describe('nameableCount', () => {
  it('names every declared account when the counts agree', () => {
    expect(nameableCount(handlerWith(['a', 'b', 'c']), 3)).toBe(3);
  });

  it('still names the declared prefix when extra accounts were passed', () => {
    // Anchor's remaining_accounts sit after the declared list, so the declared
    // accounts keep their positions and only the surplus is unnamed. AMMs pass
    // dozens of these for tick arrays and route hops.
    expect(nameableCount(handlerWith(['a', 'b']), 30)).toBe(2);
  });

  it('stops at the first optional account', () => {
    // An omitted optional shifts every account after it and nothing in the
    // record says which were supplied, so names past that point would be
    // attached to the wrong addresses.
    const handler = handlerWith(['a', 'b', 'c'], { optionalFrom: 1 });
    expect(nameableCount(handler, 3)).toBe(1);
  });

  it('names nothing when fewer accounts were passed than declared', () => {
    // The published IDL and the deployed binary disagree. Whirlpool's
    // increase_liquidity_v2 is the corpus case: 16 declared, no optionals, 15
    // passed. Naming by position would misattribute all of them.
    expect(nameableCount(handlerWith(['a', 'b', 'c']), 2)).toBe(0);
  });
});

describe('accountTable', () => {
  const node: InstructionNode = instruction([0, 1, 2]);

  it('reads a zero pre-balance as the account not existing', () => {
    // An account with no lamports has been deallocated, so this is a fact from
    // the record rather than an inference — and it is the direct answer to
    // AccountNotInitialized.
    const table = accountTable(failedTransaction({ lamports: [0n, 5n, 7n] }), node, null);

    expect(table.map((row) => row.existedBefore)).toEqual([false, true, true]);
  });

  it('leaves existence unknown when no balance was recorded', () => {
    const table = accountTable(failedTransaction({ lamports: [] }), node, null);

    expect(table.every((row) => row.existedBefore === null)).toBe(true);
  });

  it('attaches names only across the trustworthy prefix', () => {
    const handler: IdlHandler = handlerWith(['first', 'second'], { optionalFrom: 1 });
    const table = accountTable(failedTransaction({ lamports: [1n, 1n, 1n] }), node, handler);

    expect(table.map((row) => row.name)).toEqual(['first', null, null]);
  });

  it('carries the recorded token balance, including which token program owns it', () => {
    // The token program is a seed of the associated token address, so losing it
    // would derive the wrong address for a Token-2022 mint.
    const transaction = failedTransaction({
      lamports: [1n, 1n, 1n],
      tokenBalances: [
        {
          index: 1,
          mint: 'MintAddress',
          owner: 'OwnerAddress',
          tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          decimals: 6,
          pre: 10n,
          post: 10n,
        },
      ],
    });

    const table = accountTable(transaction, node, null);

    expect(table[1]?.token).toMatchObject({
      mint: 'MintAddress',
      tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    });
    expect(table[0]?.token).toBeNull();
  });
});
