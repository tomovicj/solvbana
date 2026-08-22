import { analyze, type Analysis } from './analyze/analyze.ts';
import type { Finding } from './analyze/types.ts';
import { unknownDiagnosis, type Diagnosis } from './diagnosis.ts';
import { describeTransactionError, failingInstructionIndex } from './ingest/error.ts';
import { normalizeTransaction } from './ingest/normalize.ts';
import type { FailedTransaction } from './ingest/types.ts';
import { explainFailure } from './explain/explain.ts';
import type { Explanation } from './explain/types.ts';
import type { ResolvedIdl } from './resolve/idl.ts';
import { refineWithResolution } from './resolve/refine.ts';
import { resolveProgram, type ResolveOptions } from './resolve/resolve.ts';
import { explainNotFound } from './rpc/client.ts';
import type { AccountSource, ArtifactStore, TransactionSource } from './rpc/source.ts';
import { walkInstructions } from './ingest/instructions.ts';
import { decodeBase58 } from './signature.ts';

export interface DiagnoseDeps {
  source: TransactionSource;
  /**
   * Account reads for source resolution.
   *
   * Optional so a caller with only a recorded transaction still gets the full
   * log-derived answer. Its absence degrades the result rather than failing it,
   * which is the same contract every other missing input has here.
   */
  accounts?: AccountSource | undefined;
  /**
   * Uploaded IDLs, for the programs that publish none of their own.
   *
   * Optional like every other input here: without it a diagnosis is whatever
   * chain state alone establishes, which for roughly 94% of failing programs
   * means an error code that stays a number.
   */
  artifacts?: ArtifactStore | undefined;
  resolve?: ResolveOptions | undefined;
}

/**
 * The discriminators this transaction actually used against a program.
 *
 * An uploaded IDL has to match one of these before anything is read from it, so
 * this is the evidence that turns a file somebody sent into a document about
 * this program. Collected across every instruction addressed to it, because the
 * failing one may be reached by CPI.
 */
function observedDiscriminators(transaction: FailedTransaction, programId: string): string[] {
  const seen = new Set<string>();

  for (const node of walkInstructions(transaction.instructions)) {
    if (node.programId !== programId) continue;
    const data = decodeBase58(node.data);
    if (data === null || data.length < 8) continue;
    seen.add(Buffer.from(data.subarray(0, 8)).toString('hex'));
  }

  return [...seen];
}

/**
 * Resolve the failing program, and fold what that establishes into the finding.
 *
 * Runs whenever an account source is available, not only when the logs left a
 * code undecoded. Phase 2 could skip it for an already-named error because the
 * only thing it produced was a name; the explanation layer reads the IDL for
 * account names, argument types and declared PDA seeds, all of which are worth
 * having even when the error named itself. The cost is three prefix reads,
 * cached per program and deployment, with the expensive verified-build path
 * still opt-in.
 *
 * Strictly additive, as before: an error the program printed about itself is
 * never re-decided by an IDL that may be a deployment behind.
 */
async function withResolution(
  analysis: Analysis,
  transaction: FailedTransaction,
  deps: DiagnoseDeps,
): Promise<{ analysis: Analysis; idl: ResolvedIdl | null }> {
  const { accounts } = deps;
  const programId = analysis.finding.program;

  if (accounts === undefined || programId === null) return { analysis, idl: null };

  try {
    const resolved = await resolveProgram(
      programId,
      transaction.slot,
      { accounts, artifacts: deps.artifacts },
      { ...deps.resolve, observedDiscriminators: observedDiscriminators(transaction, programId) },
    );
    return { analysis: refineWithResolution(analysis, transaction, resolved), idl: resolved.idl };
  } catch (error) {
    // Resolution is an enrichment. A failure here must not lose the log-derived
    // answer that was already established without it.
    return {
      analysis: {
        ...analysis,
        reasons: [
          ...analysis.reasons,
          `Source resolution failed and was skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
      idl: null,
    };
  }
}

/**
 * Build the explanation, or degrade to none.
 *
 * Held to the same contract as resolution: it is an enrichment, and a failure
 * here appends a reason rather than losing the diagnosis that was already
 * established. It cannot change confidence or candidates by construction, since
 * it returns neither.
 */
async function withExplanation(
  transaction: FailedTransaction,
  analysis: Analysis,
  idl: ResolvedIdl | null,
): Promise<{ explanation: Explanation | undefined; reason: string | null }> {
  try {
    return { explanation: await explainFailure(transaction, analysis.finding, idl), reason: null };
  } catch (error) {
    return {
      explanation: undefined,
      reason: `The explanation could not be built and was skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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
  const { analysis, idl } = await withResolution(analyze(transaction), transaction, deps);
  const { explanation, reason } = await withExplanation(transaction, analysis, idl);

  return {
    signature,
    confidence: analysis.confidence,
    summary: summarize(transaction, analysis.finding),
    candidates: analysis.candidates,
    reasons: [
      ...analysis.reasons,
      ...(reason === null ? [] : [reason]),
      ...(outcome.endpoint === 'archive'
        ? ['Retrieved from the archive endpoint; the primary endpoint no longer retains it.']
        : []),
      ...transaction.degradations,
    ],
    transaction,
    finding: analysis.finding,
    ...(explanation === undefined ? {} : { explanation }),
  };
}
