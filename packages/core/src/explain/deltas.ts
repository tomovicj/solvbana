import type { FailedTransaction } from '../ingest/types.ts';
import type { BalanceDeltas, LamportDelta, TokenDelta } from './types.ts';

/**
 * What actually moved.
 *
 * On a failed transaction the answer is almost always "only the fee", and that
 * is worth stating rather than leaving as an empty section: it answers the
 * question the reader is about to ask, which is whether any of their state
 * changes survived. Only accounts that actually changed are listed, so the
 * absence of a row is itself informative.
 */
export function balanceDeltas(transaction: FailedTransaction): BalanceDeltas {
  const addressOf = (index: number): string | null =>
    transaction.accounts.keys[index]?.address ?? null;

  const lamports: LamportDelta[] = [];
  for (const row of transaction.lamports) {
    if (row.pre === row.post) continue;
    lamports.push({
      index: row.index,
      address: addressOf(row.index),
      pre: row.pre,
      post: row.post,
      delta: row.post - row.pre,
    });
  }

  const tokens: TokenDelta[] = [];
  for (const row of transaction.tokenBalances) {
    if (row.pre === row.post) continue;
    tokens.push({
      index: row.index,
      address: addressOf(row.index),
      mint: row.mint,
      owner: row.owner,
      decimals: row.decimals,
      pre: row.pre,
      post: row.post,
      // A side the ledger did not record cannot be differenced without inventing
      // the missing half, so the delta is withheld rather than assumed to be zero.
      delta: row.pre === null || row.post === null ? null : row.post - row.pre,
    });
  }

  return { lamports, tokens, fee: transaction.fee };
}
