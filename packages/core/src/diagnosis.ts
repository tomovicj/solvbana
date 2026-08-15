import type { Confidence } from './confidence.ts';

/** A position in a program's source tree. */
export interface SourceLocation {
  /** Repository-relative path, e.g. `programs/my-prog/src/instructions/withdraw.rs`. */
  file: string;
  line: number;
  column?: number;
}

/**
 * One surviving candidate throw site after narrowing.
 *
 * `rationale` is required on purpose: a candidate the tool cannot justify is a
 * guess, and guesses do not go in the output.
 */
export interface CandidateSite {
  location: SourceLocation;
  /** 1-based rank within the candidate set. Rank 1 is the strongest candidate, not the answer. */
  rank: number;
  rationale: string;
}

/**
 * The result type every tier produces.
 *
 * Two invariants are enforced by the shape rather than by discipline:
 *
 * - `confidence` is required and non-optional, so no code path can emit a
 *   location without saying how much to trust it.
 * - `candidates` is always a list. When narrowing leaves more than one site
 *   alive, all of them are reported; nothing collapses a set to its top entry.
 */
export interface Diagnosis {
  signature: string;
  confidence: Confidence;
  /** One-line statement of what failed. Always present, even at `unknown`. */
  summary: string;
  /** Ranked candidate sites. Empty when nothing was located. */
  candidates: CandidateSite[];
  /**
   * Why the confidence is what it is. Every downgrade appends its reason here,
   * so a weak answer always explains itself instead of going quiet.
   */
  reasons: string[];
}

/**
 * The honest answer when nothing has been resolved yet.
 *
 * Degrading in tiers means there is always something to return — an opaque
 * failure is reported as opaque, not as an error or an empty body.
 */
export function unknownDiagnosis(signature: string, summary: string, reason: string): Diagnosis {
  return {
    signature,
    confidence: 'unknown',
    summary,
    candidates: [],
    reasons: [reason],
  };
}
