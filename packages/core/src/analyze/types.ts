import type { SourceLocation } from '../diagnosis.ts';

/**
 * Where an error's name and message came from.
 *
 * Provenance is tracked rather than assumed because the tier is only allowed to
 * name an error it actually read. Anchor reserves 2000–2999 for constraints and
 * 3000–3999 for account checks, but those ranges are a convention of one
 * framework, not a property of the runtime: any program may return any `u32`.
 * The corpus contains two Whirlpool failures throwing `Custom(2012)` with no
 * Anchor logging at all, and naming them `ConstraintAddress` from the range
 * would be exactly the confident-and-wrong answer this project exists to avoid.
 * There is deliberately no `inferred-from-range` member here.
 */
export type ErrorNaming =
  /** Read verbatim out of the program's own log output. */
  | 'logged'
  /** Looked up in a built-in table keyed on a pinned, immutable program address. */
  | 'native-table'
  /** The runtime's own `InstructionError` variant name, which arrives in `meta.err`. */
  | 'runtime-variant'
  /** Not named. The raw code is all there is until an IDL is resolved in Phase 2. */
  | 'none';

export interface DecodedError {
  /** The `Custom(n)` code, when the failure carried one. */
  code: number | null;
  name: string | null;
  /** The `#[msg]` text, or the table's description. */
  message: string | null;
  naming: ErrorNaming;
}

/** The two operands Anchor logs for a failed comparison, as `Left:` and `Right:`. */
export interface Comparison {
  left: string;
  right: string;
}

/** What a Rust panic message means, for panics whose text is recognizable. */
export type PanicClass =
  | 'arithmetic-overflow'
  | 'divide-by-zero'
  | 'index-out-of-bounds'
  | 'slice-out-of-range'
  | 'unwrap-none'
  | 'unwrap-err'
  | 'explicit-panic'
  | 'unclassified';

/** Which limit compute exhaustion hit. They have different fixes. */
export type ComputeScope =
  /** The invoked program hit the compute units available to its own frame. */
  | 'frame'
  /** The transaction-wide compute budget ran out. */
  | 'transaction'
  /** The 4KB stack frame limit — not a budget problem at all. */
  | 'stack-frame';

export type FailureKind =
  | {
      kind: 'anchor';
      /** The `#[derive(Accounts)]` struct field Anchor blamed, when it named one. */
      account: string | null;
      /** Present only for `AnchorError thrown in <file>:<line>`, which Anchor emits without a column. */
      site: SourceLocation | null;
      comparison: Comparison | null;
    }
  | { kind: 'panic'; site: SourceLocation; message: string; classification: PanicClass }
  | {
      kind: 'compute';
      scope: ComputeScope;
      /** Compute units the failing frame used, and the ceiling it was measured against. */
      consumed: number | null;
      budget: number | null;
      /** From a `SetComputeUnitLimit` instruction, when the transaction requested one. */
      requestedLimit: number | null;
      /** The stack frame index from an access violation, when that is the failure. */
      stackFrame: number | null;
    }
  | { kind: 'native'; programId: string }
  | { kind: 'runtime'; variant: string }
  | { kind: 'undecoded' };

/**
 * The structured result of reading a failed transaction's logs.
 *
 * Kept as data rather than folded into prose because Phase 4 renders source
 * excerpts and recomputes PDAs from these fields, and the Phase 6 CI API reports
 * on them. A renderer that had to re-parse its own summary string would be a
 * parser for a format nobody specified.
 */
export interface Finding {
  /** The program that originated the failure — the innermost one, not the caller. */
  program: string | null;
  /** Anchor's `Program log: Instruction: <Handler>` prologue, read from the failing frame only. */
  handler: string | null;
  error: DecodedError;
  failure: FailureKind;
  /** What went wrong in the reader's mental model, in plain words. */
  explanation: string;
}
