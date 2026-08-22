import { describe, expect, it } from 'vitest';
import {
  buildFrames,
  computeFailureIn,
  explainCompute,
  parseLogs,
  requestedComputeLimit,
  COMPUTE_BUDGET_PROGRAM_ID,
  type Frame,
  type InstructionNode,
} from '@solvbana/core';

function instruction(programId: string, data: string): InstructionNode {
  return {
    outerIndex: 0,
    stackHeight: 1,
    programIdIndex: 0,
    programId,
    accountIndexes: [],
    data,
    children: [],
    cpiDepthUnavailable: false,
  };
}

function frameOf(messages: string[]): Frame {
  return buildFrames(parseLogs(['Program Prog invoke [1]', ...messages], []))[0]!;
}

describe('requestedComputeLimit', () => {
  it('decodes SetComputeUnitLimit from the ComputeBudget instruction', () => {
    // `HaXgWs` is the base58 of [2, 136, 145, 1, 0]: discriminant 2, then 102792
    // as a little-endian u32. Taken from mainnet signature `2eUHZkMK…`, whose
    // client set the limit to exactly what it went on to consume.
    expect(requestedComputeLimit([instruction(COMPUTE_BUDGET_PROGRAM_ID, 'HaXgWs')])).toBe(102792);
  });

  it('reports no limit when the transaction never set one', () => {
    expect(requestedComputeLimit([instruction('SomeProgram', 'HaXgWs')])).toBeNull();
    // `3gJqkocMWaMm` is [3, ...100000 as u64 LE]: SetComputeUnitPrice, which
    // buys priority, not headroom.
    expect(
      requestedComputeLimit([instruction(COMPUTE_BUDGET_PROGRAM_ID, '3gJqkocMWaMm')]),
    ).toBeNull();
  });
});

describe('computeFailureIn', () => {
  it('recognizes a frame that used its whole allowance', () => {
    const frame = frameOf([
      'Program Prog consumed 11921 of 11921 compute units',
      'Program Prog failed: exceeded CUs meter at BPF instruction',
    ]);

    expect(computeFailureIn(frame, [])).toMatchObject({
      scope: 'frame',
      consumed: 11921,
      budget: 11921,
    });
  });

  it("separates the transaction-wide budget from one frame's allowance", () => {
    const frame = frameOf([
      'Program Prog consumed 19290 of 19290 compute units',
      'Program Prog failed: Computational budget exceeded',
    ]);

    expect(computeFailureIn(frame, [])).toMatchObject({ scope: 'transaction' });
  });

  it('recognizes a stack overrun logged as program output', () => {
    // The runtime prints the violation as a log line and then fails the frame
    // with a generic reason, so the cause is only visible inside the frame.
    const frame = frameOf([
      'Program failed to complete: Access violation in stack frame 3 at address 0x200003ff8 of size 8',
      'Program Prog failed: Program failed to complete',
    ]);

    expect(computeFailureIn(frame, [])).toMatchObject({ scope: 'stack-frame', stackFrame: 3 });
  });

  it('does not claim a compute failure for an unrelated one', () => {
    const frame = frameOf(['Program Prog failed: custom program error: 0x1']);
    expect(computeFailureIn(frame, [])).toBeNull();
  });
});

describe('explainCompute', () => {
  it('tells the reader they set a limit when they did', () => {
    const explanation = explainCompute(
      { scope: 'frame', consumed: 11921, budget: 11921, requestedLimit: 102792, stackFrame: null },
      'Prog',
    );

    expect(explanation).toMatch(/102,792/);
    expect(explanation).toMatch(/SetComputeUnitLimit/);
  });

  it('tells the reader they never set one when they did not', () => {
    const explanation = explainCompute(
      {
        scope: 'transaction',
        consumed: 200000,
        budget: null,
        requestedLimit: null,
        stackFrame: null,
      },
      'Prog',
    );

    expect(explanation).toMatch(/default allowance/);
  });

  it('does not offer a budget increase for a stack overrun', () => {
    // No compute budget change moves the 4KB frame limit, so suggesting one would
    // send the reader after the wrong fix entirely.
    const explanation = explainCompute(
      {
        scope: 'stack-frame',
        consumed: 4218,
        budget: 200000,
        requestedLimit: 200000,
        stackFrame: 3,
      },
      'Prog',
    );

    expect(explanation).toMatch(/4KB/);
    expect(explanation).not.toMatch(/raise that value/);
  });
});
