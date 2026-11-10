import { describe, expect, it } from 'vitest';
import { attributeFor, contextStruct, findDeclaration, narrow, type Finding } from '@solvbana/core';
import { sourceTree } from '../fixtures.ts';
import { MAX_ATTRIBUTE_LINES } from '../../src/narrow/accounts.ts';
import { MAX_FILE_CHARS } from '../../src/narrow/sites.ts';

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

describe('large and hostile inputs', () => {
  const struct = (fields: number, attrLines: number) => {
    const body = Array.from({ length: fields }, (_, i) => {
      const attr = Array.from({ length: attrLines }, (_, j) => `        // doc ${String(j)}`);
      return [
        `    /// field ${String(i)}`,
        ...attr,
        '    #[account(',
        '        mut,',
        '        has_one = authority,',
        '    )]',
        `    pub f${String(i)}: Account<'info, Thing>,`,
        '',
      ].join('\n');
    }).join('\n');
    return `fn go(ctx: Context<Big>) {}\n#[derive(Accounts)]\npub struct Big<'info> {\n${body}\n}\n`;
  };

  it('reads a 70-field struct of over 500 lines to its closing brace', () => {
    const source = struct(70, 1);
    expect(source.split('\n').length).toBeGreaterThan(545);
    const outcome = findDeclaration(
      { files: [{ path: 'a.rs', contents: source }] },
      'Go',
      'f59',
      'ConstraintHasOne',
    );
    expect(outcome.kind).toBe('found');
    expect(outcome.kind === 'found' && outcome.declaration.constraint).toBe('has_one = authority');
  });

  it('reports an unclosed struct as truncated, never as a disagreement', () => {
    const source =
      "fn go(ctx: Context<Big>) {}\n#[derive(Accounts)]\npub struct Big<'info> {\n  pub a: u8,\n";
    const tree = { files: [{ path: 'a.rs', contents: source }] };
    expect(findDeclaration(tree, 'Go', 'zzz', 'ConstraintSeeds').kind).toBe('truncated');

    const { candidates, reasons } = narrow(tree, finding('ConstraintSeeds', 'zzz', 2006), 'Go');
    expect(candidates).toEqual([]);
    expect(reasons.join(' ')).toContain('too large to read in full');
    expect(reasons.join(' ')).not.toContain('uploaded source and the deployed binary disagree');
  });

  it('flags a declaration whose attribute block could not be read', () => {
    const lines = Array.from({ length: MAX_ATTRIBUTE_LINES + 5 }, () => '        mut,');
    const source =
      "fn go(ctx: Context<S>) {}\n#[derive(Accounts)]\npub struct S<'info> {\n    #[account(\n" +
      `${lines.join('\n')}\n    )]\n    pub a: Account<'info, T>,\n}\n`;
    const tree = { files: [{ path: 'a.rs', contents: source }] };
    const outcome = findDeclaration(tree, 'Go', 'a', 'ConstraintMut');
    expect(outcome.kind === 'found' && outcome.declaration.attributesTruncated).toBe(true);

    const { reasons } = narrow(tree, finding('ConstraintMut', 'a', 2000), 'Go');
    expect(reasons.join(' ')).toContain('could not be read in full');
  });

  it('does not call a field unknown when a file was not read', () => {
    const big = { path: 'big.rs', contents: ' '.repeat(MAX_FILE_CHARS + 1) };
    const outcome = findDeclaration(
      { files: [...vault.files, big] },
      null,
      'nowhere',
      'ConstraintSeeds',
    );
    expect(outcome.kind).toBe('unknown');
    expect(outcome.unread?.[0]).toContain('big.rs');

    const { reasons } = narrow(
      { files: [...vault.files, big] },
      finding('ConstraintSeeds', 'nowhere', 2006),
      null,
    );
    expect(reasons.join(' ')).toContain('not established');
  });

  it('refuses names that are not identifiers', () => {
    expect(findDeclaration(vault, 'Claim', '(a+)+', 'ConstraintSeeds')).toMatchObject({
      kind: 'refused',
    });
    expect(findDeclaration(vault, '(a+)+$', 'x', 'ConstraintSeeds').kind).toBe('refused');
    expect(contextStruct(vault, '(a+)+$')).toBeNull();
  });
});

