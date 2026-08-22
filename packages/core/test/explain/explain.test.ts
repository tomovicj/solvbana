import { describe, expect, it } from 'vitest';
import {
  analyze,
  explainFailure,
  failingInstructionNode,
  normalizeTransaction,
  reviveRawTransaction,
  type Finding,
} from '@solvbana/core';
import { readJson } from '../fixtures.ts';
import { PROGRAM, failedTransaction, instruction } from './helpers.ts';

const UNDECODED: Finding = {
  program: PROGRAM,
  programSource: 'logs',
  handler: null,
  handlerSource: null,
  error: { code: null, name: null, message: null, naming: 'none' },
  failure: { kind: 'undecoded' },
  explanation: 'The failure is opaque.',
};

describe('failingInstructionNode', () => {
  it('answers only when the program was called exactly once', () => {
    // Correlating a log frame to a node in the instruction tree is Phase 3's
    // problem. Two calls into the same program leave the question genuinely
    // open, and it is left open rather than guessed at.
    const one = failedTransaction({ instructions: [instruction([0])] });
    const two = failedTransaction({ instructions: [instruction([0]), instruction([1])] });

    expect(failingInstructionNode(one, PROGRAM)).not.toBeNull();
    expect(failingInstructionNode(two, PROGRAM)).toBeNull();
  });
});

describe('explainFailure', () => {
  it('still reports what moved when no program was identified', async () => {
    const transaction = failedTransaction({ lamports: [10n, 3n] });
    const explanation = await explainFailure(transaction, { ...UNDECODED, program: null }, null);

    expect(explanation.accounts).toEqual([]);
    expect(explanation.deltas.fee).toBe(5000n);
    expect(explanation.notes.join(' ')).toMatch(/No program was identified/);
  });

  it('says why it built no account table when the program was called twice', async () => {
    const transaction = failedTransaction({
      lamports: [1n, 1n],
      instructions: [instruction([0]), instruction([1])],
    });

    const explanation = await explainFailure(transaction, UNDECODED, null);

    expect(explanation.accounts).toEqual([]);
    expect(explanation.notes.join(' ')).toMatch(/more than once/);
  });

  it('lists accounts by position when no IDL was resolved', async () => {
    // Degrade in tiers: without names the table is still the answer to "which
    // account did not exist", which is what the balances show.
    const transaction = failedTransaction({
      lamports: [7n, 0n],
      instructions: [instruction([0, 1])],
    });

    const explanation = await explainFailure(transaction, UNDECODED, null);

    expect(explanation.accounts).toHaveLength(2);
    expect(explanation.accounts.every((row) => row.name === null)).toBe(true);
    expect(explanation.accounts[1]?.existedBefore).toBe(false);
    expect(explanation.notes.join(' ')).toMatch(/No IDL was resolved/);
  });

  it('reports only what actually moved, which on a failure is the fee', async () => {
    const raw = reviveRawTransaction(readJson('synthetic', 'stack-violation.json'));
    const transaction = normalizeTransaction(raw, 'synthetic');
    const explanation = await explainFailure(transaction, analyze(transaction).finding, null);

    expect(explanation.deltas.tokens).toEqual([]);
    for (const row of explanation.deltas.lamports) {
      expect(row.delta).not.toBe(0n);
    }
  });

  it('attributes compute to frames even when nothing else could be established', async () => {
    const raw = reviveRawTransaction(readJson('synthetic', 'stack-violation.json'));
    const transaction = normalizeTransaction(raw, 'synthetic');
    const explanation = await explainFailure(transaction, analyze(transaction).finding, null);

    expect(explanation.compute?.frames.length).toBeGreaterThan(0);
    expect(explanation.compute?.frames.some((frame) => frame.failing)).toBe(true);
  });

  it('reports no frames rather than inventing them when logs are absent', async () => {
    const raw = reviveRawTransaction(readJson('synthetic', 'no-logs.json'));
    const transaction = normalizeTransaction(raw, 'synthetic');
    const explanation = await explainFailure(transaction, analyze(transaction).finding, null);

    expect(explanation.compute).toBeNull();
    expect(explanation.notes.join(' ')).toMatch(/No log stream survived/);
  });
});
