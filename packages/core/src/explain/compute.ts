import { buildFrames, failingFrame } from '../analyze/frames.ts';
import { requestedComputeLimit } from '../analyze/compute.ts';
import type { FailedTransaction } from '../ingest/types.ts';
import type { ComputeBreakdown } from './types.ts';

/**
 * Where the compute went, frame by frame.
 *
 * Read from the runtime's own `consumed N of M compute units` lines rather than
 * recomputed, so the numbers are the ones the validator metered. A frame that
 * never reported leaves both figures `null`: the runtime does not emit the line
 * for a frame that failed before completing, and inventing a total from the
 * difference of its neighbours would be arithmetic dressed up as evidence.
 */
export function computeBreakdown(transaction: FailedTransaction): ComputeBreakdown | null {
  const frames = buildFrames(transaction.logs);
  if (frames.length === 0) return null;

  const failing = failingFrame(frames);

  return {
    total: transaction.computeUnitsConsumed,
    requestedLimit: requestedComputeLimit(transaction.instructions),
    frames: frames.map((frame) => ({
      programId: frame.programId,
      depth: frame.depth,
      consumed: frame.consumed,
      budget: frame.budget,
      failing: failing !== null && frame.index === failing.index,
    })),
  };
}
