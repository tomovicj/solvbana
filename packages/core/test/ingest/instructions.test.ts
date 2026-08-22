import { describe, expect, it } from 'vitest';
import {
  buildInstructionTree,
  flattenAccountKeys,
  walkInstructions,
  type RawInstruction,
} from '@solvbana/core';

const accounts = flattenAccountKeys({
  staticKeys: ['Payer', 'Outer', 'Token', 'System'],
  header: {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 3,
  },
  addressTableLookups: undefined,
  loadedAddresses: undefined,
});

function instruction(programIdIndex: number, stackHeight?: number | null): RawInstruction {
  return {
    programIdIndex,
    accounts: [0],
    data: 'AA',
    ...(stackHeight === undefined ? {} : { stackHeight }),
  };
}

describe('buildInstructionTree', () => {
  it('resolves program ids through the flattened account keys', () => {
    const { nodes } = buildInstructionTree([instruction(1)], [], accounts);
    expect(nodes[0]?.programId).toBe('Outer');
    expect(nodes[0]?.stackHeight).toBe(1);
  });

  it('nests CPI children by stack height', () => {
    const { nodes, degradations } = buildInstructionTree(
      [instruction(1)],
      [
        {
          index: 0,
          instructions: [
            instruction(2, 2), // direct CPI
            instruction(3, 3), // CPI made by that CPI
            instruction(2, 2), // back out to a second direct CPI
          ],
        },
      ],
      accounts,
    );

    const outer = nodes[0]!;
    expect(outer.children).toHaveLength(2);
    expect(outer.children[0]?.children).toHaveLength(1);
    expect(outer.children[0]?.children[0]?.programId).toBe('System');
    expect(outer.children[1]?.children).toHaveLength(0);
    expect(degradations).toEqual([]);
  });

  it('walks depth-first, parents before children', () => {
    const { nodes } = buildInstructionTree(
      [instruction(1)],
      [{ index: 0, instructions: [instruction(2, 2), instruction(3, 3)] }],
      accounts,
    );

    expect([...walkInstructions(nodes)].map((node) => node.stackHeight)).toEqual([1, 2, 3]);
  });

  it('falls back to flat children and flags the node when stack heights are absent', () => {
    // Depth genuinely does not exist for these transactions. Flattening silently
    // would let Phase 3 read the fallback as real CPI ordering.
    const { nodes, degradations } = buildInstructionTree(
      [instruction(1)],
      [{ index: 0, instructions: [instruction(2), instruction(3)] }],
      accounts,
    );

    expect(nodes[0]?.cpiDepthUnavailable).toBe(true);
    expect(nodes[0]?.children).toHaveLength(2);
    expect(nodes[0]?.children.every((child) => child.children.length === 0)).toBe(true);
    expect(degradations).toHaveLength(1);
    expect(degradations[0]).toMatch(/no CPI stack heights/);
  });

  it('reports rather than drops inner instructions pointing at a missing outer instruction', () => {
    const { degradations } = buildInstructionTree(
      [instruction(1)],
      [{ index: 7, instructions: [instruction(2, 2)] }],
      accounts,
    );

    expect(degradations[0]).toMatch(/does not exist in the message/);
  });

  it('leaves programId null when the index falls outside the resolved keys', () => {
    const { nodes } = buildInstructionTree([instruction(99)], [], accounts);
    expect(nodes[0]?.programId).toBeNull();
  });
});
