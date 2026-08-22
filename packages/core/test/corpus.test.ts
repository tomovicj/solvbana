import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  failingInstructionIndex,
  normalizeTransaction,
  reviveRawTransaction,
  walkInstructions,
  type Analysis,
  type Confidence,
  type ProgramSource,
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

/**
 * What Phase 1 must read out of a fixture's logs.
 *
 * Written by hand from `meta.logMessages` and `meta.err`, never generated from
 * the analyzer — an expectation produced by the code under test asserts nothing.
 */
interface Phase1Expectation {
  confidence: Confidence;
  program: string | null;
  /**
   * How the program was established, where the fixture pins it.
   *
   * Optional because every harvested fixture has logs and would say `logs`;
   * the synthetic entries are where the alternative is exercised.
   */
  programSource?: ProgramSource | null;
  handler: string | null;
  errorName: string | null;
  errorNumber: number | null;
  site: { file: string; line: number } | null;
  account: string | null;
}

interface Entry {
  signature: string;
  category: string;
  file: string;
  failingInstructionIndex: number | null;
  errorKind: string;
  instructionErrorKind: string | null;
  expectTruncatedLogs: boolean;
  note: string;
  phase1: Phase1Expectation;
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
  phase1: Phase1Expectation;
}

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as T;
}

const manifest = readJson<{ entries: Entry[] }>('manifest.json');
const synthetic = readJson<{ entries: SyntheticEntry[] }>('synthetic', 'manifest.json');

/** Normalize a fixture and read it, exactly as `diagnose()` does after fetching. */
function analyzeFixture(signature: string, ...parts: string[]): Analysis {
  const raw = reviveRawTransaction(readJson(...parts));
  return analyze(normalizeTransaction(raw, signature));
}

