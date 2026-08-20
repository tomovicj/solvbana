import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviveRawTransaction, type FetchOutcome, type TransactionSource } from '@solvbana/core';
import { buildApp, type BuildAppOptions } from '../src/app.ts';
import type { AppConfig } from '../src/config.ts';

export const TEST_CONFIG: AppConfig = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
  // Empty disables verified-build lookups, which keeps the suite off the network
  // even if a test ever supplies an account source.
  SOLVBANA_VERIFY_REGISTRY_URL: '',
};

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');

/** A source backed by a recorded fixture, so no test touches the network. */
export function fixtureSource(...parts: string[]): TransactionSource {
  const raw = reviveRawTransaction(
    JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as unknown,
  );
  return { fetchTransaction: () => Promise.resolve({ kind: 'found', raw, endpoint: 'primary' }) };
}

export function outcomeSource(outcome: FetchOutcome): TransactionSource {
  return { fetchTransaction: () => Promise.resolve(outcome) };
}

/**
 * A source that fails the test if it is ever called.
 *
 * Routes that reject their input must do so before spending an RPC call, and
 * this is what proves it rather than assuming it.
 */
export function unreachableSource(): TransactionSource {
  return {
    fetchTransaction: () => {
      throw new Error('The RPC source was called for a request that should never have reached it.');
    },
  };
}

export function testApp(options: BuildAppOptions = {}) {
  return buildApp(TEST_CONFIG, { source: unreachableSource(), ...options });
}
