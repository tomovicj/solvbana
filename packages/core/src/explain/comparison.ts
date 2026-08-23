import type { Comparison } from '../analyze/types.ts';
import type { AccountRow, ReadComparison } from './types.ts';

/**
 * Read the `Left:` / `Right:` pair Anchor printed, and work out what it shows.
 *
 * `analyze/anchor.ts` extracts the two operands; nothing until now interpreted
 * them. The interpretation that matters is which side the transaction *passed*
 * and which side the program *required*, because that is the difference between
 * "your client sent the wrong address" and "the program wanted something else".
 *
 * **Orientation is proven, never assumed.** Anchor emits the pair in a fixed
 * order in its own source, but that is a convention of one framework — the same
 * kind of thing as its reserved error-code ranges, which this project refuses to
 * decode. So the order is established from the record instead: if exactly one
 * operand is the address the blamed account actually holds, that operand is what
 * was passed and the other is what was required. When neither matches, or both
 * do, the pair is reported without roles.
 *
 * That refusal is not hypothetical. Of the six corpus fixtures carrying a
 * comparison, two prove their orientation this way, three are integer
 * comparisons where orientation is not needed, and one — a `ConstraintOwner`
 * blaming an account the IDL never names — has no row to match against at all.
 * An assumed ordering would have labelled that last one confidently with nothing
 * behind it, and account owners are not in the transaction record to check
 * against.
 */
export function readComparison(
  comparison: Comparison,
  blamed: string | null,
  accounts: readonly AccountRow[],
): ReadComparison {
  const { left, right } = comparison;
  const account = blamed === null ? null : (accounts.find((row) => row.name === blamed) ?? null);
  const address = account?.address ?? null;

  // Exactly one match, or no claim. Both sides matching would mean the operands
  // are equal, which proves nothing about which role each played.
  const matchesLeft = address !== null && address === left;
  const matchesRight = address !== null && address === right;
  const passed = matchesLeft === matchesRight ? null : matchesLeft ? 'left' : 'right';

  return { left, right, passed, account: address, numeric: numericGap(left, right) };
}

/** The side the program required, when the record proved which side that is. */
export function requiredSide(read: ReadComparison): string | null {
  if (read.passed === null) return null;
  return read.passed === 'left' ? read.right : read.left;
}

/** The side the transaction passed, when the record proved which side that is. */
export function passedSide(read: ReadComparison): string | null {
  if (read.passed === null) return null;
  return read.passed === 'left' ? read.left : read.right;
}

/**
 * The gap between two operands, when both are integers.
 *
 * Both or neither: half a numeric comparison says nothing, which is the same
 * rule `comparisonIn` already applies to half an operand pair. Parsed as
 * `bigint` because Anchor prints `u64` amounts that do not survive a `number`.
 */
function numericGap(left: string, right: string): ReadComparison['numeric'] {
  const a = asInteger(left);
  const b = asInteger(right);
  if (a === null || b === null) return null;

  const difference = a > b ? a - b : b - a;
  const larger = a > b ? a : b;
  const magnitude = larger < 0n ? -larger : larger;

  return {
    difference,
    equal: a === b,
    // Undefined against a zero denominator rather than reported as 0%, which
    // would read as "no difference" for a pair that may differ.
    relative: magnitude === 0n ? null : Number(difference) / Number(magnitude),
  };
}

/**
 * An operand as an integer, or `null` when it is not one.
 *
 * Deliberately strict: `BigInt()` accepts an empty string as zero and tolerates
 * surrounding whitespace, either of which would turn an operand that is not a
 * number into a confident zero.
 */
function asInteger(operand: string): bigint | null {
  if (!/^-?\d+$/.test(operand)) return null;
  return BigInt(operand);
}
