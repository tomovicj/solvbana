import { describe, expect, it } from 'vitest';
import { reviveRawTransaction } from '@solvbana/core';
import { readJson } from '../fixtures.ts';

describe('reviveRawTransaction, version 1', () => {
  it('revives transactionConfig numbers to bigint, as kit does at runtime', () => {
    const raw = reviveRawTransaction(
      readJson(
        'transactions',
        '2Ku3fgEnLrzkHzSMv38eAR9C1LZqsBkfrdDVsZzczMNfynuWYqvnTTbDnGWPg2ZTe5SD7KQaAU5MPDUoFZkdjajw.json',
      ),
    );

    expect(raw.transaction.message.transactionConfig).toEqual({
      priorityFee: 19n,
      computeUnitLimit: 38n,
      loadedAccountsDataSizeLimit: 32000n,
      heapSize: null,
    });
  });

  it('preserves null as null rather than reviving it to zero', () => {
    const raw = reviveRawTransaction(
      readJson(
        'transactions',
        '2WCoeS1dpMjPuG8PjGvAaMJ9eGHz9P1o1UhE5we3GbBaQtoLs9UoDoYgBM8EcT1szgG1bYUJcLb4HezC5CVGRxVC.json',
      ),
    );

    const config = raw.transaction.message.transactionConfig;
    expect(config?.priorityFee).toBeNull();
    expect(config?.heapSize).toBeNull();
    expect(config?.computeUnitLimit).toBe(160012n);
  });

  it('leaves a message without a transactionConfig alone', () => {
    const raw = reviveRawTransaction(readJson('synthetic', 'unresolved-lookups.json'));

    expect('transactionConfig' in raw.transaction.message).toBe(false);
  });
});
