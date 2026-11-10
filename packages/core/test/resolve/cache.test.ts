import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearResolutionCache,
  forgetProgram,
  resolveProgram,
  type AccountSource,
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

  it('never caches a non-live deployment', async () => {
    const { source } = counting();
    const one = await resolveProgram(PROGRAM_A, EARLIER, { accounts: source });
    expect(one.resolution.deployment.kind).toBe('upgraded-since');
    const two = await resolveProgram(PROGRAM_A, EARLIER, { accounts: source });
    expect(two).not.toBe(one);
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
