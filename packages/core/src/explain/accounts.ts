import type { FailedTransaction, InstructionNode } from '../ingest/types.ts';
import type { IdlHandler } from '../resolve/idl.ts';
import type { AccountRow, TokenSummary } from './types.ts';

/**
 * How far into an instruction's account list the IDL's names can be trusted.
 *
 * Two things break a positional mapping, and they break it differently.
 *
 * A transaction may pass *more* accounts than the IDL declares — Anchor's
 * `remaining_accounts`, which AMMs use heavily for tick arrays and route hops.
 * That is harmless: the declared accounts still occupy the same leading
 * positions and the surplus is simply unnamed.
 *
 * An *optional* account is not harmless. When the caller omits one, every
 * account after it shifts down a position, and nothing in the record says which
 * were supplied. Naming stops at the first optional account for that reason.
 *
 * Passing fewer accounts than that prefix requires means the published IDL and
 * the deployed binary disagree — an IDL is published by the program authority
 * and is not updated on upgrade. Nothing is named in that case. Whirlpool's
 * `increase_liquidity_v2` is the corpus example: 16 declared, no optionals, and
 * 15 actually passed.
 */
export function nameableCount(handler: IdlHandler, passed: number): number {
  const firstOptional = handler.accounts.findIndex((account) => account.optional);
  const declared = firstOptional === -1 ? handler.accounts.length : firstOptional;
  return passed >= declared ? declared : 0;
}

/** The token balance recorded for an account index, when the ledger recorded one. */
function tokenFor(transaction: FailedTransaction, index: number): TokenSummary | null {
  const row = transaction.tokenBalances.find((balance) => balance.index === index);
  if (row === undefined) return null;

  return {
    mint: row.mint,
    owner: row.owner,
    tokenProgram: row.tokenProgram,
    decimals: row.decimals,
    pre: row.pre,
    post: row.post,
  };
}

/**
 * The failing instruction's accounts, as the ledger recorded them.
 *
 * Nothing here is fetched. A failed transaction rolls back, so an account this
 * instruction found missing may well exist now, and a current-state read would
 * describe a different world than the one that failed.
 */
export function accountTable(
  transaction: FailedTransaction,
  node: InstructionNode,
  handler: IdlHandler | null,
): AccountRow[] {
  const named = handler === null ? 0 : nameableCount(handler, node.accountIndexes.length);

  return node.accountIndexes.map((index, position) => {
    const key = transaction.accounts.keys[index];
    const balance = transaction.lamports.find((row) => row.index === index);

    return {
      position,
      index,
      address: key?.address ?? null,
      name: position < named ? (handler?.accounts[position]?.name ?? null) : null,
      signer: key?.signer ?? false,
      writable: key?.writable ?? false,
      origin: key?.source ?? null,
      lamports: balance === undefined ? null : { pre: balance.pre, post: balance.post },
      // An account holding no lamports has been deallocated, so a zero
      // pre-balance is evidence of non-existence rather than an inference.
      existedBefore: balance === undefined ? null : balance.pre > 0n,
      token: tokenFor(transaction, index),
    };
  });
}
