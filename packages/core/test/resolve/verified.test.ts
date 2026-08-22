import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  programHash,
  resolveVerifiedBuild,
  selectTrustworthyEntry,
  type AccountSource,
  type Deployment,
} from '@solvbana/core';
import { programSnapshot, snapshotAccounts } from '../fixtures.ts';

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const WHIRLPOOL_HASH = '52e75447d1d49774ff6938484c9011e303860995497f0687a45febb3db21c5b0';

/** 45 bytes of loader header, then the ELF, then the padding the account reserves. */
function programData(elf: number[], padding: number): Uint8Array {
  return Uint8Array.from([
    ...new Array<number>(45).fill(0),
    ...elf,
    ...new Array<number>(padding).fill(0),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('programHash', () => {
  it('hashes the ELF and not the padding around it', () => {
    // A ProgramData account is allocated with room for a bigger future upgrade,
    // so the tail is zeros. Whirlpool's is 10MB holding 1.5MB of program, and
    // hashing the whole buffer produces a number that matches no registry entry.
    const withPadding = programHash(programData([1, 2, 3], 4096));
    const without = programHash(programData([1, 2, 3], 0));

    expect(withPadding).toBe(without);
  });

  it('ignores the loader header', () => {
    const bytes = programData([9, 9], 0);
    bytes.set([3, 0, 0, 0], 0);

    expect(programHash(bytes)).toBe(programHash(programData([9, 9], 0)));
  });
});

describe('selectTrustworthyEntry', () => {
  const verified = {
    is_verified: true,
    on_chain_hash: 'aaaa',
    executable_hash: 'aaaa',
    repo_url: 'https://github.com/org/repo',
    commit: 'abc123',
  };

  it('rejects an entry whose rebuild does not produce the deployed bytes', () => {
    // The registry really does return these alongside good ones: mainnet's
    // status-all for Whirlpool carries an unverified entry for the same
    // repository whose executable_hash differs from what is deployed. Taking the
    // first entry would report a repo that does not build to the running binary.
    const mismatched = { ...verified, is_verified: false, executable_hash: 'bbbb', commit: '' };

    expect(selectTrustworthyEntry([mismatched])).toBeNull();
    expect(selectTrustworthyEntry([mismatched, verified])).toBe(verified);
  });

  it('requires both the verified flag and agreeing hashes', () => {
    expect(selectTrustworthyEntry([{ ...verified, is_verified: false }])).toBeNull();
    expect(selectTrustworthyEntry([{ ...verified, executable_hash: 'bbbb' }])).toBeNull();
    expect(selectTrustworthyEntry([{ ...verified, commit: '' }])).toBeNull();
    expect(selectTrustworthyEntry([])).toBeNull();
  });
});

describe('resolveVerifiedBuild', () => {
  const accounts = snapshotAccounts(programSnapshot(WHIRLPOOL));

  function stubRegistry(body: unknown, ok = true): void {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: ok ? 200 : 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  it('does not consult the registry when the binary is not the one that ran', async () => {
    // The registry describes whatever is deployed now. On an upgraded program
    // that is a true statement about the wrong bytes, which is worse than none.
    vi.stubGlobal('fetch', () => {
      throw new Error('the registry must not be queried for a stale deployment');
    });

    const outcome = await resolveVerifiedBuild(
      WHIRLPOOL,
      { kind: 'upgraded-since', lastDeploySlot: 9n, failingSlot: 1n, programData: 'pd' },
      accounts,
    );

    expect(outcome).toMatchObject({ kind: 'not-applicable' });
  });

  it('reports the disabled registry rather than skipping it silently', async () => {
    const outcome = await resolveVerifiedBuild(
      WHIRLPOOL,
      { kind: 'immutable', loader: 'BPFLoader2111111111111111111111111111111111' },
      accounts,
      { registryUrl: '' },
    );

    expect(outcome.kind).toBe('not-applicable');
  });

  it('says plainly when a program has no entry at all', async () => {
    stubRegistry([]);
    const outcome = await resolveVerifiedBuild(WHIRLPOOL, live(), accounts, {
      registryUrl: 'https://registry.example',
    });

    expect(outcome).toMatchObject({ kind: 'unverified' });
    expect(outcome.kind === 'unverified' && outcome.reason).toMatch(/no entry/);
  });

  it('rejects an entry whose claimed hash is not what is deployed', async () => {
    // The point of the hash is that this tool checked it. Believing the
    // registry's own on_chain_hash would make the check ceremonial.
    stubRegistry([
      {
        is_verified: true,
        on_chain_hash: 'not-the-deployed-hash',
        executable_hash: 'not-the-deployed-hash',
        repo_url: 'https://github.com/org/repo',
        commit: 'abc123',
      },
    ]);

    const outcome = await resolveVerifiedBuild(WHIRLPOOL, live(), accounts, {
      registryUrl: 'https://registry.example',
    });

    expect(outcome).toMatchObject({ kind: 'unverified' });
    expect(outcome.kind === 'unverified' && outcome.reason).toMatch(/different binary/);
  });

  it('reports an entry that rebuilds to the deployed binary but is not marked verified', async () => {
    // The registry refreshes its own on-chain hash on its own schedule, so an
    // entry can rebuild to exactly the bytes that ran and still read unverified.
    // The commit is worth showing — it is right there — but not worth trusting:
    // status-all does not say whether the flag is false because the entry is
    // stale or because it was withdrawn.
    const { source, deployment, hash } = syntheticDeployment();
    stubRegistry([
      {
        is_verified: false,
        on_chain_hash: 'a-hash-from-some-later-deployment',
        executable_hash: hash,
        repo_url: 'https://github.com/org/repo',
        commit: 'e5f089bc5c49b01f5c8abb43c78457ab6c440568',
      },
    ]);

    const outcome = await resolveVerifiedBuild(WHIRLPOOL, deployment, source, {
      registryUrl: 'https://registry.example',
    });

    expect(outcome.kind).toBe('unverified');
    expect(outcome.kind === 'unverified' && outcome.candidate).toMatchObject({
      commit: 'e5f089bc5c49b01f5c8abb43c78457ab6c440568',
      hash,
      registryOnChainHash: 'a-hash-from-some-later-deployment',
    });
    expect(outcome.kind === 'unverified' && outcome.reason).toMatch(/reported rather than trusted/);
  });

  it('carries no candidate when no entry rebuilds to the deployed binary', async () => {
    const { source, deployment } = syntheticDeployment();
    stubRegistry([
      {
        is_verified: false,
        on_chain_hash: 'something-else',
        executable_hash: 'a-rebuild-of-different-source',
        repo_url: 'https://github.com/org/repo',
        commit: 'abc123',
      },
    ]);

    const outcome = await resolveVerifiedBuild(WHIRLPOOL, deployment, source, {
      registryUrl: 'https://registry.example',
    });

    expect(outcome).toMatchObject({ kind: 'unverified', candidate: null });
  });

  it('reports an unreachable registry as unavailable, not as unverified', async () => {
    // "We could not check" and "we checked and it is not verified" are different
    // facts, and only one of them is about the program.
    stubRegistry([], false);
    const outcome = await resolveVerifiedBuild(WHIRLPOOL, live(), accounts, {
      registryUrl: 'https://registry.example',
    });

    expect(outcome.kind).toBe('unavailable');
  });
});

/** A live deployment pointing at Whirlpool's recorded ProgramData account. */
function live() {
  const snapshot = programSnapshot(WHIRLPOOL);
  return {
    kind: 'live' as const,
    programData: snapshot.programDataHeader!.address,
    lastDeploySlot: 398059635n,
    programDataSize: snapshot.programDataHeader!.size,
    readAtSlot: BigInt(snapshot.readAtSlot),
  };
}

describe('the recorded executable hash', () => {
  it('matches what the registry reported for Whirlpool', () => {
    // The snapshot script and the engine compute this independently; if they
    // ever disagree, one of them has the preimage wrong.
    expect(programSnapshot(WHIRLPOOL).executableHash).toBe(WHIRLPOOL_HASH);
  });
});

/**
 * A deployment whose ProgramData bytes are known, so the hash under test is one
 * the test computed rather than one it hard-codes.
 *
 * The recorded corpus snapshots deliberately keep only the 45-byte header — the
 * body is 10MB of mostly zero padding — so the hashing path is covered
 * synthetically instead.
 */
function syntheticDeployment(): {
  source: AccountSource;
  deployment: Extract<Deployment, { kind: 'live' }>;
  hash: string;
} {
  const address = 'CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD';
  const bytes = programData([1, 2, 3, 4, 5], 2048);
  const source: AccountSource = {
    fetchAccount: (requested) =>
      Promise.resolve(
        requested === address
          ? {
              address,
              owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
              executable: false,
              data: Buffer.from(bytes).toString('base64'),
              size: bytes.length,
              readAtSlot: 1n,
            }
          : null,
      ),
    fetchAccountPrefix: () => Promise.resolve(null),
  };

  return {
    source,
    deployment: {
      kind: 'live',
      programData: address,
      lastDeploySlot: 1n,
      programDataSize: bytes.length,
      readAtSlot: 2n,
    },
    hash: programHash(bytes),
  };
}
