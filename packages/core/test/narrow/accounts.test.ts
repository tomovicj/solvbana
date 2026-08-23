import { describe, expect, it } from 'vitest';
import { attributeFor, contextStruct, findDeclaration, narrow, type Finding } from '@solvbana/core';
import { sourceTree } from '../fixtures.ts';

const vault = sourceTree('vault');

function finding(name: string, account: string | null, code: number): Finding {
  return {
    program: 'Vau1t1111111111111111111111111111111111111',
    programSource: 'logs',
    handler: 'Claim',
    handlerSource: 'logged',
    error: { code, name, message: null, naming: 'logged' },
    failure: { kind: 'anchor', account, site: null, comparison: null },
    explanation: 'An account constraint was violated.',
  };
}

describe('contextStruct', () => {
  it('reads the accounts struct from the handler signature, not from its name', () => {
    // The fixture's handler is `claim` and its struct is `ClaimAccounts`, so a
    // lookup that assumed Anchor's naming convention would find nothing. The
    // link is written in `Context<...>` and is read from there.
    expect(contextStruct(vault, 'Claim')).toBe('ClaimAccounts');
  });

  it('takes the last type argument, past any lifetimes', () => {
    // `Context<'_, '_, '_, 'info, ClaimAccounts<'info>>` is as common as the
    // short form, and the accounts struct is last in every arity Anchor emits.
    expect(contextStruct(vault, 'Refund')).toBe('RefundAccounts');
  });

  it('reports nothing for a handler the tree does not declare', () => {
    expect(contextStruct(vault, 'Absent')).toBeNull();
  });
});

describe('findDeclaration', () => {
  it('collects a multi-line #[account(...)] block as whole attributes', () => {
    const outcome = findDeclaration(vault, 'Claim', 'creator_vault_authority', 'ConstraintSeeds');

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    // `seeds = [a, b, c]` is one attribute. Splitting on every comma would
    // report a fragment as the constraint that failed.
    expect(outcome.declaration.attributes).toEqual([
      'seeds = [b"creator_vault", vault.creator.as_ref(), &round.to_le_bytes()]',
      'bump',
    ]);
    expect(outcome.viaHandler).toBe(true);
  });

  it('picks the attribute the failed error points at', () => {
    const seeds = findDeclaration(vault, 'Claim', 'creator_vault_authority', 'ConstraintSeeds');
    const hasOne = findDeclaration(vault, 'Claim', 'vault', 'ConstraintHasOne');

    expect(seeds.kind === 'found' && seeds.declaration.constraint).toContain('seeds = [');
    expect(hasOne.kind === 'found' && hasOne.declaration.constraint).toBe('has_one = authority');
  });

  it('reports the declaration alone when no attribute raises the error', () => {
    // Nothing in `#[account(...)]` produces `AccountNotInitialized` — the
    // declared type does, when Anchor fails to deserialize it.
    const outcome = findDeclaration(vault, 'Claim', 'receipt', 'AccountNotInitialized');

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(outcome.declaration.constraint).toBeNull();
    expect(outcome.declaration.text).toContain("Account<'info, Receipt>");
  });

  it('refuses when the handler struct does not declare the blamed field', () => {
    // The tree and the deployed binary disagree about this instruction, which
    // is the same conclusion an IDL declaring too few accounts produces.
    expect(findDeclaration(vault, 'Claim', 'not_a_field', 'ConstraintSeeds')).toEqual({
      kind: 'absent',
      struct: 'ClaimAccounts',
    });
  });

  it('falls back to the field name when exactly one struct declares it', () => {
    const outcome = findDeclaration(vault, null, 'creator_vault_authority', 'ConstraintSeeds');

    expect(outcome.kind).toBe('found');
    // Flagged, because it was identified as the only match rather than proved
    // to be the struct that ran.
    expect(outcome.kind === 'found' && outcome.viaHandler).toBe(false);
  });

  it('refuses the fallback when two structs declare the field', () => {
    // Both `ClaimAccounts` and `RefundAccounts` have a `receipt`, and without a
    // handler nothing says which ran.
    const outcome = findDeclaration(vault, null, 'receipt', 'AccountNotInitialized');

    expect(outcome).toMatchObject({ kind: 'ambiguous' });
    expect(outcome.kind === 'ambiguous' && outcome.structs.sort()).toEqual([
      'ClaimAccounts',
      'RefundAccounts',
    ]);
  });

  it('reports nothing when no struct declares the field at all', () => {
    expect(findDeclaration(vault, null, 'nowhere', 'ConstraintSeeds').kind).toBe('unknown');
  });
});

describe('attributeFor', () => {
  it('maps a constraint error to the keyword that raises it', () => {
    expect(attributeFor('ConstraintSeeds')).toBe('seeds');
    expect(attributeFor('ConstraintHasOne')).toBe('has_one');
    expect(attributeFor('ConstraintTokenOwner')).toBe('token::authority');
  });

  it('maps the account band to no keyword', () => {
    // These come from the declared type, so there is no expression to point at.
    expect(attributeFor('AccountNotInitialized')).toBeNull();
    expect(attributeFor('AccountOwnedByWrongProgram')).toBeNull();
  });
});

describe('narrowing an account-attributed error', () => {
  it('locates the declaration Anchor blamed', () => {
    // The whole point: nothing in the source *raises* ConstraintSeeds, so the
    // throw-site index finds nothing and this path is the only one that answers.
    const { candidates } = narrow(
      vault,
      finding('ConstraintSeeds', 'creator_vault_authority', 2006),
      'Claim',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.location).toMatchObject({ file: 'src/instructions/claim.rs' });
    expect(candidates[0]?.rationale).toContain('seeds = [b"creator_vault"');
  });

  it('says the numbering proof did not apply', () => {
    // 2006 is Anchor's own code, not the program's, so the tree's #[error_code]
    // ordering says nothing about it. A reader must not assume it was checked.
    const { candidates } = narrow(
      vault,
      finding('ConstraintSeeds', 'creator_vault_authority', 2006),
      'Claim',
    );

    expect(candidates[0]?.rationale).toContain('not by the error numbering');
  });

  it('produces no candidate when the field is absent, and says why', () => {
    const { candidates, reasons } = narrow(
      vault,
      finding('ConstraintSeeds', 'not_a_field', 2006),
      'Claim',
    );

    expect(candidates).toEqual([]);
    expect(reasons.join(' ')).toContain('disagree about this instruction');
  });

  it('still uses the variant path for an error the program raises itself', () => {
    // A custom error blaming no account goes down the throw-site path unchanged.
    const { candidates } = narrow(vault, finding('VaultLocked', null, 6000), 'Withdraw');
    expect(candidates).toHaveLength(1);
  });
});
