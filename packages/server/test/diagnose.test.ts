import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureSource, outcomeSource, testApp } from './helpers.ts';

const VALID_SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

/** Rejection paths must not reach the RPC, so this app's source throws if called. */
const rejecting = testApp();
const diagnosing = testApp({
  source: fixtureSource('synthetic', 'null-stack-height.json'),
});
const missing = testApp({
  source: outcomeSource({
    kind: 'not-found',
    reason: { kind: 'outside-searched-window', firstAvailableSlot: null },
    searchedArchive: false,
  }),
});

beforeAll(async () => {
  await Promise.all([rejecting.ready(), diagnosing.ready(), missing.ready()]);
});

afterAll(async () => {
  await Promise.all([rejecting.close(), diagnosing.close(), missing.close()]);
});

describe('POST /diagnose', () => {
  it('returns the normalized transaction alongside the diagnosis', async () => {
    const response = await diagnosing.inject({
      method: 'POST',
      url: '/diagnose',
      payload: { signature: VALID_SIGNATURE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      signature: string;
      confidence: string;
      summary: string;
      candidates: unknown[];
      reasons: string[];
      transaction: {
        slot: string;
        fee: string;
        error: { kind: string; index: number };
        instructions: { stackHeight: number; cpiDepthUnavailable: boolean }[];
        logs: { truncated: boolean; lines: { event: { kind: string } }[] };
        accounts: { keys: unknown[] };
      };
    }>();

    expect(body.signature).toBe(VALID_SIGNATURE);
    expect(body.confidence).toBe('unknown');
    // No location may be invented while the later tiers are unimplemented.
    expect(body.candidates).toEqual([]);
    // A weak answer always explains itself.
    expect(body.reasons.length).toBeGreaterThan(0);

    expect(body.summary).toMatch(/Instruction 1 of 1 failed/);
    expect(body.transaction.error).toMatchObject({ kind: 'instruction-error', index: 0 });
    // bigints cross the wire as strings; JSON has no bigint.
    expect(body.transaction.slot).toBe('300000003');
    expect(body.transaction.fee).toBe('5000');
    // The tree is flattened depth-first for the wire, with depth in stackHeight.
    expect(body.transaction.instructions.map((node) => node.stackHeight)).toEqual([1, 2, 2]);
    expect(body.transaction.instructions[0]?.cpiDepthUnavailable).toBe(true);
    expect(body.transaction.logs.lines.length).toBeGreaterThan(0);
    expect(body.transaction.accounts.keys).toHaveLength(4);
  });

  it('reports a signature that resolved to nothing as an honest unknown, not an error', async () => {
    const response = await missing.inject({
      method: 'POST',
      url: '/diagnose',
      payload: { signature: VALID_SIGNATURE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ confidence: string; reasons: string[]; transaction?: unknown }>();

    expect(body.confidence).toBe('unknown');
    expect(body.reasons.join('\n')).toMatch(/retention window/);
    expect(body.transaction).toBeUndefined();
  });

  it('rejects a malformed signature with 400 before any lookup', async () => {
    const response = await rejecting.inject({
      method: 'POST',
      url: '/diagnose',
      payload: { signature: 'not-base58!!' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_signature.bad-alphabet' },
    });
  });

  it('rejects base58 of the wrong byte length', async () => {
    const response = await rejecting.inject({
      method: 'POST',
      url: '/diagnose',
      payload: { signature: 'So11111111111111111111111111111111111111112' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_signature.bad-length' } });
  });

  it('rejects a body missing the signature field', async () => {
    const response = await rejecting.inject({ method: 'POST', url: '/diagnose', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { message: expect.any(String) as unknown } });
  });
});
