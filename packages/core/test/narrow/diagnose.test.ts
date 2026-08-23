import { describe, expect, it } from 'vitest';
import {
  clearResolutionCache,
  diagnose,
  reviveRawTransaction,
  type ArtifactStore,
  type SourceTree,
} from '@solvbana/core';
import { corpusAccounts, readJson } from '../fixtures.ts';

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

  async function diagnoseSeeds(tree: SourceTree | null) {
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
      accounts: corpusAccounts([PUMPSWAP]),
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
});
