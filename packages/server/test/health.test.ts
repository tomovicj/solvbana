import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.ts';

const app = testApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('reports status, version and uptime', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      version: expect.any(String) as unknown,
      uptimeSeconds: expect.any(Number) as unknown,
    });
  });
});

describe('unknown routes', () => {
  it('returns the standard error shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
