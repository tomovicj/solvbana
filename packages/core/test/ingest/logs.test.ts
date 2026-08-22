import { describe, expect, it } from 'vitest';
import {
  classifyLogLine,
  linesForInstruction,
  parseLogs,
  type InstructionNode,
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

describe('classifyLogLine', () => {
  it('classifies the runtime line forms', () => {
    expect(classifyLogLine('Program Prog1 invoke [2]')).toEqual({
      kind: 'invoke',
      programId: 'Prog1',
      depth: 2,
    });
    expect(classifyLogLine('Program Prog1 success')).toEqual({
      kind: 'success',
      programId: 'Prog1',
    });
    expect(classifyLogLine('Program Prog1 failed: custom program error: 0x1771')).toEqual({
      kind: 'failed',
      programId: 'Prog1',
      reason: 'custom program error: 0x1771',
    });
    expect(classifyLogLine('Program Prog1 consumed 4210 of 200000 compute units')).toEqual({
      kind: 'consumed',
      programId: 'Prog1',
      units: 4210,
      budget: 200000,
    });
  });

  it('keeps program output intact, including text that mimics runtime lines', () => {
    // Phase 1 reads Anchor attributions and panic locations straight out of
    // these messages, so the tokenizer must not reshape them.
    const anchor =
      'Program log: AnchorError caused by account: vault. Error Code: ConstraintSeeds. Error Number: 2006.';
    expect(classifyLogLine(anchor)).toEqual({
      kind: 'log',
      message: anchor.replace('Program log: ', ''),
    });

    expect(classifyLogLine('Program log: Program Prog1 success')).toEqual({
      kind: 'log',
      message: 'Program Prog1 success',
    });
  });

  it('recognizes the truncation marker exactly', () => {
    expect(classifyLogLine('Log truncated')).toEqual({ kind: 'truncated' });
    expect(classifyLogLine('Program log: Log truncated')).toMatchObject({ kind: 'log' });
  });

  it('falls back to unparsed rather than discarding an unknown line', () => {
    expect(classifyLogLine('something entirely new')).toEqual({ kind: 'unparsed' });
  });
});

describe('parseLogs', () => {
  it('reports absent logs distinctly from empty logs', () => {
    expect(parseLogs(null, [])).toMatchObject({ absent: true, truncated: false, lines: [] });
    expect(parseLogs([], [])).toMatchObject({ absent: false, truncated: false, lines: [] });
  });

  it('attributes lines to the top-level instruction in scope', () => {
    const logs = parseLogs(
      [
        'Program A invoke [1]',
        'Program log: first',
        'Program A success',
        'Program B invoke [1]',
        'Program log: second',
        'Program B failed: custom program error: 0x1',
      ],
      outerInstructions(2),
    );

    expect(logs.lines.map((line) => line.outerIndex)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(linesForInstruction(logs, 1).map((line) => line.raw)).toHaveLength(3);
  });

  it('keeps CPI frames attributed to their top-level instruction', () => {
    const logs = parseLogs(
      [
        'Program A invoke [1]',
        'Program B invoke [2]',
        'Program log: inner',
        'Program B success',
        'Program A success',
        'Program C invoke [1]',
        'Program C success',
      ],
      outerInstructions(2),
    );

    expect(logs.lines.map((line) => line.outerIndex)).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it('stops attributing after truncation instead of guessing', () => {
    const logs = parseLogs(
      [
        'Program A invoke [1]',
        'Program log: before the cap',
        'Log truncated',
        'Program log: unreachable in practice',
      ],
      outerInstructions(1),
    );

    expect(logs.truncated).toBe(true);
    expect(logs.lines.map((line) => line.outerIndex)).toEqual([0, 0, null, null]);
  });

  it('leaves pre-invoke lines unattributed', () => {
    const logs = parseLogs(['Program A invoke [1]'].slice(1).concat('Log truncated'), []);
    expect(logs.lines[0]?.outerIndex).toBeNull();
  });

  it('retains the raw line and its index for every event', () => {
    const logs = parseLogs(['Program A invoke [1]', 'Program log: hi'], outerInstructions(1));
    expect(logs.lines.map((line) => [line.index, line.raw])).toEqual([
      [0, 'Program A invoke [1]'],
      [1, 'Program log: hi'],
    ]);
  });
});