describe('the struct the handler named is the only one offered', () => {
  const two = (buy: string, extra = '') =>
    `${extra}pub fn buy(ctx: Context<Buy>) {}\n${buy}\n` +
    "#[derive(Accounts)]\npub struct Sell<'info> {\n    pub vault: Account<'info, V>,\n}\n";
  const tree = (contents: string) => ({ files: [{ path: 'a.rs', contents }] });

  it('finds the derive more than four lines above the struct', () => {
    const buy =
      '#[derive(Accounts)]\n#[instruction(amount: u64)]\n/// one\n/// two\n/// three\n' +
      "pub struct Buy<'info> {\n    pub vault: Account<'info, V>,\n}";
    const outcome = findDeclaration(tree(two(buy)), 'Buy', 'vault', 'ConstraintMut');
    expect(outcome).toMatchObject({ kind: 'found', viaHandler: true });
    expect(outcome.kind === 'found' && outcome.declaration.struct).toBe('Buy');
  });

  it('refuses rather than substituting Sell when Buy is not an accounts struct', () => {
    const outcome = findDeclaration(
      tree(two("pub struct Buy<'info> {\n    pub vault: Account<'info, V>,\n}")),
      'Buy',
      'vault',
      'ConstraintMut',
    );
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toContain('Context<Buy>');
    const { candidates, reasons } = narrow(
      tree(two("pub struct Buy<'info> {\n    pub vault: Account<'info, V>,\n}")),
      finding('ConstraintMut', 'vault', 2000),
      'Buy',
    );
    expect(candidates).toEqual([]);
    expect(reasons.join(' ')).not.toContain('only struct');
  });

  it('takes the last path segment of a qualified Context argument', () => {
    const source =
      "pub fn buy(ctx: Context<crate::instructions::Buy>) {}\n#[derive(Accounts)]\npub struct Buy<'info> {\n    pub vault: Account<'info, V>,\n}\n#[derive(Accounts)]\npub struct Sell<'info> {\n    pub vault: Account<'info, V>,\n}\n";
    expect(contextStruct(tree(source), 'Buy')).toBe('Buy');
    expect(findDeclaration(tree(source), 'Buy', 'vault', 'ConstraintMut')).toMatchObject({
      kind: 'found',
      viaHandler: true,
    });
  });

  it('does not read the next function’s Context as this handler’s', () => {
    const source =
      "fn buy(amount: u64) -> u64 { amount }\npub fn sell(ctx: Context<Sell>) {}\n#[derive(Accounts)]\npub struct Sell<'info> {\n    pub vault: Account<'info, V>,\n}\n";
    expect(contextStruct(tree(source), 'Buy')).toBeNull();
    // With no Context read, the fallback is the labelled only-struct path.
    expect(findDeclaration(tree(source), 'Buy', 'vault', 'ConstraintMut')).toMatchObject({
      kind: 'found',
      viaHandler: false,
    });
  });

  it('refuses when several fns of the name take different Context types', () => {
    const source = 'pub fn buy(ctx: Context<A>) {}\nmod m { pub fn buy(ctx: Context<B>) {} }\n';
    const outcome = findDeclaration(tree(source), 'Buy', 'vault', 'ConstraintMut');
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toContain('A, B');
  });
});

describe('field and attribute reading', () => {
  const tree = (body: string) => ({
    files: [
      {
        path: 'a.rs',
        contents: `pub fn go(ctx: Context<S>) {}\n#[derive(Accounts)]\npub struct S<'info> {\n${body}\n}\n`,
      },
    ],
  });

  it('matches a field with restricted visibility', () => {
    for (const vis of ['pub ', 'pub(crate) ', 'pub(super) ', 'pub(in crate::a) ', '']) {
      const outcome = findDeclaration(
        tree(`    #[account(mut)]\n    ${vis}vault: Account<'info, V>,`),
        'Go',
        'vault',
        'ConstraintMut',
      );
      expect(outcome.kind).toBe('found');
      expect(outcome.kind === 'found' && outcome.declaration.constraint).toBe('mut');
    }
  });

  it('keeps attributes whose string literals hold unbalanced parentheses', () => {
    const outcome = findDeclaration(
      tree('    #[account(seeds = [b"v(", x.as_ref()], bump)]\n    pub vault: Account<\'info, V>,'),
      'Go',
      'vault',
      'ConstraintSeeds',
    );
    expect(outcome.kind === 'found' && outcome.declaration.attributes).toEqual([
      'seeds = [b"v(", x.as_ref()]',
      'bump',
    ]);
    expect(outcome.kind === 'found' && outcome.declaration.attributesTruncated).toBeUndefined();
  });

  it('reads an account attribute across a #[doc] attribute and doc comments', () => {
    const outcome = findDeclaration(
      tree(
        '    #[account(mut, has_one = authority)]\n    /// the vault\n    #[doc = "x)"]\n    pub vault: Account<\'info, V>,',
      ),
      'Go',
      'vault',
      'ConstraintHasOne',
    );
    expect(outcome.kind === 'found' && outcome.declaration.constraint).toBe('has_one = authority');
  });
});
