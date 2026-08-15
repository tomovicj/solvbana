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

    // Phase 0 decodes the code but cannot name the variant, so it stays a number.
    expect(result.summary).toMatch(/Instruction 1 of 1 failed/);
    expect(result.summary).toMatch(/Custom\(6001\)/);
    expect(result.transaction?.error).toMatchObject({ kind: 'instruction-error', index: 0 });
  });

  it('stays at unknown confidence and says why', async () => {
    const result = await diagnose(SIGNATURE, {
      source: fixtureSource('synthetic', 'unresolved-lookups.json'),
    });

    expect(result.confidence).toBe('unknown');
    expect(result.candidates).toEqual([]);
    expect(result.reasons[0]).toMatch(/no source has been resolved/);
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
