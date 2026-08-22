import { addressAt } from './accounts.ts';
import type { AccountKeys, InstructionNode, RawTransaction } from './types.ts';

/** An instruction as it appears in a `json`-encoded message or in `innerInstructions`. */
export interface RawInstruction {
  programIdIndex: number;
  accounts: readonly number[];
  data: string;
  /** Absent on transactions predating the runtime's stack-height annotation. */
  stackHeight?: number | null;
}

export interface InstructionTree {
  nodes: InstructionNode[];
  degradations: string[];
}

function toNode(
  raw: RawInstruction,
  outerIndex: number,
  stackHeight: number,
  accounts: AccountKeys,
): InstructionNode {
  return {
    outerIndex,
    stackHeight,
    programIdIndex: raw.programIdIndex,
    programId: addressAt(accounts, raw.programIdIndex),
    accountIndexes: [...raw.accounts],
    data: raw.data,
    children: [],
    cpiDepthUnavailable: false,
  };
}

/**
 * Nest a flat list of CPI instructions under their top-level parent.
 *
 * `meta.innerInstructions` groups by outer instruction index, but within a group
 * the instructions are a flat list in execution order, with depth carried only by
 * `stackHeight` (2 for a direct CPI of the outer instruction, 3 for a CPI of
 * that, and so on). Rebuilding the tree is therefore a stack walk.
 */
function nestInner(
  inner: readonly RawInstruction[],
  parent: InstructionNode,
  outerIndex: number,
  accounts: AccountKeys,
): void {
  const stack: InstructionNode[] = [parent];

  for (const raw of inner) {
    const height = raw.stackHeight ?? 0;
    // Pop until the top of the stack is this instruction's parent — the node one
    // level shallower than the instruction itself.
    while (stack.length > 1 && stack[stack.length - 1]!.stackHeight >= height) {
      stack.pop();
    }

    const node = toNode(raw, outerIndex, height, accounts);
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }
}

/**
 * Build the instruction tree: top-level instructions with their CPI children.
 *
 * When the RPC reports no `stackHeight` — true of transactions from before the
 * runtime began annotating it — the depth information simply does not exist.
 * Those children are attached flat under their outer instruction and the node is
 * marked `cpiDepthUnavailable`, because Phase 3 bounds a failure between the last
 * completed CPI and the next one, and that inference is unsound without real
 * depth. Flattening silently would let a later tier read the fallback as fact.
 */
export function buildInstructionTree(
  outer: readonly RawInstruction[],
  innerGroups: readonly { index: number; instructions: readonly RawInstruction[] }[],
  accounts: AccountKeys,
): InstructionTree {
  const degradations: string[] = [];

  const nodes = outer.map((raw, outerIndex) => toNode(raw, outerIndex, 1, accounts));

  for (const group of innerGroups) {
    const parent = nodes[group.index];
    if (parent === undefined) {
      degradations.push(
        `Inner instructions were reported for instruction ${String(group.index)}, which does not ` +
          `exist in the message (${String(nodes.length)} top-level instructions). They were dropped.`,
      );
      continue;
    }

    const depthAvailable = group.instructions.every(
      (instruction) => typeof instruction.stackHeight === 'number',
    );

    if (depthAvailable) {
      nestInner(group.instructions, parent, group.index, accounts);
      continue;
    }

    parent.cpiDepthUnavailable = true;
    parent.children.push(...group.instructions.map((raw) => toNode(raw, group.index, 2, accounts)));
    degradations.push(
      `Instruction ${String(group.index)} reported no CPI stack heights, so its ` +
        `${String(group.instructions.length)} inner instructions are listed flat rather than ` +
        `nested. Nesting depth is unavailable for this transaction.`,
    );
  }

  return { nodes, degradations };
}

/** Pull the tree inputs off a raw response and build it. */
export function instructionTreeFrom(raw: RawTransaction, accounts: AccountKeys): InstructionTree {
  return buildInstructionTree(
    raw.transaction.message.instructions,
    raw.meta?.innerInstructions ?? [],
    accounts,
  );
}

/** Depth-first walk over a tree, parents before children. */
export function* walkInstructions(nodes: readonly InstructionNode[]): Generator<InstructionNode> {
  for (const node of nodes) {
    yield node;
    yield* walkInstructions(node.children);
  }
}
