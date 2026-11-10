import { describe, expect, it } from 'vitest';
import {
  clearResolutionCache,
  diagnose,
  reviveRawTransaction,
  type AccountSnapshot,
  type AccountSource,
  type ArtifactStore,
  type SourceTree,
} from '@solvbana/core';
import { corpusAccounts, programSnapshot, readJson } from '../fixtures.ts';

/**
 * The same recorded accounts, with the program redeployed at `slot`.
 *
 * Rewrites the `last_deploy_slot` in the ProgramData header (u64 LE at bytes 4..12),
 * which is the one number the deployment check reads.
 */
function redeployedAt(programId: string, slot: bigint): AccountSource {
  const inner = corpusAccounts([programId]);
  const programData = programSnapshot(programId).programDataHeader!.address;

  function patch(snapshot: AccountSnapshot | null): AccountSnapshot | null {
    if (snapshot === null || snapshot.address !== programData) return snapshot;
    const bytes = Buffer.from(snapshot.data, 'base64');
    bytes.writeBigUInt64LE(slot, 4);
    return { ...snapshot, data: bytes.toString('base64') };
  }

  return {
    fetchAccount: async (address) => patch(await inner.fetchAccount(address)),
    fetchAccountPrefix: async (address, length) =>
      patch(await inner.fetchAccountPrefix(address, length)),
  };
}

/** The recorded accounts with the program's ProgramData account reclaimed: a closed program. */
function closedProgram(programId: string): AccountSource {
  const inner = corpusAccounts([programId]);
  const programData = programSnapshot(programId).programDataHeader!.address;
  return {
    fetchAccount: (address) =>
      address === programData ? Promise.resolve(null) : inner.fetchAccount(address),
    fetchAccountPrefix: (address, length) =>
      address === programData ? Promise.resolve(null) : inner.fetchAccountPrefix(address, length),
  };
}

/** No account exists at the program address, so the deployment is `unavailable`. */
function unavailableProgram(programId: string): AccountSource {
  const inner = corpusAccounts([programId]);
  return {
    fetchAccount: (address) =>
      address === programId ? Promise.resolve(null) : inner.fetchAccount(address),
    fetchAccountPrefix: (address, length) =>
      address === programId ? Promise.resolve(null) : inner.fetchAccountPrefix(address, length),
  };
}

/** Every read fails, so resolution throws and the finding carries no resolution at all. */
const FAILING_ACCOUNTS: AccountSource = {
  fetchAccount: () => Promise.reject(new Error('rpc down')),
  fetchAccountPrefix: () => Promise.reject(new Error('rpc down')),
};

/** A program that publishes no IDL, and a transaction of its that failed. */
const PROGRAM = '4F3t3Tpiyoi7Dn8oHytwJFVYJJf8cervvPL7DsZMDnCn';
const SIGNATURE =
  '2L2Z8DkPRKmRDp9PvzjtJyrKpHqchgDDHhpvuPGRNULGpRqfAdERk3ucLPsRvYZR7npRG71WCxayLMPUBAFLtnGi';
const OBSERVED = [0x01, 0x10, 0x18, 0x03, 0x31, 0x1a, 0x59, 0xa3];

/** Names the `Custom(3)` this transaction returned, and the handler that ran. */
const IDL = {
  address: PROGRAM,
  metadata: { name: 'uploaded_demo', spec: '0.1.0' },
  instructions: [{ name: 'settle', discriminator: OBSERVED, accounts: [], args: [] }],
  errors: [{ code: 3, name: 'VaultDrained', msg: 'The vault has nothing left to pay out.' }],
};

/** An offset puts the first variant at 3, which is the code this failure carried. */
function treeNumbering(first: string): SourceTree {
  return {
    files: [
      {
        path: 'src/lib.rs',
        contents:
          `#[error_code(offset = 3)]\npub enum DemoError {\n    ${first},\n    Other,\n}\n\n` +
          'pub fn settle(ctx: Context<Settle>) -> Result<()> {\n' +
          '    require!(ctx.accounts.vault.balance > 0, DemoError::VaultDrained);\n' +
          '    Ok(())\n}\n',
      },
    ],
  };
}

function store(source: SourceTree | null): ArtifactStore {
  return {
    fetchIdl: () => Promise.resolve({ document: IDL }),
    fetchSource: () => Promise.resolve(source),
  };
}

