import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  failingInstructionIndex,
  normalizeTransaction,
  reviveRawTransaction,
  walkInstructions,
} from '@solvbana/core';

/**
 * The fixture corpus is the spec.
 *
 * Every entry is a real mainnet failure recorded by `scripts/harvest.ts`, with
 * expectations checked against the ledger rather than generated from this
 * parser's own output. The suite reads the cached responses, so it runs offline
 * and deterministically — a corpus that needed live RPC would be neither.
 */
const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');

interface Entry {
  signature: string;
  category: string;
  file: string;
  failingInstructionIndex: number | null;
  errorKind: string;
  instructionErrorKind: string | null;
  expectTruncatedLogs: boolean;
  note: string;
}

interface SyntheticEntry {
  file: string;
  case: string;
  failingInstructionIndex: number | null;
  errorKind: string;
  instructionErrorKind: string | null;
  expectTruncatedLogs: boolean;
  expectAbsentLogs: boolean;
  expectUnresolvedLookups: boolean;
  expectCpiDepthUnavailable: boolean;
  note: string;
}

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as T;
}

const manifest = readJson<{ entries: Entry[] }>('manifest.json');
const synthetic = readJson<{ entries: SyntheticEntry[] }>('synthetic', 'manifest.json');

describe('mainnet corpus', () => {
  it('spans the failure categories Phase 0 calls for', () => {
    const categories = new Set(manifest.entries.map((entry) => entry.category));
    for (const required of [
      'anchor-constraint',
      'anchor-account',
      'custom-error',
      'panic',
      'compute-exhaustion',
      'native-program',
    ]) {
      expect(categories, `missing category ${required}`).toContain(required);
    }
  });

  it('holds 30-50 signatures, as the roadmap requires', () => {
    expect(manifest.entries.length).toBeGreaterThanOrEqual(30);
    expect(manifest.entries.length).toBeLessThanOrEqual(50);
  });

  it('does not let one failure dominate the corpus', () => {
    // Left unchecked a harvest fills with whichever error the busiest program is
    // currently throwing, which exercises one code path many times over. The
    // notes describe the actual failure, so distinct notes count distinct cases.
    const distinctFailures = new Set(manifest.entries.map((entry) => entry.note));
    expect(distinctFailures.size).toBeGreaterThanOrEqual(20);
  });

  it.each(manifest.entries.map((entry) => [entry.signature.slice(0, 8), entry] as const))(
    'normalizes %s',
    (_label, entry) => {
      const raw = reviveRawTransaction(readJson('transactions', entry.file));
      const transaction = normalizeTransaction(raw, entry.signature);

      expect(transaction.signature).toBe(entry.signature);
      expect(transaction.error.kind).toBe(entry.errorKind);
      expect(failingInstructionIndex(transaction.error)).toBe(entry.failingInstructionIndex);
      expect(transaction.logs.truncated).toBe(entry.expectTruncatedLogs);

      if (entry.instructionErrorKind !== null) {
        expect(transaction.error).toMatchObject({
          error: { kind: entry.instructionErrorKind },
        });
      }

      // Every real transaction has at least one instruction and a slot.
      expect(transaction.instructions.length).toBeGreaterThan(0);
      expect(transaction.slot).toBeGreaterThan(0n);

      // The failing instruction must exist in the tree that was built.
      const index = failingInstructionIndex(transaction.error);
      if (index !== null) {
        expect(transaction.instructions[index]).toBeDefined();
      }
    },
  );

  it('resolves a program id for every instruction whose lookups were resolved', () => {
    for (const entry of manifest.entries) {
      const raw = reviveRawTransaction(readJson('transactions', entry.file));
      const transaction = normalizeTransaction(raw, entry.signature);
      if (transaction.accounts.unresolvedLookups) continue;

      for (const node of walkInstructions(transaction.instructions)) {
        expect(
          node.programId,
          `${entry.signature} instruction ${String(node.outerIndex)}`,
        ).not.toBeNull();
      }
    }
  });

  it('attributes the failing instruction a log stream when logs are present', () => {
    for (const entry of manifest.entries) {
      const raw = reviveRawTransaction(readJson('transactions', entry.file));
      const transaction = normalizeTransaction(raw, entry.signature);

      const index = failingInstructionIndex(transaction.error);
      if (index === null || transaction.logs.absent || transaction.logs.truncated) continue;

      const attributed = transaction.logs.lines.filter((line) => line.outerIndex === index);
      expect(
        attributed.length,
        `${entry.signature} has no logs for instruction ${String(index)}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('synthetic edge cases', () => {
  it.each(synthetic.entries.map((entry) => [entry.case, entry] as const))(
    'handles %s',
    (_label, entry) => {
      const raw = reviveRawTransaction(readJson('synthetic', entry.file));
      const transaction = normalizeTransaction(raw, `synthetic-${entry.file}`);

      expect(transaction.error.kind).toBe(entry.errorKind);
      expect(failingInstructionIndex(transaction.error)).toBe(entry.failingInstructionIndex);
      expect(transaction.logs.truncated).toBe(entry.expectTruncatedLogs);
      expect(transaction.logs.absent).toBe(entry.expectAbsentLogs);
      expect(transaction.accounts.unresolvedLookups).toBe(entry.expectUnresolvedLookups);

      const anyFlat = [...walkInstructions(transaction.instructions)].some(
        (node) => node.cpiDepthUnavailable,
      );
      expect(anyFlat).toBe(entry.expectCpiDepthUnavailable);

      if (entry.instructionErrorKind !== null) {
        expect(transaction.error).toMatchObject({ error: { kind: entry.instructionErrorKind } });
      }
    },
  );

  it('explains every degradation it applies', () => {
    // "Degrade in tiers, never fail blank": anything unresolved has to say so.
    for (const entry of synthetic.entries) {
      const raw = reviveRawTransaction(readJson('synthetic', entry.file));
      const transaction = normalizeTransaction(raw, `synthetic-${entry.file}`);

      const degraded =
        entry.expectTruncatedLogs ||
        entry.expectAbsentLogs ||
        entry.expectUnresolvedLookups ||
        entry.expectCpiDepthUnavailable;

      expect(transaction.degradations.length > 0, `${entry.case}`).toBe(degraded);
    }
  });

  it('retains the raw value of an error variant it cannot name', () => {
    const raw = reviveRawTransaction(readJson('synthetic', 'unrecognized-error.json'));
    const transaction = normalizeTransaction(raw, 'synthetic-unrecognized');

    // Integers inside `meta.err` arrive as bigint from the RPC client, and the
    // fixture reviver reproduces that so the corpus exercises the real shape.
    expect(transaction.error).toEqual({
      kind: 'unrecognized',
      raw: { SomeFutureRuntimeVariant: { detail: 42n } },
    });
  });
});
