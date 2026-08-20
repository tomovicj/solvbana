import type { Deployment } from './deployment.ts';
import type { VerificationOutcome } from './verified.ts';

/** What was learned about the program's published interface. */
export interface IdlSummary {
  address: string;
  programName: string;
  /** `null` for the pre-0.30 layout, which carries no `metadata.spec`. */
  spec: string | null;
  declaredErrors: number;
  handlers: number;
}

/**
 * Everything source resolution established about the failing program.
 *
 * Attached to a `Finding` rather than replacing any of it: Phase 1's reading of
 * the logs stands on its own, and this either names something the logs left
 * undecoded or explains why it could not.
 */
export interface Resolution {
  programId: string;
  deployment: Deployment;
  /** Absent when the deployment check stopped the cascade before an IDL was fetched. */
  idl: IdlSummary | null;
  verification: VerificationOutcome | null;
  /**
   * Why this resolution is worth what it is, in the same spirit as
   * `Diagnosis.reasons` — every refusal explains itself where it happened.
   */
  notes: string[];
}
