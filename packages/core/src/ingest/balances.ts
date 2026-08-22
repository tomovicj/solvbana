import type { LamportBalance, RawTransaction, TokenBalance } from './types.ts';

/**
 * Lamport balances per account, exactly as the ledger recorded them.
 *
 * Indices address the flattened account key list, and are kept even when the
 * address behind one is unresolved: `meta.preBalances` covers every account the
 * transaction loaded, including those that came from a lookup table, so the
 * array is routinely longer than the statically declared keys. Dropping the
 * overflow would silently lose the accounts a v0 transaction cares most about.
 */
export function lamportBalancesFrom(raw: RawTransaction): LamportBalance[] {
  const pre = raw.meta?.preBalances ?? null;
  const post = raw.meta?.postBalances ?? null;
  if (pre === null || post === null) return [];

  const rows: LamportBalance[] = [];
  for (let index = 0; index < Math.max(pre.length, post.length); index += 1) {
    const before = pre[index];
    const after = post[index];
    if (before === undefined || after === undefined) continue;
    rows.push({ index, pre: before, post: after });
  }
  return rows;
}

/** The shape `meta.preTokenBalances` entries arrive in, named so the merge reads. */
type RawTokenBalance = Readonly<{
  accountIndex: number;
  mint: string;
  owner?: string | undefined;
  programId?: string | undefined;
  uiTokenAmount: Readonly<{ amount: string; decimals: number }>;
}>;

/**
 * Token balances for the accounts the ledger recorded as token accounts.
 *
 * The two sides arrive as separate arrays keyed by `accountIndex` rather than as
 * one list, and an account can appear in either alone — a token account created
 * during the transaction has no `pre` entry, and one closed has no `post`. They
 * are merged on the index, with each side left `null` when it was not recorded,
 * so "balance of zero" and "not recorded" stay distinguishable.
 *
 * `owner` and `programId` are optional in the RPC response. Neither is inferred:
 * the token program in particular is a seed of the associated-token address, and
 * assuming the classic Token program derives the wrong address for a Token-2022
 * mint. Both are live in the corpus.
 */
export function tokenBalancesFrom(raw: RawTransaction): TokenBalance[] {
  const pre = raw.meta?.preTokenBalances ?? [];
  const post = raw.meta?.postTokenBalances ?? [];
  if (pre.length === 0 && post.length === 0) return [];

  const rows = new Map<number, TokenBalance>();

  const merge = (entries: readonly RawTokenBalance[], side: 'pre' | 'post'): void => {
    for (const entry of entries) {
      const row: TokenBalance = rows.get(entry.accountIndex) ?? {
        index: entry.accountIndex,
        mint: entry.mint,
        owner: entry.owner ?? null,
        tokenProgram: entry.programId ?? null,
        decimals: entry.uiTokenAmount.decimals,
        pre: null,
        post: null,
      };
      rows.set(entry.accountIndex, { ...row, [side]: toAmount(entry.uiTokenAmount.amount) });
    }
  };

  merge(pre, 'pre');
  merge(post, 'post');

  return [...rows.values()].sort((a, b) => a.index - b.index);
}

/** `amount` is a decimal string of fractional units, which can exceed `Number`. */
function toAmount(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