function expectMatchesPhase1(analysis: Analysis, expected: Phase1Expectation, label: string): void {
  const { finding } = analysis;

  expect(analysis.confidence, `${label} confidence`).toBe(expected.confidence);
  expect(finding.program, `${label} program`).toBe(expected.program);
  // The provenance is null exactly when the program is. Checked for every
  // fixture rather than only the ones that pin a value, because a program
  // reported without saying where it came from is the failure mode the field
  // exists to prevent.
  expect(finding.programSource === null, `${label} programSource nullity`).toBe(
    finding.program === null,
  );
  if (expected.programSource !== undefined) {
    expect(finding.programSource, `${label} programSource`).toBe(expected.programSource);
  }
  expect(finding.handler, `${label} handler`).toBe(expected.handler);
  expect(finding.error.name, `${label} error name`).toBe(expected.errorName);
  expect(finding.error.code, `${label} error number`).toBe(expected.errorNumber);

  const site = analysis.candidates[0]?.location ?? null;
  expect(site === null ? null : { file: site.file, line: site.line }, `${label} site`).toEqual(
    expected.site,
  );

  const account = finding.failure.kind === 'anchor' ? finding.failure.account : null;
  expect(account, `${label} account`).toBe(expected.account);
}

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

  it.each(manifest.entries.map((entry) => [entry.signature.slice(0, 8), entry] as const))(
    'reads %s as the manifest says its logs read',
    (label, entry) => {
      const analysis = analyzeFixture(entry.signature, 'transactions', entry.file);
      expectMatchesPhase1(analysis, entry.phase1, label);
    },
  );

  it('never reports exact confidence without a location', () => {
    // The load-bearing promise of the confidence scale: `exact` means there is a
    // line and it was read, not inferred. A candidate-free `exact` would make the
    // level mean two different things depending on which detector produced it.
    for (const entry of manifest.entries) {
      const analysis = analyzeFixture(entry.signature, 'transactions', entry.file);
      if (analysis.confidence !== 'exact') continue;
      expect(analysis.candidates.length, entry.signature).toBeGreaterThanOrEqual(1);
    }
  });

  it('never names an error it did not read', () => {
    for (const entry of manifest.entries) {
      const { finding } = analyzeFixture(entry.signature, 'transactions', entry.file);
      if (finding.error.naming !== 'none') continue;

      expect(finding.error.name, `${entry.signature} named without provenance`).toBeNull();
      expect(finding.error.message, `${entry.signature} described without provenance`).toBeNull();
    }
  });

  it('refuses to name a code that falls in a framework range but was never published', () => {
    // Two Whirlpool failures return 2012, which is ConstraintAddress in Anchor's
    // reserved range — but the program logged no Anchor error, so nothing in the
    // transaction says it is an Anchor program. Naming it from the range is the
    // confident-and-wrong answer the project exists to avoid, and these fixtures
    // are the regression test for the refusal.
    const undecoded = manifest.entries.filter((entry) => entry.phase1.errorName === null);
    expect(undecoded.length).toBeGreaterThan(0);

    for (const entry of undecoded) {
      const analysis = analyzeFixture(entry.signature, 'transactions', entry.file);
      expect(analysis.confidence, entry.signature).toBe('unknown');
      expect(analysis.finding.error.code, entry.signature).toBe(entry.phase1.errorNumber);
      // The refusal has to say so; a silent `unknown` teaches the reader nothing.
      expect(analysis.reasons.join(' '), entry.signature).toMatch(/IDL|no error text/);
    }
  });

  it('always explains itself, whatever it managed to read', () => {
    for (const entry of manifest.entries) {
      const analysis = analyzeFixture(entry.signature, 'transactions', entry.file);
      expect(analysis.reasons.length, entry.signature).toBeGreaterThan(0);
      expect(analysis.finding.explanation.length, entry.signature).toBeGreaterThan(40);
    }
  });

  it('holds its reach across the corpus', () => {
    // A coverage floor rather than an exact tally: adding fixtures should not
    // require editing this, but losing ground on the ones already here should
    // fail loudly instead of drifting downward unnoticed.
    const buckets = new Map<Confidence, number>();
    for (const entry of manifest.entries) {
      const { confidence } = analyzeFixture(entry.signature, 'transactions', entry.file);
      buckets.set(confidence, (buckets.get(confidence) ?? 0) + 1);
    }

    expect(buckets.get('exact') ?? 0).toBeGreaterThanOrEqual(7);
    expect((buckets.get('exact') ?? 0) + (buckets.get('variant-only') ?? 0)).toBeGreaterThanOrEqual(
      37,
    );
    // `narrowed` means a candidate set was reduced by inference, which is Phase 3.
    expect(buckets.get('narrowed') ?? 0).toBe(0);
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

  it.each(synthetic.entries.map((entry) => [entry.case, entry] as const))(
    'reads %s as its manifest says',
    (label, entry) => {
      const analysis = analyzeFixture(`synthetic-${entry.file}`, 'synthetic', entry.file);
      expectMatchesPhase1(analysis, entry.phase1, label);
    },
  );

  it('tells a stack overrun apart from running out of compute', () => {
    // Both surface as ProgramFailedToComplete, and the fixes have nothing in
    // common: no budget increase moves a 4KB frame limit.
    const { finding } = analyzeFixture('synthetic-stack', 'synthetic', 'stack-violation.json');

    expect(finding.failure).toMatchObject({ kind: 'compute', scope: 'stack-frame', stackFrame: 3 });
    expect(finding.explanation).toMatch(/4KB/);
    expect(finding.explanation).toMatch(/Box the/);
  });

  it('names a native program error from the program identity, not from the code range', () => {
    const { finding } = analyzeFixture('synthetic-native', 'synthetic', 'native-custom-error.json');

    expect(finding.error).toMatchObject({
      code: 1,
      name: 'InsufficientFunds',
      naming: 'native-table',
    });
  });

  it('names the failing program from the instruction index when no CPI ran', () => {
    // With no logs there is no frame, but `meta.innerInstructions` is recorded
    // and holds no group for the failing instruction. That is positive evidence
    // it made no cross-program call, so the program it addressed is the one that
    // failed — read from the record, not inferred from it.
    const analysis = analyzeFixture('synthetic-no-cpi', 'synthetic', 'no-logs-no-cpi.json');

    expect(analysis.finding.program).toBe('A2kWsYn598CtPFEGpP363D5uPZThHu4kBk1qaaajDvMM');
    expect(analysis.finding.programSource).toBe('instruction-index');
    expect(analysis.reasons.join(' ')).toMatch(/made no cross-program call/);
    // Naming the program is not naming the error: the code stays a number.
    expect(analysis.confidence).toBe('unknown');
    expect(analysis.finding.error.code).toBe(6001);
    expect(analysis.finding.error.name).toBeNull();
  });

  it('refuses to name a program when the failing instruction made a CPI', () => {
    const analysis = analyzeFixture('synthetic-with-cpi', 'synthetic', 'no-logs-with-cpi.json');

    expect(analysis.finding.program).toBeNull();
    expect(analysis.finding.programSource).toBeNull();
    expect(analysis.reasons.join(' ')).toMatch(/passed the error along/);
  });

  it('treats an unrecorded meta.innerInstructions as silence, not as proof of no CPI', () => {
    // `no-logs.json` carries `innerInstructions: null`. Its instruction has no
    // children for exactly the same reason the fixture above does — but here the
    // record never said, and an empty tree built from silence proves nothing.
    const analysis = analyzeFixture('synthetic-no-logs', 'synthetic', 'no-logs.json');

    expect(analysis.finding.program).toBeNull();
    expect(analysis.finding.programSource).toBeNull();
    expect(analysis.reasons.join(' ')).toMatch(/no meta.innerInstructions/);
  });

  it('still reports what meta.err names when the logs are absent', () => {
    // "Degrade in tiers, never fail blank": no logs removes the log signals, not
    // the runtime's own classification of the failure.
    const analysis = analyzeFixture('synthetic-no-logs', 'synthetic', 'no-logs.json');

    expect(analysis.confidence).toBe('variant-only');
    expect(analysis.finding.error).toMatchObject({
      name: 'InsufficientFunds',
      naming: 'runtime-variant',
    });
    expect(analysis.reasons.join(' ')).toMatch(/without logs/);
  });

  it('does not attribute anything to a frame the truncated tail never closed', () => {
    const analysis = analyzeFixture('synthetic-truncated', 'synthetic', 'truncated-logs.json');

    expect(analysis.confidence).toBe('variant-only');
    expect(analysis.candidates).toEqual([]);
    // The handler is read from a line that survived; the site is not, because the
    // line that would have carried it was cut.
    expect(analysis.finding.handler).toBe('Withdraw');
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
