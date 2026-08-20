import { describe, expect, it } from 'vitest';
import {
  analyze,
  clearResolutionCache,
  diagnose,
  explainFailure,
  normalizeTransaction,
  refineWithResolution,
  resolveProgram,
  reviveRawTransaction,
  type Confidence,
  type Diagnosis,
  type Explanation,
} from '@solvbana/core';
import { corpusAccounts, readJson } from '../fixtures.ts';

interface Entry {
  signature: string;
  file: string;
  phase1: { confidence: Confidence; program: string | null; account: string | null };
  phase4?: {
    namedAccounts: boolean;
    derivation?: { account: string; status: string; source: string };
  };
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

function sourceFor(entry: Entry) {
  return {
    fetchTransaction: () =>
      Promise.resolve({
        kind: 'found' as const,
        raw: reviveRawTransaction(readJson('transactions', entry.file)),
        endpoint: 'primary' as const,
      }),
  };
}

async function diagnoseFixture(entry: Entry): Promise<Diagnosis> {
  clearResolutionCache();
  return diagnose(entry.signature, { source: sourceFor(entry), accounts });
}

/** The explanation alone, for the invariants that compare against no explanation. */
async function explainFixture(entry: Entry): Promise<Explanation> {
  clearResolutionCache();
  const transaction = normalizeTransaction(
    reviveRawTransaction(readJson('transactions', entry.file)),
    entry.signature,
  );
  const base = analyze(transaction);
  const programId = base.finding.program;
  if (programId === null) return explainFailure(transaction, base.finding, null);

  const resolved = await resolveProgram(programId, transaction.slot, { accounts });
  const refined = refineWithResolution(base, transaction, resolved);
  return explainFailure(transaction, refined.finding, resolved.idl);
}

describe('explaining the corpus', () => {
  it('never changes the confidence or the candidates', async () => {
    // The load-bearing invariant of this tier. It explains what earlier tiers
    // established and locates nothing new, so a diagnosis must read exactly the
    // same with the explanation attached as without it.
    for (const entry of manifest.entries) {
      const withExplanation = await diagnoseFixture(entry);

      clearResolutionCache();
      const transaction = normalizeTransaction(
        reviveRawTransaction(readJson('transactions', entry.file)),
        entry.signature,
      );
      const base = analyze(transaction);
      const programId = base.finding.program;
      const baseline =
        programId === null
          ? base
          : refineWithResolution(
              base,
              transaction,
              await resolveProgram(programId, transaction.slot, { accounts }),
            );

      expect(withExplanation.confidence, entry.signature).toBe(baseline.confidence);
      expect(withExplanation.candidates, entry.signature).toEqual(baseline.candidates);
    }
  });

  it('answers every fixture rather than throwing on any of them', async () => {
    for (const entry of manifest.entries) {
      const diagnosis = await diagnoseFixture(entry);

      expect(diagnosis.explanation, entry.signature).toBeDefined();
      expect(diagnosis.explanation?.guidance.meaning.length, entry.signature).toBeGreaterThan(0);
    }
  });

  it('never reports a derived address it could not fully resolve', async () => {
    // A derivation from a partial seed set would be exactly the confident and
    // wrong answer this project exists to avoid.
    for (const entry of manifest.entries) {
      for (const check of (await explainFixture(entry)).derivations) {
        if (check.status === 'match' || check.status === 'mismatch') {
          expect(check.expected, `${entry.signature} ${check.account}`).not.toBeNull();
          expect(check.seeds.every((seed) => seed.bytes !== null)).toBe(true);
        } else {
          expect(check.expected, `${entry.signature} ${check.account}`).toBeNull();
        }
      }
    }
  });

  it('explains every absence it leaves behind', async () => {
    // Degrade in tiers: an account table that was not built, an argument list
    // that was not decoded, and a name that was not attached each owe the
    // reader a reason.
    for (const entry of manifest.entries) {
      const explanation = await explainFixture(entry);
      if (explanation.accounts.length === 0) {
        expect(explanation.notes.length, entry.signature).toBeGreaterThan(0);
      }
      if (explanation.accounts.length > 0 && explanation.accounts.every((a) => a.name === null)) {
        expect(explanation.notes.length, entry.signature).toBeGreaterThan(0);
      }
    }
  });

  it.each(
    manifest.entries
      .filter((entry) => entry.phase4 !== undefined)
      .map((entry) => [entry.signature.slice(0, 8), entry] as const),
  )('explains %s the way the manifest says', async (label, entry) => {
    const explanation = await explainFixture(entry);
    const expected = entry.phase4!;

    expect(
      explanation.accounts.some((row) => row.name !== null),
      `${label} names`,
    ).toBe(expected.namedAccounts);

    if (expected.derivation !== undefined) {
      const check = explanation.derivations.find(
        (entry_) => entry_.account === expected.derivation!.account,
      );
      expect(check, `${label} derivation`).toBeDefined();
      expect(check?.status, `${label} status`).toBe(expected.derivation.status);
      expect(check?.source, `${label} source`).toBe(expected.derivation.source);
    }
  });
});

/**
 * How far the explanation reaches, measured rather than asserted case by case.
 *
 * Phase 3 was deferred because its premise turned out to cover four fixtures;
 * this exists so the same shortfall in this tier would be visible immediately
 * rather than after the work was done. The bounds are floors, so improving the
 * reach does not fail the suite — only losing it does.
 */
describe('explanation reach', () => {
  it('holds its measured coverage of the corpus', async () => {
    const counts = { accounts: 0, named: 0, args: 0, compute: 0, fix: 0, ataProven: 0, pda: 0 };

    for (const entry of manifest.entries) {
      const explanation = await explainFixture(entry);
      if (explanation.accounts.length > 0) counts.accounts += 1;
      if (explanation.accounts.some((row) => row.name !== null)) counts.named += 1;
      if (explanation.args !== null && explanation.args.length > 0) counts.args += 1;
      if (explanation.compute !== null) counts.compute += 1;
      if (explanation.guidance.fix !== null) counts.fix += 1;
      for (const check of explanation.derivations) {
        if (check.source === 'associated-token' && check.status === 'match') counts.ataProven += 1;
        if (check.source === 'idl-pda' && check.status === 'match') counts.pda += 1;
      }
    }

    expect(counts.compute).toBe(manifest.entries.length);
    expect(counts.accounts).toBeGreaterThanOrEqual(38);
    expect(counts.named).toBeGreaterThanOrEqual(19);
    expect(counts.args).toBeGreaterThanOrEqual(20);
    expect(counts.fix).toBeGreaterThanOrEqual(19);
    expect(counts.ataProven).toBeGreaterThanOrEqual(2);
    expect(counts.pda).toBeGreaterThanOrEqual(37);
  });
});
