/**
 * Every diagnosis carries a confidence level. This is not a display concern —
 * a location without a confidence level is not a valid result.
 *
 * Ordered weakest to strongest, which is the order `rank` and `weakest` rely on.
 */
export const CONFIDENCE_LEVELS = ['unknown', 'variant-only', 'narrowed', 'exact'] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Position in {@link CONFIDENCE_LEVELS}. Higher is stronger. */
export function rank(confidence: Confidence): number {
  return CONFIDENCE_LEVELS.indexOf(confidence);
}

export function isAtLeast(confidence: Confidence, floor: Confidence): boolean {
  return rank(confidence) >= rank(floor);
}

/**
 * The weaker of two levels.
 *
 * Missing information degrades a diagnosis rather than aborting it: an
 * unresolvable historical binary or an unverified build caps how strong the
 * answer may claim to be, it does not throw. Combining evidence therefore
 * always takes the floor, never the ceiling.
 */
export function weakest(a: Confidence, b: Confidence): Confidence {
  return rank(a) <= rank(b) ? a : b;
}

/** Cap `current` at `ceiling`, returning the capped level unchanged if already weaker. */
export function capAt(current: Confidence, ceiling: Confidence): Confidence {
  return weakest(current, ceiling);
}
