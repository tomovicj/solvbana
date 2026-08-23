import type { AccountOrigin } from '../ingest/types.ts';

/**
 * One account of the failing instruction, as the ledger recorded it.
 *
 * Every field here comes from the transaction record, never from a current-state
 * account read. That restriction is what makes the table trustworthy: a failed
 * transaction rolls back, so an account this instruction found missing may well
 * exist today, and reading it now would contradict the failure being explained.
 *
 * It also bounds what can be shown. The account's owner and data length are not
 * in the record and are therefore absent rather than fetched.
 */
export interface AccountRow {
  /** Position within the failing instruction's account list, 0-based. */
  position: number;
  /** Index into the transaction's flattened account key list. */
  index: number;
  /** `null` when address lookups were unresolved and this index lies beyond them. */
  address: string | null;
  /** The IDL's name for this position, when an IDL declared the instruction. */
  name: string | null;
  signer: boolean;
  writable: boolean;
  origin: AccountOrigin | null;
  /** Lamports either side. A failed transaction rolls back everything but the fee. */
  lamports: { pre: bigint; post: bigint } | null;
  /**
   * Whether the account existed when the instruction ran.
   *
   * An account holding zero lamports has been deallocated, so a zero `pre`
   * balance is direct evidence of non-existence rather than an inference — which
   * is what makes it a real answer for `AccountNotInitialized`. `null` when no
   * balance was recorded for the index.
   */
  existedBefore: boolean | null;
  /** Present when the ledger recorded this account as a token account. */
  token: TokenSummary | null;
}

/** A token account's recorded state, carried alongside its row. */
export interface TokenSummary {
  mint: string;
  owner: string | null;
  tokenProgram: string | null;
  decimals: number;
  /** Fractional units, not whole tokens. */
  pre: bigint | null;
  post: bigint | null;
}

/** One seed component of an address derivation. */
export interface ResolvedSeed {
  kind: 'const' | 'account' | 'arg';
  /** Where the component came from, e.g. `arg bundle_index` or `account mint`. */
  source: string;
  /** Lowercase hex of the seed bytes, or `null` when the component was unresolvable. */
  bytes: string | null;
  /** The bytes as UTF-8 when printable — how `b"vault"` reads in source. */
  text: string | null;
  /**
   * The component as an address, when it is one.
   *
   * Kept structured rather than only rendered into `source`, so a consumer can
   * name the owner or mint of a derivation without parsing prose back out.
   */
  address: string | null;
}

export type DerivationStatus =
  /** The derived address is what the transaction passed. */
  | 'match'
  /** The derived address is not what the transaction passed. */
  | 'mismatch'
  /** A seed component could not be resolved, so no address was derived. */
  | 'unresolved'
  /**
   * The address is not derivable from the instruction's own inputs.
   *
   * Produced by the associated-token search, where every candidate is drawn from
   * the transaction record rather than from a declared seed list. A negative is
   * sound only over what was searched, so `searched` states that set.
   */
  | 'not-derivable';

/** Where a set of seeds was declared. */
export type DerivationSource =
  /** The program's own IDL, under an account's `pda.seeds`. */
  | 'idl-pda'
  /**
   * The Associated Token program's fixed rule, `[owner, tokenProgram, mint]`.
   *
   * Licensed by the same principle as the native error tables: the program's
   * address is pinned and its derivation is part of its published interface, so
   * this is a lookup on identity rather than a guess about conventions.
   */
  | 'associated-token';

/**
 * An address the transaction passed, checked against the address its declared
 * seeds produce.
 *
 * No address is ever reported from a partial seed set. When a component cannot
 * be resolved the check is `unresolved` and `blockedBy` names the component,
 * because a derivation from guessed seeds would be exactly the confident-and-wrong
 * answer this project exists to avoid.
 */
export interface DerivationCheck {
  /** The IDL's name for the account, or the role for a pinned derivation. */
  account: string;
  /** Position within the failing instruction's account list, or `null` when unknown. */
  position: number | null;
  /** What the transaction actually passed. */
  actual: string | null;
  /** The address the seeds produce, or `null` when a component was unresolvable. */
  expected: string | null;
  bump: number | null;
  /** The program the address derives under. */
  programId: string;
  seeds: ResolvedSeed[];
  status: DerivationStatus;
  source: DerivationSource;
  /** Names the component that blocked resolution, when `status` is `unresolved`. */
  blockedBy: string | null;
  /** The candidate space searched, when `status` is `not-derivable`. */
  searched: string | null;
}

/** One instruction argument, decoded against the IDL's declared type. */
export interface DecodedArg {
  name: string;
  /** The IDL's type expression, e.g. `u64` or `vec<pubkey>`. */
  type: string;
  /** The value rendered as text, or `null` when the type is not supported yet. */
  value: string | null;
}

