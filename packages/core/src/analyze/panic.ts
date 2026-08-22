import type { SourceLocation } from '../diagnosis.ts';
import type { Frame } from './frames.ts';
import type { PanicClass } from './types.ts';

/**
 * Rust's panic format before 1.73: the message first, quoted, then the location.
 *
 * ```text
 * panicked at 'index out of bounds: the len is 0 but the index is 0', src/state.rs:376:12
 * ```
 */
const LEGACY_PANIC = /^panicked at '([\s\S]*)', (.+?):(\d+):(\d+)$/;

/**
 * Rust's panic format from 1.73 onward: the location first, then the message on
 * the following line.
 *
 * ```text
 * panicked at program/src/reset.rs:25:39:
 * attempt to add with overflow
 * ```
 *
 * The newline is *inside* a single `meta.logMessages` entry rather than splitting
 * it into two, so this matches across it instead of looking at the next line.
 */
const MODERN_PANIC = /^panicked at (.+?):(\d+):(\d+):\n([\s\S]*)$/;

export interface Panic {
  site: SourceLocation;
  message: string;
  classification: PanicClass;
}

/**
 * Recognize what a panic message means.
 *
 * The text comes from the Rust standard library rather than from the program, so
 * these strings are stable across every Solana program that panics the same way —
 * which is what makes a static table worth having here rather than inference.
 */
export function classifyPanic(message: string): PanicClass {
  if (/^attempt to (add|subtract|multiply|negate|shift).* with overflow$/.test(message)) {
    return 'arithmetic-overflow';
  }
  if (/^attempt to (divide|calculate the remainder with a divisor of) (by )?zero$/.test(message)) {
    return 'divide-by-zero';
  }
  if (message.startsWith('index out of bounds')) return 'index-out-of-bounds';
  if (/^(range end index|range start index|slice index starts at|byte index)/.test(message)) {
    return 'slice-out-of-range';
  }
  if (message.includes('`Option::unwrap()` on a `None` value')) return 'unwrap-none';
  if (message.includes('called `Result::unwrap()`')) return 'unwrap-err';
  if (/^(assertion|explicit panic|not yet implemented|internal error)/.test(message)) {
    return 'explicit-panic';
  }
  return 'unclassified';
}

/** Parse one `Program log:` message body as a Rust panic, in either format. */
export function parsePanic(message: string): Panic | null {
  const legacy = LEGACY_PANIC.exec(message);
  if (legacy) {
    const text = legacy[1]!;
    return {
      site: { file: legacy[2]!, line: Number(legacy[3]), column: Number(legacy[4]) },
      message: text,
      classification: classifyPanic(text),
    };
  }

  const modern = MODERN_PANIC.exec(message);
  if (modern) {
    const text = modern[4]!.trim();
    return {
      site: { file: modern[1]!, line: Number(modern[2]), column: Number(modern[3]) },
      message: text,
      classification: classifyPanic(text),
    };
  }

  return null;
}

/** The panic a frame reported, if any, from that frame's own lines. */
export function panicIn(frame: Frame): Panic | null {
  for (const line of frame.lines) {
    if (line.event.kind !== 'log') continue;
    const parsed = parsePanic(line.event.message);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Plain-English account of what a panic class means and what usually causes it.
 *
 * The overflow case carries a note worth stating explicitly: a panic there means
 * the program was built with `overflow-checks = true`. The same bug in a release
 * build without them wraps silently and corrupts state instead, so the panic is
 * the good outcome.
 */
export function explainPanic(panic: Panic): string {
  switch (panic.classification) {
    case 'arithmetic-overflow':
      return (
        'An arithmetic operation overflowed its integer type. This is usually an unchecked ' +
        'balance or supply calculation meeting a value larger than the developer assumed, or a ' +
        'subtraction that went below zero on an unsigned type. Use the checked_* or saturating_* ' +
        'operations at this site and decide explicitly what should happen at the boundary. ' +
        'That this panicked rather than wrapping means the program was built with ' +
        'overflow-checks enabled, which is the safe configuration — the same bug in a build ' +
        'without them corrupts state silently.'
      );
    case 'divide-by-zero':
      return (
        'A division or remainder had a zero divisor. In AMM and lending math this is typically ' +
        'an empty pool, a zero total supply, or a reserve that has not been initialized yet. ' +
        'Guard the denominator before dividing rather than relying on it being non-zero.'
      );
    case 'index-out-of-bounds':
      return (
        'The program indexed past the end of a slice or vector. Common causes are reading a ' +
        'remaining-accounts entry the client did not pass, indexing a deserialized collection ' +
        'that came back empty, or an off-by-one in a loop bound. Check the length before ' +
        'indexing, or use get() and handle the None case.'
      );
    case 'slice-out-of-range':
      return (
        'A slice range fell outside the data it was taken from. This is usually account data ' +
        'that is shorter than the layout the program assumed — a wrong account passed in, or an ' +
        'account created with too little space. Validate the data length before slicing.'
      );
    case 'unwrap-none':
      return (
        'The program called unwrap() on a None. Something the code treated as guaranteed was ' +
        'absent: an optional account, a map lookup, or a checked arithmetic result that ' +
        'overflowed and returned None. Replace the unwrap with an explicit error so the failure ' +
        'names the condition instead of panicking.'
      );
    case 'unwrap-err':
      return (
        'The program called unwrap() on an Err. The inner error is in the panic message above; ' +
        'it is usually a deserialization failure on an account whose contents did not match the ' +
        'expected type. Propagate the error with ? rather than unwrapping it.'
      );
    case 'explicit-panic':
      return (
        'The program panicked deliberately, through an assertion or an unreachable branch. The ' +
        'message states the invariant that did not hold.'
      );
    case 'unclassified':
      return (
        'The program panicked. The message and source location above come from the runtime ' +
        'directly; the panic text is not one of the standard-library forms this tool recognizes.'
      );
  }
}
