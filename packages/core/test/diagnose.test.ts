import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearResolutionCache,
  diagnose,
  reviveRawTransaction,
  type TransactionSource,
} from '@solvbana/core';
import { corpusAccounts, readJson } from './fixtures.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');

function fixtureSource(...parts: string[]): TransactionSource {
  const raw = reviveRawTransaction(
    JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as unknown,
  );
  return { fetchTransaction: () => Promise.resolve({ kind: 'found', raw, endpoint: 'primary' }) };
}

interface CorpusEntry {
  signature: string;
  file: string;
  phase1: { program: string };
}

function corpusEntry(prefix: string): CorpusEntry {
  const { entries } = readJson<{ entries: CorpusEntry[] }>('manifest.json');
  const entry = entries.find((candidate) => candidate.signature.startsWith(prefix));
  if (entry === undefined) throw new Error(`No corpus entry starting ${prefix}`);
  return entry;
}

const SIGNATURE = 'sig';

describe('diagnose', () => {
  it('names the failing instruction and its error', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'unresolved-lookups.json'),
    });

    // The program published no name for 6001, so it stays a number.
    expect(result.summary).toMatch(/Instruction 1 of 1 failed/);
    expect(result.summary).toMatch(/Custom\(6001\)/);
    expect(result.transaction?.error).toMatchObject({ kind: 'instruction-error', index: 0 });
  });

  it('refuses to name a code the program never published, and says so', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'unresolved-lookups.json'),
    });

    expect(result.confidence).toBe('unknown');
    expect(result.candidates).toEqual([]);
    expect(result.finding?.error).toMatchObject({ code: 6001, name: null, naming: 'none' });
    expect(result.reasons[0]).toMatch(/reserved ranges/);
  });

  it('reports a throw site the program printed about itself', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'null-stack-height.json'),
    });

    // Anchor named the error and blamed an account but printed no line, so the
    // answer is identified without being located.
    expect(result.confidence).toBe('variant-only');
    expect(result.candidates).toEqual([]);
    expect(result.finding).toMatchObject({
      handler: null,
      error: { code: 2006, name: 'ConstraintSeeds', naming: 'logged' },
      failure: { kind: 'anchor', account: 'vault' },
    });
    expect(result.summary).toMatch(/ConstraintSeeds \(2006\)/);
  });

  it('names a code the logs left undecoded once an IDL licenses the table', async () => {
    // The end-to-end shape of Phase 2: Whirlpool returns Custom(2012) and logs
    // nothing about it, so the logs alone must refuse. Its published IDL is what
    // establishes that Anchor defines the code, and the handler falls out of the
    // discriminator at the same time.
    clearResolutionCache();
    const entry = corpusEntry('3BFz86dEZ2');
    const result = await diagnose(entry.signature, {
      source: fixtureSource('transactions', entry.file),
      accounts: corpusAccounts([entry.phase1.program]),
    });

    expect(result.confidence).toBe('variant-only');
    expect(result.finding?.error).toMatchObject({
      code: 2012,
      name: 'ConstraintAddress',
      naming: 'anchor-builtin',
    });
    expect(result.finding?.handlerSource).toBe('discriminator');
    expect(result.finding?.resolution?.deployment.kind).toBe('live');
    expect(result.summary).toMatch(/ConstraintAddress \(2012\)/);
  });

  it('answers from the logs alone when no account source is supplied', async () => {
    // Resolution is an enrichment, not a prerequisite. Without accounts the
    // diagnosis is exactly what Phase 1 established.
    clearResolutionCache();
    const entry = corpusEntry('3BFz86dEZ2');
    const result = await diagnose(entry.signature, {
      source: fixtureSource('transactions', entry.file),
    });

    expect(result.confidence).toBe('unknown');
    expect(result.finding?.resolution).toBeUndefined();
  });

  it('keeps the log-derived answer when resolution throws', async () => {
    clearResolutionCache();
    const entry = corpusEntry('3BFz86dEZ2');
    const result = await diagnose(entry.signature, {
      source: fixtureSource('transactions', entry.file),
      accounts: {
        fetchAccount: () => Promise.reject(new Error('endpoint down')),
        fetchAccountPrefix: () => Promise.reject(new Error('endpoint down')),
      },
    });

    expect(result.confidence).toBe('unknown');
    expect(result.summary).toMatch(/Custom\(2012\)/);
    expect(result.reasons.join(' ')).toMatch(/endpoint down/);
  });

  it('names the program that originated a failure, not the one that propagated it', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'native-custom-error.json'),
    });

    expect(result.finding?.program).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(result.finding?.handler).toBe('Transfer');
  });

  it('carries every ingest degradation into the reasons', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'truncated-logs.json'),
    });

    expect(result.reasons.join('\n')).toMatch(/truncated/);
  });

  it('does not name an instruction for a transaction-level failure', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'transaction-level-error.json'),
    });

    expect(result.summary).toBe(
      'Transaction failed with InsufficientFundsForRent (account index 1).',
    );
  });

  it('answers rather than throws when the signature resolved to nothing', async () => {
    const source: TransactionSource = {
      fetchTransaction: () =>
        Promise.resolve({
          kind: 'not-found',
          reason: { kind: 'never-landed', basis: 'archive-searched' },
          searchedArchive: true,
        }),
    };

    const result = await diagnose(SIGNATURE, { source });
    expect(result.confidence).toBe('unknown');
    expect(result.summary).toMatch(/No transaction record/);
    expect(result.reasons[0]).toMatch(/preflight/);
    expect(result.transaction).toBeUndefined();
  });

  it('answers rather than throws when the RPC failed', async () => {
    const source: TransactionSource = {
      fetchTransaction: () =>
        Promise.resolve({ kind: 'rpc-error', endpoint: 'primary', message: 'boom' }),
    };

    const result = await diagnose(SIGNATURE, { source });
    expect(result.confidence).toBe('unknown');
    expect(result.reasons[0]).toMatch(/boom/);
  });

  it('says when the answer came from the archive endpoint', async () => {
    const raw = reviveRawTransaction(
      JSON.parse(readFileSync(join(FIXTURES, 'synthetic', 'no-logs.json'), 'utf8')) as unknown,
    );
    const source: TransactionSource = {
      fetchTransaction: () => Promise.resolve({ kind: 'found', raw, endpoint: 'archive' }),
    };

    const result = await diagnose(SIGNATURE, { source });
    expect(result.reasons.join('\n')).toMatch(/archive endpoint/);
  });
});
