import type { InstructionNode } from '../ingest/types.ts';
import { decodeBase58 } from '../signature.ts';
import type { Frame } from './frames.ts';
import type { ComputeScope } from './types.ts';

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

/** `SetComputeUnitLimit(u32)` — discriminant 2 in the ComputeBudget instruction enum. */
const SET_COMPUTE_UNIT_LIMIT = 2;

/**
 * The runtime's message when a frame exhausts the compute units available to it.
 * Its predecessor wording is still emitted by older validators, so both are matched.
 */
const FRAME_EXHAUSTED =
  /^exceeded CUs meter at BPF instruction$|^exceeded maximum number of instructions/;

/** The transaction-wide budget ran out rather than one frame's allowance. */
const BUDGET_EXCEEDED = 'Computational budget exceeded';

/** `Access violation in stack frame 3 at address 0x200003ff8 of size 8` — the 4KB frame limit. */
const STACK_VIOLATION = /Access violation in stack frame (-?\d+)/;

export interface ComputeFailure {
  scope: ComputeScope;
  consumed: number | null;
  budget: number | null;
  requestedLimit: number | null;
  stackFrame: number | null;
}

/**
 * The compute unit ceiling the transaction asked for, if it asked.
 *
 * Without a `SetComputeUnitLimit` instruction the runtime grants a default per
 * instruction, so the distinction matters to the advice: "raise the limit you
 * set" and "you never set one" are different fixes. Only top-level instructions
 * are considered — the ComputeBudget program cannot be invoked by CPI.
 */
export function requestedComputeLimit(instructions: readonly InstructionNode[]): number | null {
  for (const node of instructions) {
    if (node.programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;

    const data = decodeBase58(node.data);
    if (data === null || data.length < 5 || data[0] !== SET_COMPUTE_UNIT_LIMIT) continue;

    // u32, little-endian, immediately after the one-byte discriminant.
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
  }

  return null;
}

/**
 * Read a frame's failure as a compute problem, or return `null` if it is not one.
 *
 * Three distinct failures reach the reader as "ran out of compute" and only one
 * of them is about the budget:
 *
 * - the frame hit its own allowance, recognizable as `consumed N of N`;
 * - the transaction-wide budget was consumed;
 * - the program blew the 4KB stack frame limit, which no budget increase fixes.
 */
export function computeFailureIn(
  frame: Frame,
  instructions: readonly InstructionNode[],
): ComputeFailure | null {
  const reason = frame.failureReason;
  if (reason === null) return null;

  const base = {
    consumed: frame.consumed,
    budget: frame.budget,
    requestedLimit: requestedComputeLimit(instructions),
  };

  const violation = STACK_VIOLATION.exec(reason) ?? findStackViolation(frame);
  if (violation) {
    return { ...base, scope: 'stack-frame', stackFrame: Number(violation[1]) };
  }

  if (FRAME_EXHAUSTED.test(reason)) {
    return { ...base, scope: 'frame', stackFrame: null };
  }

  if (reason === BUDGET_EXCEEDED) {
    return { ...base, scope: 'transaction', stackFrame: null };
  }

  return null;
}

/**
 * A stack access violation logged inside the frame rather than in its failure
 * reason. The runtime reports it as a `Program log:` line and then fails the
 * frame with a generic `Program failed to complete`, so the specific cause is
 * only visible here.
 */
function findStackViolation(frame: Frame): RegExpExecArray | null {
  for (const line of frame.lines) {
    const match = STACK_VIOLATION.exec(line.raw);
    if (match) return match;
  }
  return null;
}

function units(value: number | null): string {
  return value === null ? 'an unreported number of' : value.toLocaleString('en-US');
}

export function explainCompute(failure: ComputeFailure, programId: string | null): string {
  const program = programId ?? 'the failing program';

  if (failure.scope === 'stack-frame') {
    const frame =
      failure.stackFrame === null ? 'a stack frame' : `stack frame ${String(failure.stackFrame)}`;
    return (
      `${program} overran ${frame}. Solana gives each call frame a fixed 4KB of stack, and no ` +
      'compute budget change affects it. The usual cause is a large struct or array held by ' +
      'value in a function local — deserialized account state, or a fixed-size buffer. Box the ' +
      'large value onto the heap, or split the function so the large locals do not all live in ' +
      'one frame at once.'
    );
  }

  const spent = `${units(failure.consumed)} compute units`;

  if (failure.scope === 'frame') {
    return (
      `${program} used all ${spent} available to its invocation and was cut off mid-execution. ` +
      'Nothing in the program is wrong at a specific line — it simply did not finish. ' +
      requestedAdvice(failure) +
      " Note that a CPI inherits what remains of the caller's budget, so a program that " +
      'runs fine when invoked directly can still exhaust its allowance when called deeper in a ' +
      'transaction.'
    );
  }

  return (
    `The transaction consumed its entire compute budget after ${spent} in ${program}. ` +
    'Every instruction shares one budget, so an earlier instruction spending more than expected ' +
    'can starve a later one that would otherwise succeed. ' +
    requestedAdvice(failure)
  );
}

function requestedAdvice(failure: ComputeFailure): string {
  return failure.requestedLimit === null
    ? 'The transaction set no ComputeBudget limit, so it ran on the default allowance; adding a ' +
        'SetComputeUnitLimit instruction raises it.'
    : `The transaction requested ${failure.requestedLimit.toLocaleString('en-US')} compute units ` +
        'via SetComputeUnitLimit; raise that value, or reduce the work — logging in hot paths is ' +
        'often the cheapest thing to cut.';
}
