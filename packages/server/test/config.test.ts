import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const MINIMAL = { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' };

describe('loadConfig', () => {
  it('applies defaults for everything but the RPC URL', () => {
    const result = loadConfig(MINIMAL);

    expect(result).toMatchObject({
      ok: true,
      config: { HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'info', NODE_ENV: 'development' },
    });
  });

  it('coerces PORT from the string the environment always provides', () => {
    const result = loadConfig({ ...MINIMAL, PORT: '8080' });

    expect(result).toMatchObject({ ok: true, config: { PORT: 8080 } });
  });

  it('names the missing key instead of throwing', () => {
    const result = loadConfig({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('SOLANA_RPC_URL');
  });

  it('rejects an RPC URL that is not http(s)', () => {
    const result = loadConfig({ SOLANA_RPC_URL: 'not-a-url' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('SOLANA_RPC_URL');
  });

  it('reports several invalid keys in one pass', () => {
    const result = loadConfig({ ...MINIMAL, PORT: '99999', LOG_LEVEL: 'chatty' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
