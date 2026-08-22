import { NATIVE_PROGRAM_IDS } from '@solvbana/core';

/**
 * The five failure categories the fixture corpus has to span, per Phase 0.
 *
 * Anchor splits its reserved error-code ranges by meaning, and the corpus tracks
 * that split because the tiers treat them differently: a constraint error names
 * the offending account in the logs, while an account error identifies a type or
 * ownership mismatch instead.
 */
export type Category =
  | 'anchor-constraint'
  | 'anchor-account'
  | 'custom-error'
  | 'panic'
  | 'compute-exhaustion'
  | 'native-program'
  | 'runtime-error';

export const CATEGORIES: readonly Category[] = [
  'anchor-constraint',
  'anchor-account',
  'custom-error',
  'panic',
  'compute-exhaustion',
  'native-program',
  'runtime-error',
];

export interface ClassifyInput {
  err: unknown;
  logs: readonly string[];
}

function customCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const instructionError = (err as Record<string, unknown>)['InstructionError'];
  if (!Array.isArray(instructionError) || instructionError.length !== 2) return null;

  const inner = instructionError[1] as unknown;
  if (typeof inner !== 'object' || inner === null) return null;

  const code = (inner as Record<string, unknown>)['Custom'];
  return typeof code === 'number' ? code : null;
}

function namedInstructionError(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const instructionError = (err as Record<string, unknown>)['InstructionError'];
  if (!Array.isArray(instructionError) || instructionError.length !== 2) return null;

  const inner = instructionError[1] as unknown;
  return typeof inner === 'string' ? inner : null;
}

/**
 * Bucket a failed transaction for corpus coverage.
 *
 * Ordered most-specific first: a panic is a panic regardless of which error code
 * the runtime ultimately reported, and compute exhaustion is recognizable from
 * the log line even when the error surfaces as a generic failure.
 */
export function classify({ err, logs }: ClassifyInput): Category | null {
  if (logs.some((line) => line.includes('panicked at'))) return 'panic';

  const named = namedInstructionError(err);
  if (named === 'ComputationalBudgetExceeded' || named === 'ProgramFailedToComplete') {
    if (logs.some((line) => /exceeded (CUs meter|.*compute units)/.test(line))) {
      return 'compute-exhaustion';
    }
  }
  if (logs.some((line) => /exceeded (CUs meter|.*compute units)/.test(line))) {
    return 'compute-exhaustion';
  }

  const code = customCode(err);
  if (code !== null) {
    // Anchor reserves 2000-2999 for constraints and 3000-3999 for account
    // checks; user errors declared with #[error_code] start at 6000.
    if (code >= 2000 && code < 3000) return 'anchor-constraint';
    if (code >= 3000 && code < 4000) return 'anchor-account';
    return 'custom-error';
  }

  if (named !== null) {
    const program = failingProgramId(logs);
    return program !== null && NATIVE_PROGRAM_IDS.has(program) ? 'native-program' : 'runtime-error';
  }

  return null;
}

/**
 * The program that originated the failure.
 *
 * A CPI failure logs the innermost program's `failed:` line first and then each
 * caller's on the way out, so the *first* such line names the program that
 * actually errored rather than the one that merely propagated it.
 */
export function failingProgramId(logs: readonly string[]): string | null {
  for (const line of logs) {
    const match = /^Program (\S+) failed:/.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * A key identifying "the same kind of failure", used to keep the corpus diverse.
 *
 * Left unchecked a harvest fills up with whichever error the busiest program on
 * chain is currently throwing — five copies of one AMM's slippage error exercise
 * exactly one code path. Capping repeats per key buys coverage of distinct
 * failures instead of a popularity ranking.
 *
 * The panic site is part of the key because two panics in the same program at
 * different lines are genuinely different cases, while the error code alone
 * (`ProgramFailedToComplete` for every panic) would collapse them.
 */
export function distinctnessKey({ err, logs }: ClassifyInput): string {
  const code = customCode(err);
  const named = namedInstructionError(err);
  const variant = code === null ? (named ?? 'unknown') : `Custom(${String(code)})`;

  const panicSite = logs
    .find((line) => line.includes('panicked at'))
    ?.replace(/^Program log: /, '')
    // Both Rust panic formats carry a file:line:col; the message around it varies.
    .match(/[\w./-]+\.rs:\d+:\d+/)?.[0];

  return [variant, failingProgramId(logs) ?? '?', panicSite ?? ''].join('|');
}
