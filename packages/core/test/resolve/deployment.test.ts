import { describe, expect, it } from 'vitest';
import {
  describeDeployment,
  isSlotAccurate,
  lastDeploySlotOf,
  programDataAddressOf,
  resolveDeployment,
} from '@solvbana/core';
import { programSnapshot, readJson, snapshotAccounts } from '../fixtures.ts';

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
/** Its ProgramData account no longer exists — the program was closed. */
const CLOSED = '8bCAJCqHNVaraR2EMHzoXc9jDFGeax2rF56N2vHWEceT';
/** Owned by BPFLoader2, which finalizes on deployment. */
const IMMUTABLE = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Compiled into the validator rather than deployed. */
const NATIVE = 'ComputeBudget111111111111111111111111111111';

const LATER_THAN_ANY_FIXTURE = 999_999_999n;

function accountsFor(...programIds: string[]) {
  return snapshotAccounts(...programIds.map(programSnapshot));
}

describe('program account decoding', () => {
  it('reads the ProgramData address out of a Program record', () => {
    const snapshot = programSnapshot(WHIRLPOOL);
    const bytes = Uint8Array.from(Buffer.from(snapshot.program!.data, 'base64'));

    expect(programDataAddressOf(bytes)).toBe(snapshot.programDataHeader!.address);
  });

  it('reads the deployment slot out of a ProgramData header', () => {
    const snapshot = programSnapshot(WHIRLPOOL);
    const bytes = Uint8Array.from(Buffer.from(snapshot.programDataHeader!.data, 'base64'));

    expect(lastDeploySlotOf(bytes)).toBe(398059635n);
  });

  it('declines to read a record of the wrong kind', () => {
    // A ProgramData account is discriminant 3, a Program account 2. Reading one
    // as the other would produce a plausible-looking address from arbitrary bytes.
    const programData = Uint8Array.from(
      Buffer.from(programSnapshot(WHIRLPOOL).programDataHeader!.data, 'base64'),
    );
    expect(programDataAddressOf(programData)).toBeNull();

    const program = Uint8Array.from(
      Buffer.from(programSnapshot(WHIRLPOOL).program!.data, 'base64'),
    );
    expect(lastDeploySlotOf(program)).toBeNull();
  });
});

describe('resolveDeployment', () => {
  it('proves the live binary is the one that ran when it predates the failure', async () => {
    const deployment = await resolveDeployment(WHIRLPOOL, 439419580n, accountsFor(WHIRLPOOL));

    expect(deployment).toMatchObject({ kind: 'live', lastDeploySlot: 398059635n });
    expect(isSlotAccurate(deployment)).toBe(true);
  });

  it('refuses when the program was redeployed after the transaction', async () => {
    // The bytes that ran are gone: getAccountInfo serves current state only, so
    // there is no call that would retrieve them.
    const deployment = await resolveDeployment(WHIRLPOOL, 100n, accountsFor(WHIRLPOOL));

    expect(deployment).toMatchObject({ kind: 'upgraded-since', failingSlot: 100n });
    expect(isSlotAccurate(deployment)).toBe(false);
    expect(describeDeployment(deployment)).toMatch(/no longer on chain/);
  });

  it('reports a program whose data account has been reclaimed', async () => {
    const deployment = await resolveDeployment(CLOSED, LATER_THAN_ANY_FIXTURE, accountsFor(CLOSED));

    expect(deployment.kind).toBe('closed');
    expect(isSlotAccurate(deployment)).toBe(false);
  });

  it('treats a non-upgradeable loader as the strongest possible guarantee', async () => {
    // Nothing can have changed, and it costs no ProgramData read to know it.
    for (const programId of [IMMUTABLE, NATIVE]) {
      const deployment = await resolveDeployment(programId, 1n, accountsFor(programId));

      expect(deployment.kind, programId).toBe('immutable');
      expect(isSlotAccurate(deployment), programId).toBe(true);
    }
  });

  it('says a validator built-in has no binary to resolve at all', async () => {
    const deployment = await resolveDeployment(NATIVE, 1n, accountsFor(NATIVE));
    expect(describeDeployment(deployment)).toMatch(/built into the validator/);
  });

  it('reports an address with no account rather than assuming anything', async () => {
    const deployment = await resolveDeployment('MissingProgram11111111111111', 1n, accountsFor());
    expect(deployment.kind).toBe('unavailable');
  });
});

describe('the recorded corpus', () => {
  interface ProgramEntry {
    programId: string;
    deployment: string;
    lastDeploySlot: string | null;
    earliestFailingSlot: string;
  }

  const manifest = readJson<{ entries: ProgramEntry[] }>('programs', 'manifest.json');

  it.each(manifest.entries.map((entry) => [entry.programId.slice(0, 10), entry] as const))(
    'resolves %s as the manifest says',
    async (_label, entry) => {
      const deployment = await resolveDeployment(
        entry.programId,
        BigInt(entry.earliestFailingSlot),
        accountsFor(entry.programId),
      );

      expect(deployment.kind).toBe(entry.deployment);
    },
  );

  it('covers the degrade paths a harvest cannot produce', () => {
    // Harvested fixtures are always recent, so every real program in the corpus
    // still runs the binary that ran. Without the synthetic entries below there
    // would be no regression test for the refusal at all.
    const kinds = new Set(manifest.entries.map((entry) => entry.deployment));
    expect(kinds).not.toContain('upgraded-since');
  });
});

describe('synthetic degrade paths', () => {
  it('refuses a program upgraded after the transaction, against real account bytes', async () => {
    const snapshot = readJson<ReturnType<typeof programSnapshot>>(
      'programs',
      'synthetic',
      'upgraded-since.json',
    );
    const deployment = await resolveDeployment(
      snapshot.programId,
      439419580n,
      snapshotAccounts(snapshot),
    );

    expect(deployment).toMatchObject({ kind: 'upgraded-since', lastDeploySlot: 999999999n });
  });
});
