import type { LogLine } from '../ingest/types.ts';
import type { Frame } from './frames.ts';
import type { Comparison } from './types.ts';

/**
 * The tail every `AnchorError` line ends with, whichever prefix precedes it.
 *
 * The message runs to the end of the line and may itself contain periods, so it
 * is captured greedily rather than up to the next `. `.
 */
const ANCHOR_TAIL = /Error Code: (\S+?)\. Error Number: (\d+)\. Error Message: ([\s\S]*?)\.?$/
  .source;

/** `AnchorError thrown in <file>:<line>. …` — the program reporting its own throw site. */
const THROWN = new RegExp(`^AnchorError thrown in (.+?):(\\d+)\\. ${ANCHOR_TAIL}`);

/** `AnchorError caused by account: <field>. …` — account validation and `#[account(...)]` constraints. */
const CAUSED_BY = new RegExp(`^AnchorError caused by account: (\\S+?)\\. ${ANCHOR_TAIL}`);

/** `AnchorError occurred. …` — neither a site nor an account was available. */
const OCCURRED = new RegExp(`^AnchorError occurred\\. ${ANCHOR_TAIL}`);

/** Anchor's per-handler prologue, emitted once on entry to a generated dispatcher. */
const HANDLER = /^Instruction: (\S+)$/;

const OPERAND = /^(Left|Right):(?: (.*))?$/;

export interface AnchorError {
  name: string;
  number: number;
  message: string;
  /** Set by the `thrown in` form only. Anchor reports a file and line, never a column. */
  site: { file: string; line: number } | null;
  /** Set by the `caused by account` form only. */
  account: string | null;
}

function fromTail(
  match: RegExpExecArray,
  offset: number,
): Pick<AnchorError, 'name' | 'number' | 'message'> {
  return {
    name: match[offset]!,
    number: Number(match[offset + 1]),
    message: match[offset + 2]!,
  };
}

/**
 * Parse one `Program log:` message body as an Anchor error, if it is one.
 *
 * All three forms carry the variant name, the numeric code, and the `#[msg]`
 * text, which is why Phase 1 needs no IDL to name an Anchor error. The forms
 * differ only in what they can say about *where*: `thrown in` gives a source
 * location, `caused by account` gives a field in the accounts struct, and
 * `occurred` gives neither.
 */
export function parseAnchorError(message: string): AnchorError | null {
  const thrown = THROWN.exec(message);
  if (thrown) {
    return {
      ...fromTail(thrown, 3),
      site: { file: thrown[1]!, line: Number(thrown[2]) },
      account: null,
    };
  }

  const causedBy = CAUSED_BY.exec(message);
  if (causedBy) {
    return { ...fromTail(causedBy, 2), site: null, account: causedBy[1]! };
  }

  const occurred = OCCURRED.exec(message);
  if (occurred) {
    return { ...fromTail(occurred, 1), site: null, account: null };
  }

  return null;
}

/** Message bodies of a frame's own `Program log:` lines, in emission order. */
function logMessages(frame: Frame): { line: LogLine; message: string }[] {
  return frame.lines.flatMap((line) =>
    line.event.kind === 'log' ? [{ line, message: line.event.message }] : [],
  );
}

/**
 * The Anchor error a frame reported, if any.
 *
 * Scoped to one frame's own lines rather than searched across the whole stream:
 * a caller that propagates a CPI's error does not re-log it, so a match found
 * outside the failing frame belongs to a different program.
 */
export function anchorErrorIn(frame: Frame): AnchorError | null {
  for (const { message } of logMessages(frame)) {
    const parsed = parseAnchorError(message);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * The handler name from Anchor's prologue, read from this frame only.
 *
 * Reading the last `Instruction:` line before the failure instead would attribute
 * a CPI callee's handler to the caller. In corpus signature `2WH1WJ5N…` the
 * failing program logs `Instruction: BuyExactQuoteIn`, then calls a fee program
 * that logs `Instruction: GetFees` and returns successfully, and only then does
 * the caller throw — so the unscoped read names a handler in a program that did
 * not fail.
 */
export function handlerIn(frame: Frame): string | null {
  for (const { message } of logMessages(frame)) {
    const match = HANDLER.exec(message);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * The `Left:` / `Right:` operand pair Anchor logs for a failed comparison.
 *
 * Two shapes occur, and both appear in the corpus. `require_gt!` and friends on
 * integers print the value inline:
 *
 * ```text
 * Program log: Left: 412250202354
 * Program log: Right: 428963556055
 * ```
 *
 * while pubkey comparisons print the label alone and the value on the next line:
 *
 * ```text
 * Program log: Left:
 * Program log: 11111111111111111111111111111111
 * ```
 *
 * Both operands must resolve for the pair to be reported. Half a comparison is
 * worse than none — it reads as a value the code expected without saying what it
 * was compared against.
 */
export function comparisonIn(frame: Frame): Comparison | null {
  const messages = logMessages(frame).map((entry) => entry.message);
  const operands: Partial<Comparison> = {};

  for (const [index, message] of messages.entries()) {
    const match = OPERAND.exec(message);
    if (!match) continue;

    const side = match[1] === 'Left' ? 'left' : 'right';
    const inline = match[2];

    if (inline !== undefined && inline !== '') {
      operands[side] = inline;
      continue;
    }

    // A bare label takes its value from the following line — unless that line is
    // the other label, which means this operand was logged empty.
    const next = messages[index + 1];
    if (next === undefined || OPERAND.test(next)) continue;
    operands[side] = next;
  }

  return operands.left !== undefined && operands.right !== undefined
    ? { left: operands.left, right: operands.right }
    : null;
}
