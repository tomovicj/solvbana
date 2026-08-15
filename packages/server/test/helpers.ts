import { buildApp } from '../src/app.ts';
import type { AppConfig } from '../src/config.ts';

export const TEST_CONFIG: AppConfig = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
};

export function testApp() {
  return buildApp(TEST_CONFIG);
}
