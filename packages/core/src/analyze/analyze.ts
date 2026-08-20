import type { Confidence } from '../confidence.ts';
import type { CandidateSite } from '../diagnosis.ts';
import type { FailedTransaction, InstructionError } from '../ingest/types.ts';
import { anchorErrorIn, comparisonIn, handlerIn, type AnchorError } from './anchor.ts';
import { computeFailureIn, explainCompute } from './compute.ts';
import { explainAnchor } from './explain.ts';
import { attributedFrame, buildFrames, type Frame } from './frames.ts';
import { explainRuntimeVariant, isNativeProgram, nativeError } from './native.ts';
import { explainPanic, panicIn } from './panic.ts';
import type { DecodedError, Finding, HandlerSource } from './types.ts';

/** The frame-derived fields every branch of the cascade shares. */
interface FindingBase {
  program: string | null;
  handler: string | null;
  handlerSource: HandlerSource | null;
}

export interface Analysis {
  finding: Finding;
  confidence: Confidence;
  candidates: CandidateSite[];
  /** Why the confidence is what it is. Never empty — a level always explains itself. */
  reasons: string[];
}

const UNDECODED: DecodedError = { code: null, name: null, message: null, naming: 'none' };

function instructionError(transaction: FailedTransaction): InstructionError | null {
  return transaction.error.kind === 'instruction-error' ? transaction.error.error : null;
}

function customCode(error: InstructionError | null): number | null {
  return error?.kind === 'custom' ? error.code : null;
}

function site(
  location: { file: string; line: number; column?: number },
  rationale: string,
): CandidateSite[] {
  return [{ location, rank: 1, rationale }];
}

/**
 * Read a failed transaction's logs for everything they say on their own.
 *
 * The detectors run cheapest-and-most-specific first and the cascade stops at the
 * first one that answers, because the categories overlap in `meta.err`: a panic,
 * a compute exhaustion, and a memory violation all surface as
 * `ProgramFailedToComplete`, and only the log lines tell them apart.
 *
 * Two rules govern what may be claimed:
 *
 * - `exact` requires a source location. An account-attributed Anchor error is
 *   read rather than inferred and is still capped at `variant-only`, because it
 *   locates a field in an accounts struct, not a line. That keeps `exact` a
 *   checkable promise: it never appears without a candidate.
 * - Nothing is named from an error code alone. Anchor's reserved ranges are one
 *   framework's convention and any program may return any code, so a `Custom(n)`
 *   the program did not name stays a number until Phase 2 resolves an IDL.
 */
export function analyze(transaction: FailedTransaction): Analysis {
  const { logs, instructions } = transaction;
  const frames = buildFrames(logs);
  const frame = attributedFrame(frames);
  const program = frame?.programId ?? null;
  const handler = frame === null ? null : handlerIn(frame);
  const code = customCode(instructionError(transaction));

  const base = { program, handler, handlerSource: handler === null ? null : ('logged' as const) };

  // Absent logs leave no frames, so the log detectors below are skipped rather
  // than special-cased. What `meta.err` names on its own is still reported: the
  // leanest tier still has an error kind and an instruction index, and dropping
  // the runtime's own classification just because the logs were off would be a
  // blank failure rather than a degraded one.
  if (frame !== null) {
    const panic = panicIn(frame);
    if (panic !== null) {
      return {
        finding: {
          ...base,
          error: runtimeNaming(transaction) ?? UNDECODED,
          failure: { kind: 'panic', ...panic },
          explanation: explainPanic(panic),
        },
        confidence: 'exact',
        candidates: site(
          panic.site,
          'The runtime printed this location in the panic message itself; it is read, not inferred.',
        ),
        reasons: [
          'The panic message carries a file, line, and column emitted by the program at runtime, ' +
            'so the throw site is exact without any source resolution.',
        ],
      };
    }

    const anchor = anchorErrorIn(frame);
    if (anchor !== null) return fromAnchor(base, frame, anchor, code);

    const compute = computeFailureIn(frame, instructions);
    if (compute !== null) {
      return {
        finding: {
          ...base,
          error: runtimeNaming(transaction) ?? UNDECODED,
          failure: { kind: 'compute', ...compute },
          explanation: explainCompute(compute, program),
        },
        confidence: 'variant-only',
        candidates: [],
        reasons: [
          'Compute exhaustion stops a program between instructions rather than at a throw site, ' +
            'so there is no line to report — the program did not fail anywhere in particular, it ' +
            'ran out of room to continue.',
        ],
      };
    }

    // Requires a frame that actually reported a failure: on an unterminated
    // frame we never saw which program errored, so keying a table lookup on its
    // address would attribute one program's error code to another.
    const native =
      code === null || frame.outcome !== 'failed' || !isNativeProgram(program)
        ? null
        : nativeError(program, code);
    if (native !== null && code !== null && program !== null) {
      return {
        finding: {
          ...base,
          error: { code, name: native.name, message: native.message, naming: 'native-table' },
          failure: { kind: 'native', programId: program },
          explanation: native.message,
        },
        confidence: 'variant-only',
        candidates: [],
        reasons: [
          `Code ${String(code)} was resolved against the published error enum of ${program}, ` +
            'whose address is fixed and whose error table ships with the runtime. No source has ' +
            'been resolved, so no line can be reported.',
        ],
      };
    }
  }

  const noLogs = logs.absent
    ? [
        'The transaction was recorded without logs, so nothing beyond meta.err was available to ' +
          'read. Every signal this tier uses — panic locations, Anchor error text, compute ' +
          'figures — lives in the log stream.',
      ]
    : [];

  const runtime = runtimeNaming(transaction);
  if (runtime !== null) {
    return {
      finding: {
        ...base,
        error: runtime,
        failure: { kind: 'runtime', variant: runtime.name },
        explanation: runtime.message ?? `The runtime reported ${runtime.name}.`,
      },
      confidence: 'variant-only',
      candidates: [],
      reasons: [
        `${runtime.name} is the runtime's own classification of the failure, so the kind of ` +
          'error is certain. It says nothing about where in the program the failure arose.',
        ...noLogs,
      ],
    };
  }

  return blank(base, code, undecodedReason(code, program, logs.truncated), noLogs);
}

