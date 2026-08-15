import { unknownDiagnosis, type Diagnosis } from './diagnosis.ts';

/**
 * Entry point for the tier cascade.
 *
 * Nothing is implemented yet — Phase 0 (ingest & normalize) lands here first,
 * then tiers 1 through 4 slot in cheapest-first. Until then this returns a real
 * `unknown` diagnosis rather than throwing or 501-ing, which is the same
 * contract every later tier has to honour: always answer, and always say how
 * much the answer is worth.
 */
export function diagnose(signature: string): Promise<Diagnosis> {
  return Promise.resolve(
    unknownDiagnosis(
      signature,
      'Diagnosis is not implemented yet.',
      'The transaction was not fetched: ingest (Phase 0) is not built, so no logs, ' +
        'instruction tree, or error kind are available.',
    ),
  );
}
