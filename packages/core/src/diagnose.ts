import { unknownDiagnosis, type Diagnosis } from './diagnosis.ts';
import { describeTransactionError, failingInstructionIndex } from './ingest/error.ts';
import { normalizeTransaction } from './ingest/normalize.ts';
import type { FailedTransaction } from './ingest/types.ts';
import { explainNotFound } from './rpc/client.ts';
import type { TransactionSource } from './rpc/source.ts';

export interface DiagnoseDeps {
  source: TransactionSource;
}

/**
 * One-line statement of what failed, built from whatever ingest established.
 *
 * Phase 0 has the failing instruction and the raw error variant but no IDL, so
 * `Custom(6001)` stays a number here. Naming it is Phase 2's job.
 */
function summarize(transaction: FailedTransaction): string {
  const { error, instructions } = transaction;
  const description = describeTransactionError(error);
  const index = failingInstructionIndex(error);

  if (index === null) {
    return `Transaction failed with ${description}.`;
  }

  const node = instructions[index];
  const total = instructions.length;
  const program = node?.programId ?? 'an unresolved program';

  return (
    `Instruction ${String(index + 1)} of ${String(total)} failed in ${program} ` +
    `with ${description}.`
  );
}

/**
 * Entry point for the tier cascade.
 *
 * Phase 0 (ingest & normalize) is implemented: the transaction is fetched and
 * turned into a typed structure naming the failing instruction, its error, and
 * the log stream around it. Confidence stays `unknown` because decoding
 * `Custom(6001)` as a number is short of even `variant-only` — that needs the
 * IDL's variant name and `#[msg]` text, which arrives in Phase 2.
 *
 * The contract every later tier has to honour is visible here: always answer,
 * never throw for an undiagnosable input, and always say what the answer is
 * worth and why.
 */
export async function diagnose(signature: string, deps: DiagnoseDeps): Promise<Diagnosis> {
  const outcome = await deps.source.fetchTransaction(signature);

  if (outcome.kind === 'rpc-error') {
    return unknownDiagnosis(
      signature,
      'The transaction could not be fetched.',
      `${outcome.message} No diagnosis is possible without the transaction record.`,
    );
  }

  if (outcome.kind === 'not-found') {
    return unknownDiagnosis(
      signature,
      'No transaction record was found for this signature.',
      explainNotFound(outcome.reason),
    );
  }

  const transaction = normalizeTransaction(outcome.raw, signature);

  return {
    signature,
    confidence: 'unknown',
    summary: summarize(transaction),
    candidates: [],
    reasons: [
      'Ingest only: the error variant is decoded but not yet named, and no source has been ' +
        'resolved, so no throw site can be located yet.',
      ...(outcome.endpoint === 'archive'
        ? ['Retrieved from the archive endpoint; the primary endpoint no longer retains it.']
        : []),
      ...transaction.degradations,
    ],
    transaction,
  };
}