/** The runtime's own `InstructionError` variant name, when `meta.err` carried one. */
function runtimeNaming(transaction: FailedTransaction): (DecodedError & { name: string }) | null {
  const error = instructionError(transaction);
  if (error?.kind !== 'named') return null;
  return {
    code: null,
    name: error.name,
    message: explainRuntimeVariant(error.name),
    naming: 'runtime-variant',
  };
}

function fromAnchor(
  base: FindingBase,
  frame: Frame,
  anchor: AnchorError,
  code: number | null,
): Analysis {
  const comparison = comparisonIn(frame);
  const decoded: DecodedError = {
    code: anchor.number,
    name: anchor.name,
    message: anchor.message,
    naming: 'logged',
  };

  const reasons: string[] = [];

  // A logged code that disagrees with meta.err means the line found in this frame
  // is not the error that propagated — worth saying rather than quietly trusting.
  if (code !== null && code !== anchor.number) {
    reasons.push(
      `The program logged error ${String(anchor.number)} but the transaction failed with ` +
        `${String(code)}. The logged error was raised inside the failing frame; the code that ` +
        'reached the top level differs, so one of them was remapped on the way out.',
    );
  }

  const finding: Finding = {
    ...base,
    error: decoded,
    failure: {
      kind: 'anchor',
      account: anchor.account,
      site: anchor.site === null ? null : { file: anchor.site.file, line: anchor.site.line },
      comparison,
    },
    explanation: explainAnchor(anchor, comparison),
  };

  if (anchor.site !== null) {
    return {
      finding,
      confidence: 'exact',
      candidates: site(
        { file: anchor.site.file, line: anchor.site.line },
        'Anchor printed this file and line in the error itself, so the throw site is read from ' +
          'the program rather than inferred. The path is as it appeared in the build that ran.',
      ),
      reasons: [
        'Anchor reported the source location, the variant name, and the #[msg] text directly in ' +
          'the logs, so no IDL or source fetch was needed.',
        ...reasons,
      ],
    };
  }

  return {
    finding,
    confidence: 'variant-only',
    candidates: [],
    reasons: [
      anchor.account === null
        ? 'Anchor named the error and its message but reported neither a source location nor an ' +
          'account, so the failure is identified without being located.'
        : `Anchor attributed the failure to the \`${anchor.account}\` account exactly, but that ` +
          'is a field in the accounts struct rather than a line of code. Locating the constraint ' +
          'itself needs the source, which Phase 2 resolves.',
      ...reasons,
    ],
  };
}

function blank(
  base: FindingBase,
  code: number | null,
  reason: string,
  extra: string[] = [],
): Analysis {
  return {
    finding: {
      ...base,
      error: code === null ? UNDECODED : { ...UNDECODED, code },
      failure: { kind: 'undecoded' },
      explanation:
        'The transaction record does not say what went wrong beyond the error the runtime ' +
        "reported. Naming the error needs the program's IDL, which Phase 2 resolves.",
    },
    confidence: 'unknown',
    candidates: [],
    reasons: [reason, ...extra],
  };
}

/**
 * Why nothing could be decoded — stated in terms of what was actually missing.
 *
 * The `Custom(n)` case is the one worth being careful about. The code is often in
 * a range some framework reserves, and naming it from that range would produce a
 * confident answer with nothing behind it, so the refusal is explicit rather than
 * silent.
 */
function undecodedReason(code: number | null, program: string | null, truncated: boolean): string {
  const tail = truncated
    ? ' The logs were also truncated at the 10KB cap, so any error text the program printed ' +
      'after that point is not in the record.'
    : '';

  if (code === null) {
    return (
      'The failure produced no error text this tier can read: no panic, no Anchor error, and no ' +
      'runtime variant to name.' +
      tail
    );
  }

  const source = program === null ? 'The program' : program;
  return (
    `${source} returned error code ${String(code)} without publishing a name for it in the logs, ` +
    "and no IDL has been resolved. The code is not decoded here: error codes are a program's own " +
    "to define, so mapping this one through any framework's reserved ranges would name it on the " +
    'strength of a convention this program never claimed to follow.' +
    tail
  );
}