async function diagnoseWith(artifacts: ArtifactStore) {
  clearResolutionCache();
  return diagnose(SIGNATURE, {
    source: {
      fetchTransaction: () =>
        Promise.resolve({
          kind: 'found' as const,
          raw: reviveRawTransaction(readJson('transactions', `${SIGNATURE}.json`)),
          endpoint: 'primary' as const,
        }),
    },
    accounts: corpusAccounts([PROGRAM]),
    artifacts,
  });
}

describe('diagnosing with uploaded source', () => {
  it('reaches narrowed and reports the line that raises the error', async () => {
    // The first time any input has moved a diagnosis past `variant-only`.
    const diagnosis = await diagnoseWith(store(treeNumbering('VaultDrained')));

    expect(diagnosis.confidence).toBe('narrowed');
    expect(diagnosis.candidates).toHaveLength(1);
    expect(diagnosis.candidates[0]?.location).toMatchObject({ file: 'src/lib.rs', line: 8 });
    expect(diagnosis.candidates[0]?.rationale).toContain('VaultDrained');
  });

  it('stays at variant-only when no source is uploaded', async () => {
    // The same upload minus the tree. An IDL names an error; it locates nothing.
    const diagnosis = await diagnoseWith(store(null));

    expect(diagnosis.confidence).toBe('variant-only');
    expect(diagnosis.candidates).toEqual([]);
  });

  it('refuses a tree whose numbering contradicts the failure', async () => {
    // Here `Other` sits at code 3, so this tree is a different revision. Its
    // `require!` line is real and would look entirely plausible in the output.
    const diagnosis = await diagnoseWith(store(treeNumbering('Other')));

    expect(diagnosis.confidence).toBe('variant-only');
    expect(diagnosis.candidates).toEqual([]);
    expect(diagnosis.reasons.join(' ')).toContain('different version');
  });

  it('keeps the answer when the store throws rather than losing it', async () => {
    // Narrowing is an enrichment, held to the same contract as resolution.
    const diagnosis = await diagnoseWith({
      fetchIdl: () => Promise.resolve({ document: IDL }),
      fetchSource: () => Promise.reject(new Error('object store unreachable')),
    });

    expect(diagnosis.confidence).toBe('variant-only');
    expect(diagnosis.finding?.error.name).toBe('VaultDrained');
    expect(diagnosis.reasons.join(' ')).toContain('Source narrowing failed');
  });

  it('leaves a store that offers no source at all untouched', async () => {
    // `fetchSource` is optional, so a store written before this phase must keep
    // working rather than being treated as an empty tree.
    const diagnosis = await diagnoseWith({ fetchIdl: () => Promise.resolve({ document: IDL }) });

    expect(diagnosis.confidence).toBe('variant-only');
    expect(diagnosis.candidates).toEqual([]);
  });
});

