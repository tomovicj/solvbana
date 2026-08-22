import {
  address as toAddress,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import type { FailedTransaction } from '../ingest/types.ts';
import type { IdlHandler, IdlSeed } from '../resolve/idl.ts';
import type { AccountRow, DerivationCheck, ResolvedSeed } from './types.ts';

/**
 * The Associated Token program and the two token programs whose addresses seed it.
 *
 * Pinned addresses, which is what licenses using them: the derivation is part of
 * a fixed program's published interface, so this is a lookup on identity rather
 * than an assumption about a convention. It is the same principle the native
 * error tables rest on.
 */
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const encoder = getAddressEncoder();

/** `findProgramAddress([owner, tokenProgram, mint], AssociatedTokenProgram)`. */
export async function associatedTokenAddress(
  owner: string,
  tokenProgram: string,
  mint: string,
): Promise<{ address: string; bump: number }> {
  const [address, bump] = await getProgramDerivedAddress({
    programAddress: toAddress(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [
      encoder.encode(toAddress(owner)),
      encoder.encode(toAddress(tokenProgram)),
      encoder.encode(toAddress(mint)),
    ],
  });
  return { address, bump };
}

/** Accepts the readonly views `@solana/kit`'s encoders return as well as plain arrays. */
function seedFor(
  kind: ResolvedSeed['kind'],
  source: string,
  input: ArrayLike<number>,
  address: string | null = null,
): ResolvedSeed {
  const bytes = Uint8Array.from(input);
  return {
    kind,
    source,
    bytes: Buffer.from(bytes).toString('hex'),
    text: printableText(bytes),
    address,
  };
}

/** The bytes as UTF-8 when every character is printable — how `b"vault"` reads. */
function printableText(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > 64) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

/**
 * Establish whether an address is the associated token account of something the
 * instruction already names.
 *
 * This proves rather than infers. Every candidate triple is drawn from the
 * transaction's own record — the accounts this instruction passed, the mints its
 * token balances mention, and the two pinned token programs — and a hit means
 * the derivation reproduced the address exactly. No naming convention is
 * consulted, so nothing rests on an account being called `user` or `mint`.
 *
 * A miss is reported too, and is the more useful of the two: an address that is
 * not the associated token account of anything this instruction passed is an
 * address the client derived wrongly. The claim is bounded by the candidate set,
 * which `searched` states so the negative stays checkable.
 */
export async function checkAssociatedToken(
  transaction: FailedTransaction,
  rows: readonly AccountRow[],
  target: AccountRow,
): Promise<DerivationCheck | null> {
  if (target.address === null) return null;

  const mints = new Set(transaction.tokenBalances.map((balance) => balance.mint));
  for (const row of rows) {
    if (row.token !== null) mints.add(row.token.mint);
  }
  if (mints.size === 0) return null;

  const owners = rows
    .map((row) => row.address)
    .filter((address): address is string => address !== null);
  const programs = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

  for (const owner of owners) {
    for (const program of programs) {
      for (const mint of mints) {
        const derived = await associatedTokenAddress(owner, program, mint);
        if (derived.address !== target.address) continue;

        return {
          account: target.name ?? `account ${String(target.position)}`,
          position: target.position,
          actual: target.address,
          expected: derived.address,
          bump: derived.bump,
          programId: ASSOCIATED_TOKEN_PROGRAM,
          // Order is part of the contract for an associated-token check: owner,
          // token program, mint — the seed order the program itself uses.
          seeds: [
            seedFor('account', 'owner', encoder.encode(toAddress(owner)), owner),
            seedFor('account', 'token program', encoder.encode(toAddress(program)), program),
            seedFor('account', 'mint', encoder.encode(toAddress(mint)), mint),
          ],
          status: 'match',
          source: 'associated-token',
          blockedBy: null,
          searched: null,
        };
      }
    }
  }

  return {
    account: target.name ?? `account ${String(target.position)}`,
    position: target.position,
    actual: target.address,
    expected: null,
    bump: null,
    programId: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [],
    status: 'not-derivable',
    source: 'associated-token',
    blockedBy: null,
    searched:
      `${String(owners.length)} accounts in this instruction as the owner, ` +
      `${String(mints.size)} mint${mints.size === 1 ? '' : 's'} this transaction touched, ` +
      'and both the classic Token and Token-2022 programs',
  };
}

/**
 * The program an IDL-declared PDA derives under.
 *
 * Defaults to the declaring program, but the IDL may name another — an
 * associated token account derives under the Associated Token program. The
 * declaration has the same shape as a seed, so a literal is 32 address bytes and
 * a reference names another account in the same instruction.
 */
function derivationProgram(
  declared: IdlSeed | null,
  byName: ReadonlyMap<string, AccountRow>,
  fallback: string,
): { programId: string } | { blockedBy: string } {
  if (declared === null) return { programId: fallback };

  if (declared.kind === 'const' && declared.value !== null) {
    if (declared.value.length !== 32) {
      return { blockedBy: 'a literal derivation program that is not a 32-byte address' };
    }
    return { programId: getBase58Decoder().decode(Uint8Array.from(declared.value)) };
  }

  if (declared.kind === 'account' && declared.path !== null) {
    if (declared.path.includes('.')) {
      return {
        blockedBy:
          `the derivation program at ${declared.path}, which reads a field out of another ` +
          "account's data — only available as current state, which is not what ran",
      };
    }
    const row = byName.get(declared.path);
    if (row?.address == null) {
      return { blockedBy: `the derivation program at ${declared.path}, which is not named here` };
    }
    return { programId: row.address };
  }

  return { blockedBy: `a ${declared.kind} derivation program the IDL did not describe` };
}

/**
 * Check the accounts whose PDA seeds the program's own IDL declares.
 *
 * A component reading a field out of another account's data — a dotted path such
 * as `pool.base_mint` — is left unresolved rather than fetched. That data is only
 * available as current state, and a failed transaction rolls back, so deriving
 * from it would produce an address that was never the one under test. The check
 * names the component that blocked it instead.
 */
export async function checkIdlPdas(
  handler: IdlHandler,
  rows: readonly AccountRow[],
  argSeeds: ReadonlyMap<string, Uint8Array>,
  programId: string,
): Promise<DerivationCheck[]> {
  const checks: DerivationCheck[] = [];
  const byName = new Map<string, AccountRow>();
  for (const row of rows) {
    if (row.name !== null) byName.set(row.name, row);
  }

  for (const [position, spec] of handler.accounts.entries()) {
    if (spec.seeds === null || spec.seeds.length === 0) continue;
    const row = rows[position];
    if (row === undefined || row.name !== spec.name) continue;

    const seeds: ResolvedSeed[] = [];
    const program = derivationProgram(spec.program, byName, programId);
    let blockedBy: string | null = 'blockedBy' in program ? program.blockedBy : null;

    for (const seed of blockedBy === null ? spec.seeds : []) {
      if (seed.kind === 'const' && seed.value !== null) {
        seeds.push(seedFor('const', 'literal', Uint8Array.from(seed.value)));
        continue;
      }

      if (seed.kind === 'arg' && seed.path !== null) {
        const bytes = argSeeds.get(seed.path);
        if (bytes === undefined) {
          blockedBy = `argument ${seed.path}, which could not be decoded`;
          break;
        }
        seeds.push(seedFor('arg', `argument ${seed.path}`, bytes));
        continue;
      }

      if (seed.kind === 'account' && seed.path !== null) {
        if (seed.path.includes('.')) {
          blockedBy =
            `${seed.path}, which reads a field out of another account's data — that is ` +
            'only available as current state, which is not what ran';
          break;
        }
        const referenced = byName.get(seed.path);
        if (referenced?.address === undefined || referenced.address === null) {
          blockedBy = `account ${seed.path}, which this instruction does not name`;
          break;
        }
        seeds.push(
          seedFor(
            'account',
            `account ${seed.path}`,
            encoder.encode(toAddress(referenced.address)),
            referenced.address,
          ),
        );
        continue;
      }

      blockedBy = `a ${seed.kind} component the IDL did not describe`;
      break;
    }

    if (blockedBy !== null || !('programId' in program)) {
      checks.push({
        account: spec.name,
        position,
        actual: row.address,
        expected: null,
        bump: null,
        programId,
        seeds,
        status: 'unresolved',
        source: 'idl-pda',
        blockedBy: blockedBy ?? 'the program to derive under',
        searched: null,
      });
      continue;
    }

    const [derived, bump] = await getProgramDerivedAddress({
      programAddress: toAddress(program.programId),
      seeds: seeds.map((seed) => Buffer.from(seed.bytes ?? '', 'hex')),
    });

    checks.push({
      account: spec.name,
      position,
      actual: row.address,
      expected: derived,
      bump,
      programId: program.programId,
      seeds,
      status: derived === row.address ? 'match' : 'mismatch',
      source: 'idl-pda',
      blockedBy: null,
      searched: null,
    });
  }

  return checks;
}
