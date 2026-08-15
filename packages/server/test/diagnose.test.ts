import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.ts';

const VALID_SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

const app = testApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('POST /diagnose', () => {
  it('returns an honest unknown diagnosis rather than a 501', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/diagnose',
      payload: { signature: VALID_SIGNATURE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      signature: string;
      confidence: string;
      candidates: unknown[];
      reasons: string[];
    }>();

    expect(body.signature).toBe(VALID_SIGNATURE);
    expect(body.confidence).toBe('unknown');
    // No location may be invented while the tiers are unimplemented.
    expect(body.candidates).toEqual([]);
    // A weak answer always explains itself.
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it('rejects a malformed signature with 400 before any lookup', async () => {
    const response = await app.inject({
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
    const response = await app.inject({
      method: 'POST',
      url: '/diagnose',
      payload: { signature: 'So11111111111111111111111111111111111111112' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_signature.bad-length' } });
  });

  it('rejects a body missing the signature field', async () => {
    const response = await app.inject({ method: 'POST', url: '/diagnose', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { message: expect.any(String) as unknown } });
  });
});
