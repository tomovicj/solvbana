import { describe, expect, it } from 'vitest';
import {
  anchorBuiltinFor,
  clearResolutionCache,
  diagnose,
  forgetProgram,
  parseIdlDocument,
  reviveRawTransaction,
  suppliedIdl,
  type ArtifactStore,
} from '@solvbana/core';
import { corpusAccounts, readJson } from '../fixtures.ts';

const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

function idlDocument(discriminator: number[]): unknown {
  return {
    address: PROGRAM,
    metadata: { name: 'demo', spec: '0.1.0' },
    instructions: [{ name: 'sell', discriminator, accounts: [], args: [] }],
    errors: [{ code: 6000, name: 'Slipped', msg: 'Price moved.' }],
  };
}

const storeOf = (document: unknown): ArtifactStore => ({
  fetchIdl: () => Promise.resolve({ document }),
});

describe('a supplied IDL proving it belongs to this program', () => {
  it('is used when it declares the discriminator the instruction used', async () => {
    const outcome = await suppliedIdl(storeOf(idlDocument([1, 2, 3, 4, 5, 6, 7, 8])), PROGRAM, [
      '0102030405060708',
    ]);

    expect(outcome).toMatchObject({ kind: 'found' });
    expect(outcome.kind === 'found' && outcome.idl.provenance).toBe('supplied');
  });

  it('is refused when no declared handler matches', async () => {
    // An 8-byte match is not a coincidence, so its absence means this document
    // is for a different program, or a different version of one.
    const outcome = await suppliedIdl(storeOf(idlDocument([9, 9, 9, 9, 9, 9, 9, 9])), PROGRAM, [
      '0102030405060708',
    ]);

    expect(outcome).toMatchObject({ kind: 'unproven', programName: 'demo' });
  });

  it('is refused when the transaction offered nothing to match against', async () => {
    // An empty observation cannot prove anything, so it must not pass the
    // document through by default.
    const outcome = await suppliedIdl(storeOf(idlDocument([1, 2, 3, 4, 5, 6, 7, 8])), PROGRAM, []);

    expect(outcome.kind).toBe('unproven');
  });

  it('reports an unreadable document rather than throwing on it', async () => {
    expect(await suppliedIdl(storeOf({ not: 'an idl' }), PROGRAM, ['00'])).toMatchObject({
      kind: 'unreadable',
    });
  });

  it('reports nothing stored as absent', async () => {
    const empty: ArtifactStore = { fetchIdl: () => Promise.resolve(null) };

    expect(await suppliedIdl(empty, PROGRAM, ['00'])).toMatchObject({ kind: 'absent' });
  });
});

describe("a supplied IDL and Anchor's built-in table", () => {
  it('never unlocks it, even for a code inside Anchor’s reserved range', () => {
    // The licence for that table is that only an Anchor program publishes an IDL
    // at its Anchor-derived address — a fact about chain state. Anyone can write
    // JSON, so an uploaded document cannot lend Anchor's conventions to a code
    // the program never declared. This is the assertion an innocent-looking
    // refactor would break.
    const document = idlDocument([1, 2, 3, 4, 5, 6, 7, 8]);
    const onChain = parseIdlDocument(document, PROGRAM, 'on-chain')!;
    const supplied = parseIdlDocument(document, PROGRAM, 'supplied')!;

    // 2012 is ConstraintAddress, and neither IDL declares it itself.
    expect(anchorBuiltinFor(2012, onChain)).toMatchObject({ name: 'ConstraintAddress' });
    expect(anchorBuiltinFor(2012, supplied)).toBeNull();
  });
});

/** A corpus program that publishes no IDL: `Custom(3)`, undecoded, deployment live. */
const NO_IDL = '4F3t3Tpiyoi7Dn8oHytwJFVYJJf8cervvPL7DsZMDnCn';
const NO_IDL_SIG =
  '2L2Z8DkPRKmRDp9PvzjtJyrKpHqchgDDHhpvuPGRNULGpRqfAdERk3ucLPsRvYZR7npRG71WCxayLMPUBAFLtnGi';
/** The discriminator that transaction actually used against it. */
const OBSERVED = [0x01, 0x10, 0x18, 0x03, 0x31, 0x1a, 0x59, 0xa3];