/** One frame's compute consumption, from the runtime's own accounting. */
export interface ComputeFrame {
  programId: string;
  depth: number;
  consumed: number | null;
  budget: number | null;
  /** True for the frame that originated the failure. */
  failing: boolean;
}

export interface ComputeBreakdown {
  /** What the transaction consumed in total, from `meta.computeUnitsConsumed`. */
  total: bigint | null;
  /** The ceiling a `SetComputeUnitLimit` instruction requested, when there was one. */
  requestedLimit: number | null;
  frames: ComputeFrame[];
}

export interface LamportDelta {
  index: number;
  address: string | null;
  pre: bigint;
  post: bigint;
  /** `post - pre`. Negative means the account paid out. */
  delta: bigint;
}

export interface TokenDelta {
  index: number;
  address: string | null;
  mint: string;
  owner: string | null;
  decimals: number;
  pre: bigint | null;
  post: bigint | null;
  /** `null` when either side went unrecorded, since a delta would be invented. */
  delta: bigint | null;
}

/**
 * What actually moved.
 *
 * On a failed transaction the answer is almost always "only the fee", and saying
 * so plainly is worth more than an empty section: it tells the reader their state
 * changes rolled back, which is the question they were about to ask.
 */
export interface BalanceDeltas {
  lamports: LamportDelta[];
  tokens: TokenDelta[];
  /** The fee, which is the one thing a failed transaction does not roll back. */
  fee: bigint;
}

/**
 * The `Left:` / `Right:` operand pair Anchor printed, read against the record.
 *
 * The raw pair already reaches the wire on `Finding.failure.comparison`. This is
 * the interpretation of it: which side the transaction passed, which side the
 * program required, and the gap between them when both are numbers.
 *
 * `passed` is the load-bearing field and it is `null` more often than not. It is
 * set only when the record *proves* the orientation — see `readComparison` — so
 * a consumer that reads it can trust it, and one that finds it `null` knows the
 * operands are unlabelled rather than mislabelled.
 */
export interface ReadComparison {
  left: string;
  right: string;
  /** Which side the record proves the transaction passed, when it proves one. */
  passed: 'left' | 'right' | null;
  /** The blamed account's recorded address, when a row was matched. */
  account: string | null;
  /**
   * The instruction argument whose value an operand carried, when exactly one
   * argument carried exactly one operand.
   *
   * `side` names which operand it matched and is `null` when it matched both,
   * which is what an equal pair produces. That is the weaker of two claims and
   * the distinction is load-bearing: matching identifies where a value came
   * from, and settles which side the client *supplied* only when the operands
   * differ. `require_gt!(0, 0)` against `minimum_amount_out = 0` proves the zero
   * came from that argument and nothing about which zero.
   */
  argument: { name: string; side: 'left' | 'right' | null } | null;
  /** The gap between the operands, when both parse as integers. */
  numeric: {
    /** Absolute difference, so it does not depend on which side is which. */
    difference: bigint;
    /** True when the comparison failed on equality rather than on magnitude. */
    equal: boolean;
    /** The difference over the larger operand, or `null` when that is zero. */
    relative: number | null;
  } | null;
}

/** What this failure means and what to do about it. */
export interface Guidance {
  /** What this class of failure means, in plain words. */
  meaning: string;
  /** The usual causes, most likely first. */
  causes: string[];
  /** A concrete fix, when the evidence is unambiguous enough to name one. */
  fix: string | null;
}

/**
 * The structured explanation of a failure, built from the transaction record and
 * the program's published IDL.
 *
 * Deliberately produces no `Confidence` and no `CandidateSite`. This tier
 * explains what earlier tiers established and locates nothing new, so promoting
 * a diagnosis on the strength of an explanation would be inventing precision.
 * `explanationChangesNothing` in the corpus suite asserts it.
 *
 * Every part is independently optional and every absence is accounted for in
 * `notes`, which is the degrade-in-tiers contract applied to this tier.
 */
export interface Explanation {
  /** The failing instruction's accounts, as the ledger recorded them. */
  accounts: AccountRow[];
  /** Arguments decoded against the IDL, or `null` when no IDL declared them. */
  args: DecodedArg[] | null;
  /** Address derivations checked against what the transaction passed. */
  derivations: DerivationCheck[];
  compute: ComputeBreakdown | null;
  deltas: BalanceDeltas;
  /**
   * The operand pair Anchor printed, read against the record.
   *
   * Kept beside `derivations` rather than folded into one, because the two are
   * different kinds of evidence. A `DerivationCheck` is an address this tier
   * *computed* from declared seeds; this is an address the running program
   * computed and *printed*. Merging them would put a read into a structure whose
   * `seeds`, `bump` and `programId` fields describe a derivation that never
   * happened.
   */
  comparison: ReadComparison | null;
  guidance: Guidance;
  /** Why each part is present, absent, or partial. */
  notes: string[];
}
