import { describe, expect, it } from 'vitest';
import { address as toAddress, getAddressEncoder } from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  accountTable,
  associatedTokenAddress,
  checkAssociatedToken,
  checkIdlPdas,
  type IdlHandler,
} from '@solvbana/core';
import { PROGRAM, failedTransaction, instruction } from './helpers.ts';

const OWNER = '2N2Zsv5PpGMqNo6eJA17jCB6d2v3uuRQW3zwxe4fGun8';
const MINT = 'DTGWeDVPAvr7TdY7sdbfjz2bi4QihVMMn9KhyKH1pump';
/** The real corpus case: pump_amm's user_base_token_account, a Token-2022 ATA. */
const EXPECTED_ATA = 'D5dn4onVZucPxFmhsWcw43W5shmyPo6LNq3xuEfLaNyn';

describe('associatedTokenAddress', () => {
  it('reproduces a real mainnet associated token address', async () => {
    const derived = await associatedTokenAddress(OWNER, TOKEN_2022_PROGRAM, MINT);

    expect(derived.address).toBe(EXPECTED_ATA);
  });

  it('derives a different address under each token program', async () => {
    // The token program is a seed, so assuming classic Token for a Token-2022
    // mint produces a valid-looking address for an account that never existed.
    const legacy = await associatedTokenAddress(OWNER, TOKEN_PROGRAM, MINT);
    const modern = await associatedTokenAddress(OWNER, TOKEN_2022_PROGRAM, MINT);

    expect(legacy.address).not.toBe(modern.address);
  });
});

describe('checkAssociatedToken', () => {
  function setup(target: string) {
    const addresses = [OWNER, target, MINT];
    const transaction = failedTransaction({
      lamports: [1n, 0n, 1n],
      addresses,
      tokenBalances: [
        {
          index: 2,
          mint: MINT,
          owner: OWNER,
          tokenProgram: TOKEN_2022_PROGRAM,
          decimals: 6,
          pre: 1n,
          post: 1n,
        },
      ],
    });
    const rows = accountTable(transaction, instruction([0, 1, 2]), null);
    return { transaction, rows };
  }

  it('proves an address is the associated token account of something the instruction passed', async () => {
    // Nothing here rests on an account being called `user` or `mint`: the
    // derivation reproducing the address is itself the evidence.
    const { transaction, rows } = setup(EXPECTED_ATA);
    const check = await checkAssociatedToken(transaction, rows, rows[1]!);

    expect(check).toMatchObject({ status: 'match', expected: EXPECTED_ATA });
    expect(check?.seeds.map((seed) => seed.address)).toEqual([OWNER, TOKEN_2022_PROGRAM, MINT]);
  });

  it('reports a bounded negative when nothing derives to the address', async () => {
    // This is the more useful of the two outcomes: an address that is not the
    // associated token account of anything the instruction passed is an address
    // the client derived wrongly. The claim is only sound over what was
    // searched, so the search space is stated.
    const { transaction, rows } = setup('4euPcv4g94jDcwW8HpMPmR3HPpP7dMee3n1t9gtmvP8W');
    const check = await checkAssociatedToken(transaction, rows, rows[1]!);

    expect(check).toMatchObject({ status: 'not-derivable', expected: null });
    expect(check?.searched).toMatch(/accounts in this instruction as the owner/);
  });
});

describe('checkIdlPdas', () => {
  function handler(accounts: IdlHandler['accounts']): IdlHandler {
    return { name: 'handler', discriminator: '0000000000000000', args: [], accounts };
  }

  it('derives under the program the IDL names, not the declaring program', async () => {
    // 155 of the 571 seeded accounts in the corpus declare `pda.program`. An
    // associated token account derives under the Associated Token program, and
    // deriving it under the declaring program reports a spurious mismatch on an
    // account that was perfectly correct.
    const spec = handler([
      { name: 'owner', seeds: null, program: null, optional: false },
      {
        name: 'ata',
        seeds: [
          { kind: 'account', value: null, path: 'owner' },
          { kind: 'account', value: null, path: 'token_program' },
          { kind: 'account', value: null, path: 'mint' },
        ],
        program: { kind: 'const', value: ataProgramBytes(), path: null },
        optional: false,
      },
      { name: 'mint', seeds: null, program: null, optional: false },
      { name: 'token_program', seeds: null, program: null, optional: false },
    ]);
    const transaction = failedTransaction({
      lamports: [1n, 1n, 1n, 1n],
      addresses: [OWNER, EXPECTED_ATA, MINT, TOKEN_2022_PROGRAM],
    });
    const rows = accountTable(transaction, instruction([0, 1, 2, 3]), spec);

    const checks = await checkIdlPdas(spec, rows, new Map(), PROGRAM);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: 'match',
      account: 'ata',
      programId: ASSOCIATED_TOKEN_PROGRAM,
    });
  });

  it('refuses to derive from a seed that reads another account’s data', async () => {
    // A dotted path is only available as current state, and a failed
    // transaction rolls back — so the derivation would be of an address that
    // was never the one under test.
    const transaction = failedTransaction({ lamports: [1n, 1n] });
    const spec = handler([
      { name: 'pool', seeds: null, program: null, optional: false },
      {
        name: 'vault',
        seeds: [{ kind: 'account', value: null, path: 'pool.creator' }],
        program: null,
        optional: false,
      },
    ]);
    const rows = accountTable(transaction, instruction([0, 1]), spec);

    const checks = await checkIdlPdas(spec, rows, new Map(), PROGRAM);

    expect(checks[0]).toMatchObject({ status: 'unresolved', expected: null });
    expect(checks[0]?.blockedBy).toMatch(/pool\.creator/);
  });

  it('reports a mismatch with the address the seeds actually produce', async () => {
    const transaction = failedTransaction({ lamports: [1n], addresses: [OWNER] });
    const spec = handler([
      {
        name: 'state',
        seeds: [{ kind: 'const', value: [...Buffer.from('state')], path: null }],
        program: null,
        optional: false,
      },
    ]);
    const rows = accountTable(transaction, instruction([0]), spec);

    const checks = await checkIdlPdas(spec, rows, new Map(), PROGRAM);

    expect(checks[0]?.status).toBe('mismatch');
    expect(checks[0]?.expected).not.toBe(OWNER);
    expect(checks[0]?.seeds[0]?.text).toBe('state');
  });
});

/** The Associated Token program id as raw bytes, for a `pda.program` literal. */
function ataProgramBytes(): number[] {
  return [...getAddressEncoder().encode(toAddress(ASSOCIATED_TOKEN_PROGRAM))];
}
