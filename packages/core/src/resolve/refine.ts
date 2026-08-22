import type { Analysis } from '../analyze/analyze.ts';
import type { DecodedError, Finding } from '../analyze/types.ts';
import type { Confidence } from '../confidence.ts';
import { walkInstructions } from '../ingest/instructions.ts';
import type { FailedTransaction } from '../ingest/types.ts';
import { decodeBase58 } from '../signature.ts';
import { anchorBuiltinFor, isAnchorReservedCode } from './anchor-codes.ts';
import { handlerForDiscriminator, type ResolvedIdl } from './idl.ts';
import type { ResolutionResult } from './resolve.ts';

/**
 * The handler the failing program ran, matched by discriminator.
 *
 * The failing program is often reached by CPI, and correlating a log frame to a
 * specific node in the instruction tree is Phase 3's job. So instead of guessing
 * at that correspondence, every node addressed to this program is checked and the
 * answer is only used when they all agree. Two nodes calling different handlers
 * of the same program leave the question genuinely open, and it is left open.
 */
function handlerByDiscriminator(
  transaction: FailedTransaction,
  programId: string,
  idl: ResolvedIdl,
): string | null {
  const names = new Set<string>();

  for (const node of walkInstructions(transaction.instructions)) {
    if (node.programId !== programId) continue;

    const data = decodeBase58(node.data);
    if (data === null || data.length < 8) continue;

    const handler = handlerForDiscriminator(idl, data);
    if (handler !== null) names.add(handler.name);
  }

  return names.size === 1 ? [...names][0]! : null;
}

/**
 * Name an error code the logs left undecoded.
 *
 * Two sources, both licensed by the same fetched IDL. A code at or above 6000 is
 * the program's own and must appear in `errors[]`; below that it belongs to
 * Anchor, and the IDL's existence is what establishes that Anchor's meanings
 * apply to this program at all.
 */
/** A decoded error that definitely carries a name — this only returns when it found one. */
type NamedError = DecodedError & { name: string };

function nameError(code: number, idl: ResolvedIdl): NamedError | null {
  const declared = idl.errors.get(code);
  if (declared !== undefined) {
    // The document says what this code means either way; where the document came
    // from is what the reader needs alongside the name.
    return {
      code,
      name: declared.name,
      message: declared.msg,
      naming: idl.provenance === 'supplied' ? 'supplied-idl' : 'idl',
    };
  }

  const builtin = anchorBuiltinFor(code, idl);
  if (builtin !== null) {
    return {
      code,
      name: builtin.name,
      message:
        builtin.family === 'require'
          ? 'A require! macro in the handler body evaluated to false.'
          : `An Anchor ${builtin.family} check failed.`,
      naming: 'anchor-builtin',
    };
  }

  return null;
}

/** Where a name came from, said plainly, because that is what it is worth. */
function explainNaming(
  code: number,
  name: string,
  naming: DecodedError['naming'],
  programName: string,
): string {
  if (naming === 'supplied-idl') {
    return (
      `Code ${String(code)} is declared as ${name} in an IDL uploaded for this program ` +
      `(${programName}), which matched the failing instruction's discriminator. The name is the ` +
      'uploaded document\u2019s claim about the program, not something read from chain.'
    );
  }
  if (naming === 'idl') {
    return `Code ${String(code)} is declared as ${name} in the IDL ${programName} publishes on chain.`;
  }
  return (
    `Code ${String(code)} is Anchor's built-in ${name}. The program publishes an IDL at its ` +
    'Anchor-derived address, which is what establishes that Anchor defines this code rather ' +
    'than the program itself.'
  );
}

function explainMiss(code: number, idl: ResolvedIdl): string {
  if (idl.provenance === 'supplied') {
    return (
      `Code ${String(code)} is not declared in the IDL uploaded for this program ` +
      `(${idl.programName}), and an uploaded IDL cannot license Anchor's built-in table the way ` +
      'one published on chain does. The code stays a number.'
    );
  }
  return isAnchorReservedCode(code)
    ? `Code ${String(code)} falls in a range Anchor reserves, but it is not a variant this ` +
        `version of the table knows and ${idl.programName} does not declare it either.`
    : `${idl.programName}'s IDL declares ${String(idl.errors.size)} errors and code ` +
        `${String(code)} is not among them. The deployed binary and the published IDL disagree, ` +
        'which usually means the IDL was not updated with the last upgrade.';
}

/**
 * Fold a resolution into the finding the logs produced.
 *
 * Strictly additive. Nothing Phase 1 read is overwritten — a name the program
 * printed itself outranks anything an IDL says about the same code, because the
 * IDL can be stale while the log line came from the binary that ran.
 *
 * Confidence may rise from `unknown` to `variant-only` and no further. This phase
 * resolves no source locations, so it cannot reach `exact`, and the invariant that
 * `exact` implies at least one candidate holds here without a special case.
 */
export function refineWithResolution(
  analysis: Analysis,
  transaction: FailedTransaction,
  resolved: ResolutionResult,
): Analysis {
  const { resolution, idl } = resolved;
  const finding: Finding = { ...analysis.finding, resolution };
  const reasons = [...analysis.reasons];
  let confidence: Confidence = analysis.confidence;

  if (idl === null) {
    return { ...analysis, finding, reasons, confidence };
  }

  if (finding.handler === null) {
    const handler = handlerByDiscriminator(transaction, resolution.programId, idl);
    if (handler !== null) {
      finding.handler = handler;
      finding.handlerSource = 'discriminator';
    }
  }

  const { code, naming } = finding.error;

  if (naming === 'none' && code !== null) {
    const named = nameError(code, idl);

    if (named === null) {
      reasons.push(explainMiss(code, idl));
    } else {
      finding.error = named;
      finding.explanation =
        named.message === null ? finding.explanation : `${named.name}: ${named.message}`;
      // Naming an error is not locating it: this lifts an undecoded answer to
      // `variant-only` and never touches one that already reads stronger.
      if (analysis.confidence === 'unknown') confidence = 'variant-only';
      reasons.unshift(explainNaming(code, named.name, named.naming, idl.programName));
    }
  }

  return { ...analysis, finding, reasons, confidence };
}
