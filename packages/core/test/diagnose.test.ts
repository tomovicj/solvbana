import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnose, reviveRawTransaction, type TransactionSource } from '@solvbana/core';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');

function fixtureSource(...parts: string[]): TransactionSource {
  const raw = reviveRawTransaction(
    JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as unknown,
  );
  return { fetchTransaction: () => Promise.resolve({ kind: 'found', raw, endpoint: 'primary' }) };
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
