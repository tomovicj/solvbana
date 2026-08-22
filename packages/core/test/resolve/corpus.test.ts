import { describe, expect, it } from 'vitest';
import {
  analyze,
  clearResolutionCache,
  normalizeTransaction,
  refineWithResolution,
  resolveProgram,
  reviveRawTransaction,
  type Analysis,
  type Confidence,
} from '@solvbana/core';
import { corpusAccounts, programSnapshot, readJson } from '../fixtures.ts';

/**
 * The corpus, read again with source resolution in play.
 *
 * Every account read is served from a recorded snapshot, so this suite runs
 * offline like the rest. That matters more here than anywhere else: resolution
 * asks whether a program has been upgraded, and a live answer would change
 * underneath the corpus as mainnet moves on, quietly turning a passing
 * expectation into a description of something else.
 */
interface Phase1Expectation {
  confidence: Confidence;
  program: string | null;
  handler: string | null;
  errorName: string | null;
  errorNumber: number | null;
}

interface Phase2Expectation {
  confidence: Confidence;
  errorName: string;
  errorNumber: number;
  naming: string;
  handler: string;
  handlerSource: string;
}

interface Entry {
  signature: string;
  file: string;
  phase1: Phase1Expectation;
  phase2?: Phase2Expectation;
}

const manifest = readJson<{ entries: Entry[] }>('manifest.json');
const programIds = [
  ...new Set(
    manifest.entries.flatMap((entry) =>
      entry.phase1.program === null ? [] : [entry.phase1.program],
    ),
  ),
];
const accounts = corpusAccounts(programIds);

async function resolveFixture(entry: Entry): Promise<Analysis> {
  const raw = reviveRawTransaction(readJson('transactions', entry.file));
  const transaction = normalizeTransaction(raw, entry.signature);
  const analysis = analyze(transaction);

  const programId = analysis.finding.program;
  if (programId === null) return analysis;

  const resolved = await resolveProgram(programId, transaction.slot, { accounts });
  return refineWithResolution(analysis, transaction, resolved);
}

describe('the corpus with source resolution', () => {
  it.each(manifest.entries.map((entry) => [entry.signature.slice(0, 8), entry] as const))(
    'resolves %s to what the manifest says',
    async (label, entry) => {
      clearResolutionCache();
      const { finding, confidence } = await resolveFixture(entry);
      const expected = entry.phase2;

      if (expected === undefined) {
        // No phase2 block means resolution must change nothing: an error the
        // logs already named is not re-decided by an IDL that may be a
        // deployment behind.
        expect(confidence, `${label} confidence`).toBe(entry.phase1.confidence);
        expect(finding.error.name, `${label} error`).toBe(entry.phase1.errorName);
        return;
      }

      expect(confidence, `${label} confidence`).toBe(expected.confidence);
      expect(finding.error, `${label} error`).toMatchObject({
        code: expected.errorNumber,
        name: expected.errorName,
        naming: expected.naming,
      });
      expect(finding.handler, `${label} handler`).toBe(expected.handler);
      expect(finding.handlerSource, `${label} handler source`).toBe(expected.handlerSource);
    },
  );

  it('attaches a resolution to every fixture whose program was identified', async () => {
    for (const entry of manifest.entries) {
      if (entry.phase1.program === null) continue;
      clearResolutionCache();
      const { finding } = await resolveFixture(entry);

      expect(finding.resolution?.programId, entry.signature).toBe(entry.phase1.program);
      expect(finding.resolution?.notes.length, entry.signature).toBeGreaterThan(0);
    }
  });

  it('never reaches exact confidence through resolution', async () => {
    // This phase resolves no source locations. `exact` implies a candidate, and
    // nothing here produces one, so the invariant holds without a special case.
    for (const entry of manifest.entries) {
      clearResolutionCache();
      const analysis = await resolveFixture(entry);
      if (analysis.confidence !== 'exact') continue;

      expect(analysis.candidates.length, entry.signature).toBeGreaterThanOrEqual(1);
      // An `exact` answer came from the logs; resolution cannot have created it.
      expect(entry.phase1.confidence, entry.signature).toBe('exact');
    }
  });

  it('names a built-in Anchor code only where an IDL was resolved', async () => {
    // The whole licence for the built-in table is that this program published an
    // IDL at its Anchor-derived address. A name without one is the range guess
    // Phase 1 refuses, wearing a different label.
    for (const entry of manifest.entries) {
      clearResolutionCache();
      const { finding } = await resolveFixture(entry);
      if (finding.error.naming !== 'anchor-builtin') continue;

      expect(finding.resolution?.idl, entry.signature).not.toBeNull();
    }
  });

  it('holds its reach with resolution applied', async () => {
    const buckets = new Map<Confidence, number>();
    for (const entry of manifest.entries) {
      clearResolutionCache();
      const { confidence } = await resolveFixture(entry);
      buckets.set(confidence, (buckets.get(confidence) ?? 0) + 1);
    }

    // Phase 1 alone reached 7 / 30 / 8. Resolution moves the two Whirlpool
    // Custom(2012) fixtures; the remaining six publish no IDL, and stay undecoded
    // by design rather than by omission.
    expect(buckets.get('exact') ?? 0).toBeGreaterThanOrEqual(7);
    expect(buckets.get('variant-only') ?? 0).toBeGreaterThanOrEqual(32);
    expect(buckets.get('unknown') ?? 0).toBeLessThanOrEqual(6);
    expect(buckets.get('narrowed') ?? 0).toBe(0);
  });
});

describe('resolution refusals', () => {
  it('resolves no IDL and no verification for a closed program', async () => {
    // `8bCAJ…`'s ProgramData account is gone, so nothing about the code that ran
    // is recoverable. The cascade must stop at the deployment check rather than
    // going on to read an IDL that would describe a program with no binary.
    const entry = manifest.entries.find((candidate) =>
      candidate.signature.startsWith('3pFHktzDfY'),
    )!;
    clearResolutionCache();
    const { finding } = await resolveFixture(entry);

    expect(finding.resolution?.deployment.kind).toBe('closed');
    expect(finding.resolution?.idl).toBeNull();
    expect(finding.resolution?.verification).toBeNull();
    expect(finding.error.naming).toBe('none');
  });

  it('keeps refusing a reserved-range code when the program publishes no IDL', async () => {
    // `4F3t3Tpi…` returns Custom(3) and has no IDL. Resolution running does not
    // make the refusal any weaker.
    const entry = manifest.entries.find((candidate) =>
      candidate.signature.startsWith('2L2Z8DkPRK'),
    )!;
    clearResolutionCache();
    const analysis = await resolveFixture(entry);

    expect(analysis.confidence).toBe('unknown');
    expect(analysis.finding.error).toMatchObject({ code: 3, name: null, naming: 'none' });
    expect(analysis.finding.resolution?.notes.join(' ')).toMatch(/publishes no IDL/);
  });

  it('records the deployment provenance it proved', async () => {
    const snapshot = programSnapshot('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    const entry = manifest.entries.find((candidate) =>
      candidate.signature.startsWith('3BFz86dEZ2'),
    )!;
    clearResolutionCache();
    const { finding } = await resolveFixture(entry);

    expect(finding.resolution?.deployment).toMatchObject({
      kind: 'live',
      programData: snapshot.programDataHeader?.address,
    });
    expect(finding.resolution?.idl).toMatchObject({ programName: 'whirlpool', spec: '0.1.0' });
  });
});
