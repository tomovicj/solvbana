import { describe, expect, it } from 'vitest';
import {
  attributedFrame,
  buildFrames,
  failingFrame,
  frameChain,
  parseLogs,
  unterminatedFrame,
  type InstructionNode,
  type LogStream,
} from '@solvbana/core';

function outerInstructions(count: number): InstructionNode[] {
  return Array.from({ length: count }, (_, outerIndex) => ({
    outerIndex,
    stackHeight: 1,
    programIdIndex: 0,
    programId: 'Prog',
    accountIndexes: [],
    data: '',
    children: [],
    cpiDepthUnavailable: false,
  }));
}

function stream(messages: string[], outerCount = 1): LogStream {
  return parseLogs(messages, outerInstructions(outerCount));
}

/**
 * The real log stream from mainnet signature `2WH1WJ5N…`, trimmed to the frames
 * that matter.
 *
 * This transaction is why frames exist. The failing program logs its own handler
 * name, then calls a fee program that logs a *different* handler name and returns
 * successfully, and only afterwards throws. Anything that reads "the last
 * `Instruction:` line before the failure" reports `GetFees` — a handler in a
 * program that did not fail.
 */
const CPI_THEN_THROW = [
  'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
  'Program log: Instruction: BuyExactQuoteIn',
  'Program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ invoke [2]',
  'Program log: Instruction: GetFees',
  'Program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ consumed 6010 of 91514 compute units',
  'Program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ success',
  'Program log: AnchorError thrown in programs/pump-amm/src/instructions/swap/buy.rs:687. Error Code: BuySlippageBelowMinBaseAmountOut. Error Number: 6040. Error Message: buy: slippage.',
  'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA consumed 55791 of 134400 compute units',
  'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x1798',
];

describe('buildFrames', () => {
  it("keeps a callee's lines out of its caller's frame", () => {
    const frames = buildFrames(stream(CPI_THEN_THROW));
    expect(frames).toHaveLength(2);

    const messages = frames.map((frame) =>
      frame.lines.map((line) => line.raw.replace('Program log: ', '').slice(0, 30)),
    );

    // The caller's own two lines, and only those: the callee's handler prologue
    // belongs to the callee.
    expect(messages[0]).toEqual(['Instruction: BuyExactQuoteIn', 'AnchorError thrown in programs']);
    expect(messages[1]).toEqual(['Instruction: GetFees']);

    expect(frames[0]).toMatchObject({ depth: 1, parent: null });
    expect(frames[1]).toMatchObject({ depth: 2, parent: 0 });
  });

  it("records each frame's own compute figures and outcome", () => {
    const frames = buildFrames(stream(CPI_THEN_THROW));

    expect(frames[0]).toMatchObject({
      consumed: 55791,
      budget: 134400,
      outcome: 'failed',
      failureReason: 'custom program error: 0x1798',
    });
    expect(frames[1]).toMatchObject({
      consumed: 6010,
      budget: 91514,
      outcome: 'success',
      failureReason: null,
    });
  });

  it('leaves a frame the log never closed marked as such', () => {
    // Truncation cuts the tail carrying the closing lines. Treating an open frame
    // as successful would report a program as having completed when the record
    // simply stops.
    const frames = buildFrames(
      stream(['Program A invoke [1]', 'Program log: checkpoint 1', 'Log truncated']),
    );

    expect(frames[0]?.outcome).toBe('unterminated');
    expect(frames[0]?.closedAt).toBeNull();
    expect(unterminatedFrame(frames)).toBe(frames[0]);
  });

  it('ignores lines emitted before any program was invoked', () => {
    const frames = buildFrames(stream(['Program log: stray', 'Program A invoke [1]']));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.lines).toHaveLength(0);
  });
});

describe('failingFrame', () => {
  it('names the program that errored rather than the one that propagated it', () => {
    // A CPI failure logs the innermost `failed:` line first and each caller's on
    // the way out. Both frames report the same code; only the inner one is where
    // the error came from.
    const frames = buildFrames(
      stream([
        'Program Outer invoke [1]',
        'Program Inner invoke [2]',
        'Program Inner failed: custom program error: 0x9c9',
        'Program Outer failed: custom program error: 0x9c9',
      ]),
    );

    expect(failingFrame(frames)?.programId).toBe('Inner');
  });

  it('takes the earliest failure by close order, not by invoke order', () => {
    // The caller opens first but closes last, so ordering frames by their invoke
    // line would pick the wrong one.
    const frames = buildFrames(
      stream([
        'Program Outer invoke [1]',
        'Program Sibling invoke [2]',
        'Program Sibling success',
        'Program Deep invoke [2]',
        'Program Deep failed: boom',
        'Program Outer failed: boom',
      ]),
    );

    expect(frames.map((frame) => frame.programId)).toEqual(['Outer', 'Sibling', 'Deep']);
    expect(failingFrame(frames)?.programId).toBe('Deep');
  });

  it('falls back to the innermost open frame when nothing reported a failure', () => {
    const frames = buildFrames(
      stream(['Program Outer invoke [1]', 'Program Inner invoke [2]', 'Log truncated']),
    );

    expect(failingFrame(frames)).toBeNull();
    expect(attributedFrame(frames)?.programId).toBe('Inner');
  });
});

describe('frameChain', () => {
  it('walks from the top-level invocation down to the frame', () => {
    const frames = buildFrames(
      stream([
        'Program A invoke [1]',
        'Program B invoke [2]',
        'Program C invoke [3]',
        'Program C failed: boom',
      ]),
    );

    const chain = frameChain(frames, failingFrame(frames)!);
    expect(chain.map((frame) => frame.programId)).toEqual(['A', 'B', 'C']);
  });
});
