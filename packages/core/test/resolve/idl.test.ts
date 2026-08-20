import { describe, expect, it } from 'vitest';
import {
  anchorBuiltinFor,
  decodeIdlAccount,
  deriveDiscriminator,
  handlerForDiscriminator,
  idlAddressFor,
  resolveIdl,
  type ResolvedIdl,
} from '@solvbana/core';
import { programSnapshot, readJson, snapshotAccounts } from '../fixtures.ts';

/** Anchor 0.30+: `metadata.spec`, snake_case names, explicit discriminators. */
const MODERN = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
/** Pre-0.30: no spec, camelCase names, no discriminators at all. */
const LEGACY = 'T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt';
const NO_IDL = 'DF3LjmyzuMApbw55YeC52JJArKgQjygKWZFUB9TNqLWn';

function idlOf(programId: string): ResolvedIdl {
  const snapshot = programSnapshot(programId);
  const bytes = Uint8Array.from(Buffer.from(snapshot.idl!.data, 'base64'));
  const idl = decodeIdlAccount(bytes, snapshot.idl!.address);
  if (idl === null) throw new Error(`${programId} did not decode`);
  return idl;
}

describe('idlAddressFor', () => {
  it('derives the address the program actually published at', async () => {
    // The derivation is the whole basis for treating an account's existence as
    // proof the program is Anchor, so it is checked against a recorded address
    // rather than against itself.
    for (const programId of [MODERN, LEGACY]) {
      expect(await idlAddressFor(programId), programId).toBe(
        programSnapshot(programId).idl!.address,
      );
    }
  });
});

describe('decodeIdlAccount', () => {
  it('reads the 0.30+ layout, discriminators included', () => {
    const idl = idlOf(MODERN);

    expect(idl).toMatchObject({ programName: 'whirlpool', spec: '0.1.0' });
    expect(idl.errors.size).toBe(70);
    expect(idl.handlers).toHaveLength(66);
    // Declared in the document rather than recomputed.
    expect(idl.handlers[0]?.discriminator).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads the pre-0.30 layout, which carries neither a spec nor discriminators', () => {
    const idl = idlOf(LEGACY);

    expect(idl).toMatchObject({ programName: 'jito_tip_payment', spec: null });
    expect(idl.errors.size).toBe(2);
    expect(idl.handlers.length).toBeGreaterThan(0);
  });

  it('derives a legacy discriminator from the instruction name', () => {
    // The old layout stores none, so they have to be computed the way Anchor
    // does: sha256("global:" + snake_case(name)), first 8 bytes.
    const idl = idlOf(LEGACY);
    const initialize = idl.handlers.find((handler) => handler.name === 'initialize');

    expect(initialize?.discriminator).toBe(deriveDiscriminator('initialize'));
    expect(deriveDiscriminator('changeTipReceiver')).toBe(
      deriveDiscriminator('change_tip_receiver'),
    );
  });

  it('refuses bytes that are not an IDL rather than throwing', () => {
    expect(decodeIdlAccount(new Uint8Array(8), 'addr')).toBeNull();
    expect(decodeIdlAccount(Uint8Array.from(Buffer.alloc(64, 7)), 'addr')).toBeNull();
  });
});

describe('resolveIdl', () => {
  it('reports absence as an outcome, not a failure', async () => {
    // Most programs publish nothing here, and declining to name their error
    // codes is the deliberate answer rather than an error condition.
    const outcome = await resolveIdl(NO_IDL, snapshotAccounts(programSnapshot(NO_IDL)));

    expect(outcome).toMatchObject({ kind: 'absent' });
  });

  it('degrades when the account exists but holds something else', async () => {
    const snapshot = readJson<ReturnType<typeof programSnapshot>>(
      'programs',
      'synthetic',
      'unreadable-idl.json',
    );
    const outcome = await resolveIdl(MODERN, snapshotAccounts({ ...snapshot, programId: MODERN }));

    expect(outcome.kind).toBe('unreadable');
  });
});

describe('handlerForDiscriminator', () => {
  it('matches an instruction by its leading 8 bytes', () => {
    const idl = idlOf(MODERN);
    const handler = idl.handlers[3]!;
    const data = Uint8Array.from(Buffer.from(`${handler.discriminator}deadbeef`, 'hex'));

    expect(handlerForDiscriminator(idl, data)?.name).toBe(handler.name);
  });

  it('matches nothing when the data is too short to carry one', () => {
    expect(handlerForDiscriminator(idlOf(MODERN), new Uint8Array(4))).toBeNull();
  });
});

describe('anchorBuiltinFor', () => {
  it('names a built-in code once an IDL licenses the table', () => {
    // The corpus's two Whirlpool failures return 2012 with no Anchor logging at
    // all. Phase 1 refuses them; the published IDL is what makes this legitimate.
    expect(anchorBuiltinFor(2012, idlOf(MODERN))).toEqual({
      name: 'ConstraintAddress',
      family: 'constraint',
    });
    expect(anchorBuiltinFor(3012, idlOf(MODERN))?.name).toBe('AccountNotInitialized');
    expect(anchorBuiltinFor(2505, idlOf(MODERN))).toMatchObject({ family: 'require' });
  });

  it("leaves a program's own codes to its IDL", () => {
    // 6000 and up are declared by the program. Inventing a name for one the IDL
    // does not list would be a guess with a table in front of it.
    expect(anchorBuiltinFor(6040, idlOf(MODERN))).toBeNull();
  });
});