describe('diagnosing an account-attributed error with uploaded source', () => {
  /**
   * A real corpus failure: PumpSwap's `ConstraintSeeds` on
   * `coin_creator_vault_authority`. This is the shape 11 of the corpus's 14
   * Anchor failures take, and the one the throw-site index cannot see, because
   * nothing in the source raises `ConstraintSeeds` — Anchor generates it.
   */
  const SEEDS_SIG =
    '5GV9BFLXPfp5fCbBHyQRACjtMLPwoG663CMSaV4YxY58ZmBdhvWZv7LDzLFGLzzxnHeR3PDyeKDSK4WHrsnJN8Vy';
  const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

  /** The declaration, with the seed expression the record could not resolve. */
  const TREE: SourceTree = {
    files: [
      {
        path: 'src/instructions/buy.rs',
        contents:
          "#[derive(Accounts)]\npub struct BuyAccounts<'info> {\n" +
          '    #[account(\n        seeds = [b"creator_vault", pool.coin_creator.as_ref()],\n        bump,\n    )]\n' +
          "    pub coin_creator_vault_authority: UncheckedAccount<'info>,\n}\n\n" +
          'pub fn buy(ctx: Context<BuyAccounts>) -> Result<()> {\n    Ok(())\n}\n',
      },
    ],
  };

  async function diagnoseSeeds(
    tree: SourceTree | null,
    accounts: AccountSource | null = corpusAccounts([PUMPSWAP]),
  ) {
    clearResolutionCache();
    return diagnose(SEEDS_SIG, {
      source: {
        fetchTransaction: () =>
          Promise.resolve({
            kind: 'found' as const,
            raw: reviveRawTransaction(readJson('transactions', `${SEEDS_SIG}.json`)),
            endpoint: 'primary' as const,
          }),
      },
      accounts: accounts ?? undefined,
      artifacts: {
        fetchIdl: () => Promise.resolve(null),
        fetchSource: () => Promise.resolve(tree),
      },
    });
  }

  it('returns the seed expression the transaction record could not resolve', async () => {
    // The explanation tier reports this account's declared seeds as
    // `unresolved`, because `pool.coin_creator` reads another account's current
    // state. The source says what the seeds *are* regardless.
    const diagnosis = await diagnoseSeeds(TREE);

    expect(diagnosis.explanation?.declaration).toMatchObject({
      field: 'coin_creator_vault_authority',
      struct: 'BuyAccounts',
      constraint: 'seeds = [b"creator_vault", pool.coin_creator.as_ref()]',
    });
    expect(diagnosis.candidates).toHaveLength(1);
    expect(diagnosis.confidence).toBe('narrowed');
  });

  it('leaves the declared-seed check refusing, since the two are different claims', async () => {
    // Reading the expression from source does not make the seeds resolvable:
    // `pool.coin_creator` is still current state this tier will not fetch.
    const diagnosis = await diagnoseSeeds(TREE);
    const check = diagnosis.explanation?.derivations.find(
      (entry) => entry.account === 'coin_creator_vault_authority',
    );

    expect(check?.status).toBe('unresolved');
    expect(check?.blockedBy).toContain('pool.coin_creator');
  });

  it('reports no declaration when no source was uploaded', async () => {
    const diagnosis = await diagnoseSeeds(null);

    expect(diagnosis.explanation?.declaration ?? null).toBeNull();
    expect(diagnosis.confidence).toBe('variant-only');
  });

  it('carries no caveat when the deployment is slot-accurate', async () => {
    const diagnosis = await diagnoseSeeds(TREE);

    expect(diagnosis.explanation?.declaration?.caveat).toBeNull();
  });

  /** The deployment check did not establish the binary: the upload is not used at all. */
  function expectUploadRefused(diagnosis: Awaited<ReturnType<typeof diagnoseSeeds>>, said: RegExp) {
    expect(diagnosis.confidence).toBe('variant-only');
    expect(diagnosis.candidates).toEqual([]);
    expect(diagnosis.explanation?.declaration ?? null).toBeNull();
    const reasons = diagnosis.reasons.join(' ');
    expect(reasons).toContain('Source was uploaded for this program');
    expect(reasons).toMatch(said);
    expect(reasons).toContain('no line from it is reported');
  }

  it('uses no uploaded source after a redeploy', async () => {
    const diagnosis = await diagnoseSeeds(TREE, redeployedAt(PUMPSWAP, 999999999999n));

    expectUploadRefused(
      diagnosis,
      /redeployed at slot 999999999999, after this transaction ran at slot 441026236/,
    );
  });

  it.each([
    ['closed', closedProgram(PUMPSWAP), /no longer exists/],
    ['unavailable', unavailableProgram(PUMPSWAP), /No account exists/],
    ['unresolved', FAILING_ACCOUNTS, /could not be checked/],
  ])('uses no uploaded source for a %s program', async (_kind, accounts, said) => {
    const diagnosis = await diagnoseSeeds(TREE, accounts);

    expectUploadRefused(diagnosis, said);
  });

  it('stays silent about an upload that does not exist', async () => {
    const diagnosis = await diagnoseSeeds(null, redeployedAt(PUMPSWAP, 999999999999n));

    expect(diagnosis.reasons.join(' ')).not.toContain('Source was uploaded');
    expect(diagnosis.candidates).toEqual([]);
  });

  it('promotes with no account source, says the deployment was not checked, and caveats the declaration', async () => {
    // The caller chose to run without chain reads; no check ran, so nothing was refused.
    const diagnosis = await diagnoseSeeds(TREE, null);

    expect(diagnosis.confidence).toBe('narrowed');
    expect(diagnosis.reasons.join(' ')).toMatch(/deployment was not checked/i);
    expect(diagnosis.explanation?.declaration?.caveat).toMatch(/deployment was not checked/i);
  });
});