describe('diagnosing with an uploaded IDL', () => {
  const accounts = corpusAccounts([NO_IDL]);

  function uploadFor(discriminator: number[]): ArtifactStore {
    return storeOf({
      address: NO_IDL,
      metadata: { name: 'uploaded_demo', spec: '0.1.0' },
      instructions: [{ name: 'settle', discriminator, accounts: [], args: [] }],
      errors: [{ code: 3, name: 'VaultDrained', msg: 'The vault has nothing left to pay out.' }],
    });
  }

  async function diagnoseWith(artifacts?: ArtifactStore) {
    clearResolutionCache();
    return diagnoseWithoutClearing(artifacts);
  }

  /** Leaves the cache alone, so a test can observe what it holds on to. */
  async function diagnoseWithoutClearing(artifacts?: ArtifactStore) {
    const result = await diagnose(NO_IDL_SIG, {
      source: {
        fetchTransaction: () =>
          Promise.resolve({
            kind: 'found' as const,
            raw: reviveRawTransaction(readJson('transactions', `${NO_IDL_SIG}.json`)),
            endpoint: 'primary' as const,
          }),
      },
      accounts,
      artifacts,
    });
    return {
      confidence: result.confidence,
      name: result.finding?.error.name ?? null,
      naming: result.finding?.error.naming ?? 'none',
      reasons: result.reasons.join(' '),
      // Resolution explains itself where it happened, as the deployment and
      // registry checks already do.
      notes: (result.finding?.resolution?.notes ?? []).join(' '),
    };
  }

  it('leaves the code undecoded when nothing was uploaded', async () => {
    // The program publishes no IDL, so nothing on chain says what 3 means.
    expect(await diagnoseWith()).toMatchObject({
      confidence: 'unknown',
      name: null,
      naming: 'none',
    });
  });

  it('names the code from an uploaded IDL that matches the instruction', async () => {
    const result = await diagnoseWith(uploadFor(OBSERVED));

    expect(result).toMatchObject({
      confidence: 'variant-only',
      name: 'VaultDrained',
      // Never plain `idl`: the reader has to be able to tell a name that came
      // from a file they uploaded from one read off chain.
      naming: 'supplied-idl',
    });
    expect(result.reasons).toMatch(/uploaded for this program/);
    expect(result.notes).toMatch(/matched to this transaction by instruction discriminator/);
  });

  it('refuses an uploaded IDL whose discriminators do not match', async () => {
    // It describes a different program, or a different version of one. Reading
    // its error table anyway would attach a real name to the wrong code.
    const result = await diagnoseWith(uploadFor([9, 9, 9, 9, 9, 9, 9, 9]));

    expect(result).toMatchObject({ confidence: 'unknown', name: null });
    expect(result.notes).toMatch(/declares no handler matching the discriminator/);
  });

  it('sees an IDL uploaded after an earlier diagnosis, once the program is forgotten', async () => {
    // The resolution cache is keyed on chain state, which is immutable by
    // construction — a redeploy moves the deployment slot. An artifact store is
    // not: it gains an IDL between two diagnoses and nothing in the key reflects
    // it. Found against a live endpoint, where the first diagnosis after an
    // upload kept answering from before it.
    clearResolutionCache();
    expect((await diagnoseWithoutClearing()).name).toBeNull();

    const store = uploadFor(OBSERVED);
    // Still cached from the call above, so the upload is invisible.
    expect((await diagnoseWithoutClearing(store)).name).toBeNull();

    forgetProgram(NO_IDL);
    expect((await diagnoseWithoutClearing(store)).name).toBe('VaultDrained');
  });

  it('does not let an uploaded IDL raise confidence past variant-only', async () => {
    // Naming an error is not locating it, and an IDL locates nothing at all.
    // Uploaded *source* is the one artifact that does, and it reaches
    // `narrowed` rather than `exact` — see `narrow/diagnose.test.ts`.
    const { confidence } = await diagnoseWith(uploadFor(OBSERVED));

    expect(confidence).not.toBe('exact');
    expect(confidence).not.toBe('narrowed');
  });
});
