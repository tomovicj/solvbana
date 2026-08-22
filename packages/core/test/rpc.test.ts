import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountSource, createTransactionSource, explainNotFound } from '@solvbana/core';

/**
 * Drive the client through a stubbed `fetch`.
 *
 * The escalation that separates "never landed" from "outside the retention
 * window" is the whole point of this layer, and it is defined by which endpoints
 * were actually consulted — so the test has to control the wire, not the client.
 */
type Responder = (url: string, method: string) => unknown;

function requestBody(init: RequestInit | undefined): { method: string; params: unknown[] } {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
    method: string;
    params: unknown[];
  };
}

function stubRpc(responder: Responder): void {
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const url = input;
    const body = requestBody(init);
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: responder(url, body.method) }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

const PRIMARY = 'https://primary.example';
const ARCHIVE = 'https://archive.example';
const SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

const found = { slot: 1, blockTime: null, version: 0, transaction: {}, meta: {} };
const noStatus = { context: { slot: 1 }, value: [null] };
const hasStatus = { context: { slot: 1 }, value: [{ slot: 1, err: null, confirmations: null }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTransactionSource', () => {
  it('returns the transaction from the primary endpoint', async () => {
    stubRpc((_url, method) => (method === 'getTransaction' ? found : null));
    const source = createTransactionSource({ rpcUrl: PRIMARY });

    await expect(source.fetchTransaction(SIGNATURE)).resolves.toMatchObject({
      kind: 'found',
      endpoint: 'primary',
    });
  });

  it('falls back to the archive when the primary has nothing', async () => {
    stubRpc((url, method) =>
      method === 'getTransaction' && url === ARCHIVE
        ? found
        : method === 'getTransaction'
          ? null
          : noStatus,
    );
    const source = createTransactionSource({ rpcUrl: PRIMARY, archiveRpcUrl: ARCHIVE });

    await expect(source.fetchTransaction(SIGNATURE)).resolves.toMatchObject({
      kind: 'found',
      endpoint: 'archive',
    });
  });

  it('will not claim "never landed" when the primary cannot see past its retention', async () => {
    // A node whose oldest block is not genesis has a window the search cannot
    // see past, so asserting the transaction never landed would overstate it.
    stubRpc((_url, method) => {
      if (method === 'getSignatureStatuses') return noStatus;
      if (method === 'getFirstAvailableBlock') return 250000000;
      return null;
    });

    expect(
      await createTransactionSource({ rpcUrl: PRIMARY }).fetchTransaction(SIGNATURE),
    ).toMatchObject({
      kind: 'not-found',
      searchedArchive: false,
      reason: { kind: 'outside-searched-window', firstAvailableSlot: 250000000n },
    });
  });

  it('concludes "never landed" when the archive also came up empty', async () => {
    stubRpc((_url, method) => (method === 'getSignatureStatuses' ? noStatus : null));
    const source = createTransactionSource({ rpcUrl: PRIMARY, archiveRpcUrl: ARCHIVE });

    expect(await source.fetchTransaction(SIGNATURE)).toMatchObject({
      kind: 'not-found',
      searchedArchive: true,
      reason: { kind: 'never-landed', basis: 'archive-searched' },
    });
  });

  it('concludes "never landed" from a primary that serves the full ledger', async () => {
    // Oldest block at genesis means nothing was out of the search's reach, so
    // the retention window is ruled out without a separate archive endpoint.
    stubRpc((_url, method) => {
      if (method === 'getSignatureStatuses') return noStatus;
      if (method === 'getFirstAvailableBlock') return 0;
      return null;
    });

    expect(
      await createTransactionSource({ rpcUrl: PRIMARY }).fetchTransaction(SIGNATURE),
    ).toMatchObject({
      kind: 'not-found',
      reason: { kind: 'never-landed', basis: 'primary-serves-full-history' },
    });
  });

  it('distinguishes a landed transaction whose record is not being served', async () => {
    stubRpc((_url, method) => (method === 'getSignatureStatuses' ? hasStatus : null));
    const source = createTransactionSource({ rpcUrl: PRIMARY, archiveRpcUrl: ARCHIVE });

    expect(await source.fetchTransaction(SIGNATURE)).toMatchObject({
      kind: 'not-found',
      reason: { kind: 'landed-but-unavailable' },
    });
  });

  it('reports an RPC failure as such rather than as a missing transaction', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));
    const source = createTransactionSource({ rpcUrl: PRIMARY });

    expect(await source.fetchTransaction(SIGNATURE)).toMatchObject({
      kind: 'rpc-error',
      endpoint: 'primary',
    });
  });

  it('requests every transaction with a version ceiling', async () => {
    // Omitting maxSupportedTransactionVersion errors on every v0 transaction.
    const bodies: { method: string; params: unknown[] }[] = [];
    vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
      bodies.push(requestBody(init));
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: found }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    await createTransactionSource({ rpcUrl: PRIMARY }).fetchTransaction(SIGNATURE);

    const call = bodies.find((body) => body.method === 'getTransaction');
    expect(call?.params[1]).toMatchObject({ maxSupportedTransactionVersion: 0, encoding: 'json' });
  });
});

describe('createAccountSource', () => {
  const ADDRESS = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

  function stubAccount(value: unknown, slot = 100): { params: unknown[] }[] {
    const calls: { params: unknown[] }[] = [];
    vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
      calls.push(requestBody(init));
      return Promise.resolve(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value } }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    return calls;
  }

  it('carries the slot the read was served at', async () => {
    // Source resolution compares a deployment slot against this, so a read
    // without it cannot answer whether a program was upgraded since.
    stubAccount(
      {
        owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: true,
        data: ['AAAA', 'base64'],
        space: 36,
      },
      439652088,
    );

    await expect(
      createAccountSource({ rpcUrl: PRIMARY }).fetchAccount(ADDRESS),
    ).resolves.toMatchObject({
      readAtSlot: 439652088n,
      owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
    });
  });

  it('reports the full on-chain size even when only a prefix was fetched', async () => {
    // A ProgramData account is megabytes of mostly padding; the header read has
    // to say how much it did not fetch, and `space` is the only thing that does.
    const calls = stubAccount({
      owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
      executable: false,
      data: ['AAAA', 'base64'],
      space: 10485760,
    });

    const account = await createAccountSource({ rpcUrl: PRIMARY }).fetchAccountPrefix(ADDRESS, 45);

    expect(account?.size).toBe(10485760);
    expect(calls[0]?.params[1]).toMatchObject({ dataSlice: { offset: 0, length: 45 } });
  });

  it('returns null for an account that does not exist', async () => {
    stubAccount(null);
    await expect(
      createAccountSource({ rpcUrl: PRIMARY }).fetchAccount(ADDRESS),
    ).resolves.toBeNull();
  });
});

describe('explainNotFound', () => {
  it('tells the two ambiguous outcomes apart in plain words', () => {
    const outsideWindow = explainNotFound({
      kind: 'outside-searched-window',
      firstAvailableSlot: 42n,
    });
    expect(outsideWindow).toMatch(/retention window/);
    expect(outsideWindow).toMatch(/SOLANA_ARCHIVE_RPC_URL/);
    expect(outsideWindow).toMatch(/slot 42/);

    expect(explainNotFound({ kind: 'never-landed', basis: 'archive-searched' })).toMatch(
      /preflight|dropped|expired/,
    );
    // The full-history conclusion has to name the evidence it rests on.
    expect(explainNotFound({ kind: 'never-landed', basis: 'primary-serves-full-history' })).toMatch(
      /genesis/,
    );
  });
});