describe('diagnosing uploaded source after the program was redeployed', () => {
  it('has nothing to search for when the name came from the uploaded IDL', async () => {
    // The redeploy halts resolution before the uploaded IDL is read, so
    // `VaultDrained` is never established, and the unverified deployment keeps the
    // uploaded tree from being read at all.
    clearResolutionCache();
    const diagnosis = await diagnose(SIGNATURE, {
      source: {
        fetchTransaction: () =>
          Promise.resolve({
            kind: 'found' as const,
            raw: reviveRawTransaction(readJson('transactions', `${SIGNATURE}.json`)),
            endpoint: 'primary' as const,
          }),
      },
      accounts: redeployedAt(PROGRAM, 999999999999n),
      artifacts: store(treeNumbering('VaultDrained')),
    });

    expect(diagnosis.finding?.error.name).toBeNull();
    expect(diagnosis.confidence).toBe('unknown');
    expect(diagnosis.candidates).toEqual([]);
    expect(diagnosis.reasons.join(' ')).toContain('Source was uploaded for this program');
  });

  describe('with an error name the program printed', () => {
    /**
     * The PumpSwap `BuySlippageBelowMinBaseAmountOut` failure with the `thrown in`
     * location stripped, leaving the bare `AnchorError occurred` form: named,
     * numbered, and with no line — `variant-only`, which is where narrowing acts.
     */
    const SLIPPAGE_SIG =
      '2WH1WJ5NWFZFCzcvz4zUaEz6SH3eLFnP7UzMCMciND1f219mYc3JDbhSw2UP7dHSAdPjWf6YihYF6JAunoy2nk9N';
    const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

    /** An explicit discriminant puts the variant at the 6040 the program returned. */
    const TREE: SourceTree = {
      files: [
        {
          path: 'src/buy.rs',
          contents:
            '#[error_code]\npub enum AmmError {\n    BuySlippageBelowMinBaseAmountOut = 6040,\n}\n\n' +
            'pub fn buy_exact_quote_in(ctx: Context<Buy>) -> Result<()> {\n' +
            '    require!(out >= min, AmmError::BuySlippageBelowMinBaseAmountOut);\n' +
            '    Ok(())\n}\n',
        },
      ],
    };

    function bareRaw() {
      const wire = readJson<{ meta: { logMessages: string[] } }>(
        'transactions',
        `${SLIPPAGE_SIG}.json`,
      );
      wire.meta.logMessages = wire.meta.logMessages.map((line) =>
        line.replace(
          /AnchorError thrown in [^ ]+\. Error Code/,
          'AnchorError occurred. Error Code',
        ),
      );
      return reviveRawTransaction(wire);
    }

    async function run(accounts: AccountSource | undefined) {
      clearResolutionCache();
      return diagnose(SLIPPAGE_SIG, {
        source: {
          fetchTransaction: () =>
            Promise.resolve({
              kind: 'found' as const,
              raw: bareRaw(),
              endpoint: 'primary' as const,
            }),
        },
        accounts,
        artifacts: {
          fetchIdl: () => Promise.resolve(null),
          fetchSource: () => Promise.resolve(TREE),
        },
      });
    }

    it('narrows against a live deployment', async () => {
      const diagnosis = await run(corpusAccounts([PUMPSWAP]));

      expect(diagnosis.finding?.error.name).toBe('BuySlippageBelowMinBaseAmountOut');
      expect(diagnosis.confidence).toBe('narrowed');
      expect(diagnosis.candidates).toHaveLength(1);
      expect(diagnosis.reasons.join(' ')).not.toContain('redeployed');
    });

    it('does not narrow after a redeploy even when the numbering confirms', async () => {
      // Error enums are usually append-only, so agreement says little about which
      // revision ran. The deployment gates everything.
      const diagnosis = await run(redeployedAt(PUMPSWAP, 999999999999n));

      expect(diagnosis.confidence).toBe('variant-only');
      expect(diagnosis.candidates).toEqual([]);
      expect(diagnosis.explanation?.declaration ?? null).toBeNull();
      expect(diagnosis.reasons.join(' ')).toContain('redeployed at slot 999999999999');
      expect(diagnosis.reasons.join(' ')).toContain('no line from it is reported');
    });

    it('says nothing about an upload when there is none, after a redeploy', async () => {
      clearResolutionCache();
      const diagnosis = await diagnose(SLIPPAGE_SIG, {
        source: {
          fetchTransaction: () =>
            Promise.resolve({
              kind: 'found' as const,
              raw: bareRaw(),
              endpoint: 'primary' as const,
            }),
        },
        accounts: redeployedAt(PUMPSWAP, 999999999999n),
      });

      expect(diagnosis.reasons.join(' ')).not.toContain('Source was uploaded');
    });

    it.each([
      ['closed', closedProgram(PUMPSWAP)],
      ['unavailable', unavailableProgram(PUMPSWAP)],
      ['unresolved', FAILING_ACCOUNTS],
    ])('does not narrow a confirmed proof for a %s program', async (_kind, accounts) => {
      const diagnosis = await run(accounts);

      expect(diagnosis.confidence).toBe('variant-only');
      expect(diagnosis.candidates).toEqual([]);
      expect(diagnosis.reasons.join(' ')).toContain('Source was uploaded for this program');
    });

    it('promotes a confirmed proof with no account source, and says it was not checked', async () => {
      const diagnosis = await run(undefined);

      expect(diagnosis.confidence).toBe('narrowed');
      expect(diagnosis.candidates).toHaveLength(1);
      expect(diagnosis.reasons.join(' ')).toMatch(/deployment was not checked/i);
    });
  });
});

