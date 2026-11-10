import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearResolutionCache,
  forgetProgram,
  resolveProgram,
  type AccountSource,
  type ArtifactStore,
} from '@solvbana/core';
import { createResolutionCache } from '../../src/resolve/resolve.ts';
import { corpusAccounts } from '../fixtures.ts';

const PROGRAM_A = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PROGRAM_B = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
/** Far beyond any recorded deployment slot, so the recorded deployment is live. */
const LATER = 10n ** 12n;
/** Before any deployment, so the recorded deployment postdates it. */
const EARLIER = 0n;

function counting(): { source: AccountSource; reads: () => number } {
  const inner = corpusAccounts([PROGRAM_A, PROGRAM_B]);
  let count = 0;
  return {
    source: {
      fetchAccount: (address) => {
        count += 1;
        return inner.fetchAccount(address);
      },
      fetchAccountPrefix: (address, length) => {
        count += 1;
        return inner.fetchAccountPrefix(address, length);
      },
    },
    reads: () => count,
  };
}

beforeEach(() => {
  clearResolutionCache();
});

describe('the resolution cache', () => {
  it('does not re-read accounts beyond the deployment check on a second resolve', async () => {
    const { source, reads } = counting();

    await resolveProgram(PROGRAM_A, EARLIER, { accounts: source });
    const deploymentOnly = reads();
    expect(deploymentOnly).toBeGreaterThan(0);

    const before = reads();
    await resolveProgram(PROGRAM_A, LATER, { accounts: source });
    const first = reads() - before;
    expect(first).toBeGreaterThan(deploymentOnly);

    const beforeSecond = reads();
    const result = await resolveProgram(PROGRAM_A, LATER, { accounts: source });
    expect(result.resolution.deployment.kind).toBe('live');
    expect(reads() - beforeSecond).toBe(deploymentOnly);
  });

  it('shares an entry between differently ordered discriminators', async () => {
    const { source } = counting();
    const one = await resolveProgram(
      PROGRAM_A,
      LATER,
      { accounts: source },
      { observedDiscriminators: ['aa', 'bb'] },
    );
    const two = await resolveProgram(
      PROGRAM_A,
      LATER,
      { accounts: source },
      { observedDiscriminators: ['bb', 'aa'] },
    );
    expect(two).toBe(one);
  });

  it('drops only the named program on forgetProgram', async () => {
    const { source, reads } = counting();
    const a = await resolveProgram(PROGRAM_A, LATER, { accounts: source });
    const b = await resolveProgram(PROGRAM_B, LATER, { accounts: source });

    forgetProgram(PROGRAM_A);

    expect(await resolveProgram(PROGRAM_B, LATER, { accounts: source })).toBe(b);
    const before = reads();
    const again = await resolveProgram(PROGRAM_A, LATER, { accounts: source });
    expect(again).not.toBe(a);
    expect(reads() - before).toBeGreaterThan(1);
  });

  it('never shares an entry between scopes, and shares one within a scope', async () => {
    const { source } = counting();
    const a1 = await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'a' });
    const b1 = await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'b' });
    expect(b1).not.toBe(a1);
    expect(await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'a' })).toBe(
      a1,
    );
    expect(await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'b' })).toBe(
      b1,
    );
  });

  it("keeps one scope's uploaded IDL out of another scope", async () => {
    const { source } = counting();
    const supplied: ArtifactStore = {
      fetchIdl: () =>
        Promise.resolve({
          document: {
            name: 'mine',
            instructions: [{ name: 'go', accounts: [], args: [] }],
            errors: [],
          },
        }),
    };
    const empty: ArtifactStore = { fetchIdl: () => Promise.resolve(null) };
    const observed = { observedDiscriminators: [] as string[] };
    const withIdl = await resolveProgram(
      PROGRAM_A,
      LATER,
      { accounts: source, artifacts: supplied },
      { ...observed, cacheScope: 'a' },
    );
    const without = await resolveProgram(
      PROGRAM_A,
      LATER,
      { accounts: source, artifacts: empty },
      { ...observed, cacheScope: 'b' },
    );
    expect(without).not.toBe(withIdl);
    expect(without.resolution.notes.join('\n')).not.toContain('mine');
  });

  it('forgetProgram clears every scope', async () => {
    const { source } = counting();
    const a = await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'a' });
    const b = await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'b' });
    forgetProgram(PROGRAM_A);
    expect(
      await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'a' }),
    ).not.toBe(a);
    expect(
      await resolveProgram(PROGRAM_A, LATER, { accounts: source }, { cacheScope: 'b' }),
    ).not.toBe(b);
  });

  it('never caches a non-live deployment', async () => {
    const { source } = counting();
    const one = await resolveProgram(PROGRAM_A, EARLIER, { accounts: source });
    expect(one.resolution.deployment.kind).toBe('upgraded-since');
    const two = await resolveProgram(PROGRAM_A, EARLIER, { accounts: source });
    expect(two).not.toBe(one);
  });

  it('does not store a resolution that was in flight when the program was forgotten', async () => {
    const inner = corpusAccounts([PROGRAM_A, PROGRAM_B]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const slow: AccountSource = {
      fetchAccount: (address) => inner.fetchAccount(address),
      fetchAccountPrefix: async (address, length) => {
        if (held) await gate;
        return inner.fetchAccountPrefix(address, length);
      },
    };

    const pending = resolveProgram(PROGRAM_A, LATER, { accounts: slow });
    await Promise.resolve();
    forgetProgram(PROGRAM_A);
    held = false;
    release();
    const stale = await pending;

    // The in-flight call still answers its caller, but the next one recomputes.
    const next = await resolveProgram(PROGRAM_A, LATER, { accounts: slow });
    expect(next).not.toBe(stale);
    expect(await resolveProgram(PROGRAM_A, LATER, { accounts: slow })).toBe(next);
  });

  it('clearResolutionCache drops everything', async () => {
    const { source } = counting();
    const a = await resolveProgram(PROGRAM_A, LATER, { accounts: source });
    clearResolutionCache();
    expect(await resolveProgram(PROGRAM_A, LATER, { accounts: source })).not.toBe(a);
  });
});

describe('createResolutionCache', () => {
  const value = { resolution: {}, idl: null } as never;

  it('evicts the least recently used entry and keeps the recently used one', () => {
    const lru = createResolutionCache(2);
    lru.set('p@1:false:', value);
    lru.set('q@1:false:', value);
    expect(lru.get('p@1:false:')).toBe(value); // p is now most recent
    lru.set('r@1:false:', value);

    expect(lru.keys()).toEqual(['p@1:false:', 'r@1:false:']);
    expect(lru.has('q@1:false:')).toBe(false);
  });

  it('never grows past its capacity', () => {
    const lru = createResolutionCache(3);
    for (let i = 0; i < 10; i += 1) lru.set(`p${String(i)}@1:false:`, value);
    expect(lru.keys()).toHaveLength(3);
  });
});
