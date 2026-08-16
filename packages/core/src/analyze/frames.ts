import type { LogLine, LogStream } from '../ingest/types.ts';

/** How a program frame ended. */
export type FrameOutcome = 'success' | 'failed' | 'unterminated';

/**
 * One program invocation, reconstructed from the log stream.
 *
 * A frame corresponds to a single `Program <id> invoke [<depth>]` and everything
 * up to its matching `success` or `failed` line. CPI children get their own
 * frames rather than being folded into the caller's.
 */
export interface Frame {
  /** Position in the returned list, in `invoke` order. Stable identifier for a frame. */
  index: number;
  programId: string;
  /** The `[n]` from the invoke line: `1` for a top-level instruction, `2` for a direct CPI. */
  depth: number;
  /** Index of the frame that invoked this one, or `null` for a top-level invocation. */
  parent: number | null;
  /** The top-level instruction this frame ran under, as attributed by `parseLogs`. */
  outerIndex: number | null;
  /** Position in `meta.logMessages` of this frame's `invoke` line. */
  openedAt: number;
  /** Position of the closing `success` / `failed` line, or `null` if it never closed. */
  closedAt: number | null;
  /**
   * Lines emitted *directly* in this frame — its own `msg!` output and error
   * lines, excluding everything its CPI children emitted.
   *
   * This scoping is the whole reason frames exist. Anchor's `Program log:
   * Instruction: <Handler>` prologue appears once per Anchor frame, so reading
   * "the last one before the failure" picks up a handler from whichever program
   * happened to be called most recently — a different program's handler name,
   * reported as the failing one.
   */
  lines: LogLine[];
  /** From `consumed N of M compute units`. `null` when the frame never reported. */
  consumed: number | null;
  budget: number | null;
  outcome: FrameOutcome;
  /** The text after `failed: `, e.g. `custom program error: 0x1798`. */
  failureReason: string | null;
}

/**
 * Rebuild the frame stack from the tokenized log stream.
 *
 * The runtime's `invoke` / `success` / `failed` lines are a well-formed bracket
 * sequence in emission order, so a stack is enough — no correlation against the
 * instruction tree is needed, and none is attempted. Matching individual frames
 * to specific `InstructionNode`s is Phase 3's problem.
 *
 * Frames are left `unterminated` when the log ends without closing them, which
 * is what truncation looks like from here. Treating an unterminated frame as
 * successful would report a program as having completed when the record simply
 * stops, so the state is kept distinct.
 */
export function buildFrames(logs: LogStream): Frame[] {
  const frames: Frame[] = [];
  const open: number[] = [];

  const current = (): Frame | undefined => {
    const top = open.at(-1);
    return top === undefined ? undefined : frames[top];
  };

  for (const line of logs.lines) {
    const { event } = line;

    if (event.kind === 'invoke') {
      const parent = open.at(-1);
      frames.push({
        index: frames.length,
        programId: event.programId,
        depth: event.depth,
        parent: parent ?? null,
        outerIndex: line.outerIndex,
        openedAt: line.index,
        closedAt: null,
        lines: [],
        consumed: null,
        budget: null,
        outcome: 'unterminated',
        failureReason: null,
      });
      open.push(frames.length - 1);
      continue;
    }

    const frame = current();

    // Runtime-level lines emitted outside any invocation have no frame to hold
    // them; they remain in `logs.lines` for anything that wants them raw.
    if (frame === undefined) continue;

    if (event.kind === 'consumed') {
      // The runtime emits the consumption line for the frame that is closing,
      // which is the one on top of the stack.
      frame.consumed = event.units;
      frame.budget = event.budget;
      continue;
    }

    if (event.kind === 'success' || event.kind === 'failed') {
      frame.outcome = event.kind;
      frame.failureReason = event.kind === 'failed' ? event.reason : null;
      frame.closedAt = line.index;
      open.pop();
      continue;
    }

    frame.lines.push(line);
  }

  return frames;
}

/**
 * The frame that originated the failure.
 *
 * A CPI failure logs the innermost program's `failed:` line first and then each
 * caller's on the way out, so the *earliest* closing `failed` line names the
 * program that actually errored rather than one that merely propagated it.
 *
 * Ordering is by `closedAt`, not by depth or by invoke order: a caller can be
 * deeper than the failing frame's sibling, and frames are returned in invoke
 * order, which is not the order they closed in.
 *
 * Known limitation: a program that invokes a CPI, sees it fail, handles the
 * error, and then fails later for an unrelated reason still logs the handled
 * failure first, so it is reported as the origin. Nothing in the log stream
 * distinguishes a handled CPI error from a propagated one — the runtime logs
 * both identically — so the alternative would be a guess rather than a fix.
 */
export function failingFrame(frames: readonly Frame[]): Frame | null {
  let best: Frame | null = null;

  for (const frame of frames) {
    if (frame.outcome !== 'failed' || frame.closedAt === null) continue;
    if (best === null || frame.closedAt < (best.closedAt ?? Infinity)) best = frame;
  }

  return best;
}

/**
 * The innermost frame execution was still inside when the log ended.
 *
 * Truncation cuts the tail that would have carried the `failed:` lines, and a
 * transaction-level error may never produce one at all. The most recently opened
 * frame that never closed is the best-supported statement about where execution
 * had reached.
 */
export function unterminatedFrame(frames: readonly Frame[]): Frame | null {
  let best: Frame | null = null;

  for (const frame of frames) {
    if (frame.outcome !== 'unterminated') continue;
    if (best === null || frame.openedAt > best.openedAt) best = frame;
  }

  return best;
}

/** The frame the failure is attributed to: the originating failed one, else the innermost open one. */
export function attributedFrame(frames: readonly Frame[]): Frame | null {
  return failingFrame(frames) ?? unterminatedFrame(frames);
}

/** The chain of frames from the top-level invocation down to `frame`, outermost first. */
export function frameChain(frames: readonly Frame[], frame: Frame): Frame[] {
  const chain: Frame[] = [];
  let cursor: Frame | undefined = frame;

  while (cursor !== undefined) {
    chain.unshift(cursor);
    cursor = cursor.parent === null ? undefined : frames[cursor.parent];
  }

  return chain;
}