describe('uploaded source never displaces a location the program printed', () => {
  /** `AnchorError thrown in …buy.rs:687`, so `exact`. */
  const EXACT_SIG =
    '2WH1WJ5NWFZFCzcvz4zUaEz6SH3eLFnP7UzMCMciND1f219mYc3JDbhSw2UP7dHSAdPjWf6YihYF6JAunoy2nk9N';
  const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

  const OTHER: SourceTree = {
    files: [
      {
        path: 'src/other.rs',
        contents:
          '#[error_code]\npub enum PumpError {\n    BuySlippageBelowMinBaseAmountOut = 6040,\n}\n' +
          'pub fn unrelated() -> Result<()> {\n' +
          '    require!(x > 0, PumpError::BuySlippageBelowMinBaseAmountOut);\n' +
          '    Ok(())\n}\n',
      },
    ],
  };

  async function run(tree: SourceTree | null) {
    clearResolutionCache();
    return diagnose(EXACT_SIG, {
      source: {
        fetchTransaction: () =>
          Promise.resolve({
            kind: 'found' as const,
            raw: reviveRawTransaction(readJson('transactions', `${EXACT_SIG}.json`)),
            endpoint: 'primary' as const,
          }),
      },
      accounts: corpusAccounts([PUMPSWAP]),
      artifacts: {
        fetchIdl: () => Promise.resolve(null),
        fetchSource: () => Promise.resolve(tree),
      },
    });
  }

  it('leaves an exact answer and its printed candidates exactly as they were', async () => {
    const without = await run(null);
    const withUpload = await run(OTHER);

    expect(without.confidence).toBe('exact');
    expect(withUpload.confidence).toBe('exact');
    expect(withUpload.candidates).toEqual(without.candidates);
    expect(withUpload.candidates[0]?.location.file).toContain('buy.rs');
  });

  it('is identical after a redeploy too, and emits no refusal reason for it', async () => {
    const without = await run(null);
    clearResolutionCache();
    const withUpload = await diagnose(EXACT_SIG, {
      source: {
        fetchTransaction: () =>
          Promise.resolve({
            kind: 'found' as const,
            raw: reviveRawTransaction(readJson('transactions', `${EXACT_SIG}.json`)),
            endpoint: 'primary' as const,
          }),
      },
      accounts: redeployedAt(PUMPSWAP, 999999999999n),
      artifacts: {
        fetchIdl: () => Promise.resolve(null),
        fetchSource: () => Promise.resolve(OTHER),
      },
    });

    expect(withUpload.confidence).toBe('exact');
    expect(withUpload.candidates).toEqual(without.candidates);
    expect(withUpload.reasons.join(' ')).not.toContain('Source was uploaded');
  });
});
