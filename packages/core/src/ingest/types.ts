import type { GetTransactionApiResponseJson } from '@solana/kit';

/**
 * The raw `getTransaction` response, exactly as the RPC returned it.
 *
 * Pinned to `encoding: 'json'` and `maxSupportedTransactionVersion: 0` because
 * the instruction tree is built from raw `programIdIndex` / `accounts` indices,
 * which `jsonParsed` replaces with addresses, and because omitting the version
 * ceiling errors on every v0 transaction.
 */
export type RawTransaction = GetTransactionApiResponseJson<0>;

/** Where an account address came from in the flattened key list. */
export type AccountSource = 'static' | 'lookup-writable' | 'lookup-readonly';

export interface AccountKey {
  /** Index into the flattened list — the index instructions actually reference. */
  index: number;
  address: string;
  source: AccountSource;
  signer: boolean;
  writable: boolean;
}

export interface AccountKeys {
  keys: AccountKey[];
  /**
   * True when the transaction loads addresses from lookup tables but the RPC did
   * not return `meta.loadedAddresses`.
   *
   * The tables are mutable, so reading one now would resolve indices against a
   * table that may have been extended since the failing slot — the same class of
   * bug as diagnosing against a current program binary. Callers must treat
   * indices at or beyond `keys.length` as unresolved rather than guessing.
   */
  unresolvedLookups: boolean;
}

/** A `meta.err` value that named a specific instruction's failure. */
export type InstructionError =
  | { kind: 'custom'; code: number }
  | { kind: 'named'; name: string }
  | { kind: 'borsh-io-error'; message: string }
  | { kind: 'unrecognized'; raw: unknown };

export type TransactionError =
  | { kind: 'instruction-error'; index: number; error: InstructionError }
  | { kind: 'insufficient-funds-for-rent'; accountIndex: number }
  | { kind: 'program-execution-temporarily-restricted'; accountIndex: number }
  | { kind: 'duplicate-instruction'; index: number }
  /** A bare string variant such as `AlreadyProcessed` or `BlockhashNotFound`. */
  | { kind: 'simple'; name: string }
  | { kind: 'unrecognized'; raw: unknown };

export interface InstructionNode {
  /** Index of the top-level instruction this node belongs to. */
  outerIndex: number;
  /** `1` for a top-level instruction, `2` for a direct CPI, and so on. */
  stackHeight: number;
  /** Index into the flattened account keys, or `null` when lookups are unresolved. */
  programIdIndex: number;
  programId: string | null;
  accountIndexes: number[];
  /** Base58, exactly as returned. Decoding the 8-byte discriminator is Phase 3. */
  data: string;
  children: InstructionNode[];
  /**
   * True when the RPC reported no `stackHeight` for this instruction's CPI
   * children, so they are attached flat rather than nested. Phase 3's CPI-progress
   * bounding depends on real depth, so this must stay visible.
   */
  cpiDepthUnavailable: boolean;
}

export type LogEvent =
  | { kind: 'invoke'; programId: string; depth: number }
  | { kind: 'success'; programId: string }
  | { kind: 'failed'; programId: string; reason: string }
  | { kind: 'log'; message: string }
  | { kind: 'data'; base64: string }
  | { kind: 'return'; programId: string; base64: string }
  | { kind: 'consumed'; programId: string; units: number; budget: number }
  | { kind: 'truncated' }
  | { kind: 'unparsed' };

export interface LogLine {
  /** Position in `meta.logMessages`. */
  index: number;
  /** The line verbatim. Phase 1 runs its Anchor and panic regexes over this. */
  raw: string;
  event: LogEvent;
  /**
   * The `outerIndex` of the instruction in scope when this line was emitted, or
   * `null` when attribution was impossible (truncated tail, or logs absent).
   */
  outerIndex: number | null;
}

export interface LogStream {
  /** `true` when the runtime emitted its `Log truncated` marker at the 10KB cap. */
  truncated: boolean;
  /** `true` when `meta.logMessages` was `null` — log recording was off. */
  absent: boolean;
  lines: LogLine[];
}

/**
 * The Phase 0 output: one normalized shape for legacy and v0 transactions alike,
 * which every later tier reads from.
 */
export interface FailedTransaction {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  version: 'legacy' | number;
  fee: bigint;
  computeUnitsConsumed: bigint | null;
  accounts: AccountKeys;
  error: TransactionError;
  /** Top-level instructions, with CPI children nested underneath. */
  instructions: InstructionNode[];
  logs: LogStream;
  /**
   * Every "this could not be resolved" note, in the order they were discovered.
   *
   * This is what makes "degrade in tiers, never fail blank" checkable: nothing is
   * dropped silently, and `diagnose()` copies these into `Diagnosis.reasons`.
   */
  degradations: string[];
}
