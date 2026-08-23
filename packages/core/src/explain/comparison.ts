import type { Comparison } from '../analyze/types.ts';
import type { AccountRow, DecodedArg, ReadComparison } from './types.ts';

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
 * decode. So the order is established from the record instead, by either of two
 * independent matches:
 *
 * 1. **An address.** If exactly one operand is the address the blamed account
 *    actually holds, that operand is what was passed.
 * 2. **An argument.** If exactly one decoded instruction argument carries an
 *    operand's value, that operand is a value the client encoded and therefore
 *    the side it supplied. This is what gives a *numeric* comparison an
 *    orientation, where there is no address to match against.
 *
 * When neither fires the pair is reported without roles, and when both fire and
 * disagree it is too — see `orientation`.
 *
 * That refusal is not hypothetical. Of the six corpus fixtures carrying a
 * comparison, two prove their orientation by address and one — a
 * `ConstraintOwner` blaming an account the IDL never names — has no row to match
 * against at all. An assumed ordering would have labelled that last one
 * confidently with nothing behind it, and account owners are not in the
 * transaction record to check against.
 */
export function readComparison(
  comparison: Comparison,
  blamed: string | null,
  accounts: readonly AccountRow[],
  args: readonly DecodedArg[] = [],
): ReadComparison {
  const { left, right } = comparison;
  const account = blamed === null ? null : (accounts.find((row) => row.name === blamed) ?? null);
  const address = account?.address ?? null;

  // Exactly one match, or no claim. Both sides matching would mean the operands
  // are equal, which proves nothing about which role each played.
  const matchesLeft = address !== null && address === left;
  const matchesRight = address !== null && address === right;
  const byAddress = matchesLeft === matchesRight ? null : matchesLeft ? 'left' : 'right';

  const argument = matchArgument(left, right, args);

  return {
    left,
    right,
    passed: orientation(byAddress, argument),
    account: address,
    argument,
    numeric: numericGap(left, right),
  };
}

/**
 * Which side the transaction supplied, from whichever proof settled it.
 *
 * The two proofs are independent — one matches an operand against an account's
 * recorded address, the other against a value the client encoded into the
 * instruction data — so where both fire they are a cross-check rather than a
 * ranking. Agreement confirms; disagreement means one of them is wrong about
 * this transaction, and there is no basis for choosing which, so the answer
 * goes back to unproven.
 */
function orientation(
  byAddress: 'left' | 'right' | null,
  argument: ReadComparison['argument'],
): 'left' | 'right' | null {
  const byArgument = argument?.side ?? null;
  if (byAddress === null) return byArgument;
  if (byArgument === null || byArgument === byAddress) return byAddress;
  return null;
}

/**
 * The instruction argument whose value an operand carried.
 *
 * A value the client encoded into the instruction data and that then appears as
 * an operand is a value the client supplied, which is what makes this evidence
 * rather than coincidence — but only when one argument is responsible. Two
 * arguments holding the same number name none of them, so that refuses.
 *
 * Two claims come out of this and they are kept apart. Which argument a value
 * came from is settled by a single matching argument. Which *side* the client
 * supplied is settled only if that argument also matches one operand rather than
 * both, which an equal pair never does — hence a nullable `side`.
 */
function matchArgument(
  left: string,
  right: string,
  args: readonly DecodedArg[],
): ReadComparison['argument'] {
  const matched = args.flatMap((arg) => {
    const value = arg.value;
    if (value === null) return [];
    const onLeft = sameValue(value, left);
    const onRight = sameValue(value, right);
    if (!onLeft && !onRight) return [];
    return [{ name: arg.name, side: onLeft && onRight ? null : onLeft ? 'left' : 'right' }];
  }) as { name: string; side: 'left' | 'right' | null }[];

  return matched.length === 1 ? matched[0]! : null;
}

/**
 * Whether a decoded argument and an operand are the same value.
 *
 * Compared as integers where both are, so a formatting difference between how
 * `decodeArgs` renders a `u64` and how the program printed it cannot silently
 * break the match. Falls back to exact text for everything else.
 */
function sameValue(argument: string, operand: string): boolean {
  const a = asInteger(argument);
  const b = asInteger(operand);
  return a !== null && b !== null ? a === b : argument === operand;
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
