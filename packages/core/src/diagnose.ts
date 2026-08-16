import { analyze } from './analyze/analyze.ts';
import type { Finding } from './analyze/types.ts';
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
 * How the failure is named in one line.
 *
 * Prefers the name the program published over the raw code, since `Custom(6040)`
 * and `BuySlippageBelowMinBaseAmountOut (6040)` carry very different amounts of
 * information for the same number of characters.
 */
function describeFailure(transaction: FailedTransaction, finding: Finding): string {
  const { name, code } = finding.error;
  if (name === null) return describeTransactionError(transaction.error);
  return code === null ? name : `${name} (${String(code)})`;
}

/**
 * One-line statement of what failed.
 *
 * The program named is the one that *originated* the failure, which for a CPI is
 * not the program the failing top-level instruction addresses. Naming the outer
 * program would point the reader at code that only passed the error along.
 */
function summarize(transaction: FailedTransaction, finding: Finding): string {
  const { instructions } = transaction;
  const description = describeFailure(transaction, finding);
  const index = failingInstructionIndex(transaction.error);

  if (index === null) {
    return `Transaction failed with ${description}.`;
  }

  const program = finding.program ?? instructions[index]?.programId ?? 'an unresolved program';
  const handler = finding.handler === null ? '' : ` (handler ${finding.handler})`;

  return (
    `Instruction ${String(index + 1)} of ${String(instructions.length)} failed in ` +
    `${program}${handler} with ${description}.`
  );
}

/**
 * Entry point for the tier cascade.
 *
 * Phase 0 (ingest) and Phase 1 (log analysis) are implemented: the transaction is
 * fetched, normalized, and read for everything its own logs disclose — panics and
 * Anchor throw sites with a file and line, Anchor variant names and `#[msg]` text,
 * compute exhaustion, and the runtime's own error classifications. Nothing here
 * fetches source or an IDL; that is Phase 2.
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
  const analysis = analyze(transaction);

  return {
    signature,
    confidence: analysis.confidence,
    summary: summarize(transaction, analysis.finding),
    candidates: analysis.candidates,
    reasons: [
      ...analysis.reasons,
      ...(outcome.endpoint === 'archive'
        ? ['Retrieved from the archive endpoint; the primary endpoint no longer retains it.']
        : []),
      ...transaction.degradations,
    ],
    transaction,
    finding: analysis.finding,
  };
}
