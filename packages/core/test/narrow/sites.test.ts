import { describe, expect, it } from 'vitest';
import { indexSource, type SourceTree } from '@solvbana/core';
import { MAX_IDENT, MAX_INVOCATION_CHARS } from '../../src/narrow/sites.ts';
import { sourceTree } from '../fixtures.ts';

const vault: SourceTree = sourceTree('vault');

function variants(tree: SourceTree, variant: string) {
  return indexSource(tree).sites.filter((site) => site.variant === variant);
}

describe('indexSource', () => {
  it('finds a require! raising a named variant', () => {
    const [site, ...rest] = variants(vault, 'VaultLocked');

    expect(rest).toHaveLength(0);
    expect(site?.file).toBe('src/instructions/withdraw.rs');
    expect(site?.form).toBe('require');
    expect(site?.text).toContain('require!(!ctx.accounts.vault.locked');
  });

  it('ignores a commented-out throw', () => {
    // The withdraw fixture carries `// require!(amount > 0, VaultError::VaultLocked);`
    // directly above the real one. Offering it would send a reader to a line
    // that cannot execute.
    const site = variants(vault, 'VaultLocked')[0];
    expect(site?.text.startsWith('//')).toBe(false);
  });

  it('finds every form across the tree', () => {
    const forms = new Set(indexSource(vault).sites.map((site) => site.form));
    expect([...forms].sort()).toEqual(['constraint', 'err', 'ok-or', 'require']);
  });

  it('finds the same variant raised in more than one file', () => {
    const sites = variants(vault, 'AmountTooSmall');

    expect(sites).toHaveLength(3);
    expect(new Set(sites.map((site) => site.file)).size).toBe(2);
    expect(sites.map((site) => site.form).sort()).toEqual(['ok-or', 'require', 'require']);
  });

  it('finds a variant raised only from an account attribute', () => {
    const [site] = variants(vault, 'WrongAuthority');
    expect(site?.form).toBe('constraint');
    expect(site?.text).toContain('@ VaultError::WrongAuthority');
  });

  it('reports no site for a variant that is declared and never raised', () => {
    expect(variants(vault, 'NeverThrown')).toHaveLength(0);
  });

  it('numbers an #[error_code] enum the way Anchor does', () => {
    const [errors, ...rest] = indexSource(vault).enums;

    expect(rest).toHaveLength(0);
    expect(errors?.name).toBe('VaultError');
    expect(errors?.codes.get(6000)).toBe('VaultLocked');
    expect(errors?.codes.get(6001)).toBe('AmountTooSmall');
    expect(errors?.codes.get(6004)).toBe('LimitExceeded');
  });

  it('honours an explicit discriminant and keeps counting from it', () => {
    const tree = {
      files: [
        {
          path: 'e.rs',
          contents: '#[error_code]\npub enum E {\n  A,\n  B = 6100,\n  C,\n}\n',
        },
      ],
    };
    const codes = indexSource(tree).enums[0]?.codes;

    expect(codes?.get(6000)).toBe('A');
    expect(codes?.get(6100)).toBe('B');
    // Without this, one pinned code would misnumber every later variant and the
    // proof built on the ordering would refuse a perfectly correct tree.
    expect(codes?.get(6101)).toBe('C');
  });

  it('reads a non-default offset from the attribute', () => {
    const tree = {
      files: [{ path: 'e.rs', contents: '#[error_code(offset = 100)]\npub enum E {\n  A,\n}\n' }],
    };
    expect(indexSource(tree).enums[0]?.codes.get(100)).toBe('A');
  });

  it('does not mistake an ordinary enum reference for a throw', () => {
    const tree = {
      files: [
        { path: 'a.rs', contents: 'let kind = Mode::Fast;\nmatch kind { Mode::Fast => 1 }\n' },
      ],
    };
    expect(indexSource(tree).sites).toHaveLength(0);
  });

  it('reports one site per variant per line rather than one per pattern', () => {
    // `return Err(...)` matches both the `Err(` and the `err!`-adjacent forms.
    // A duplicate would inflate a candidate set with the same line twice, which
    // reads as two alternatives where there is one.
    const tree = {
      files: [{ path: 'a.rs', contents: 'return Err(error!(E::Boom));\n' }],
    };
    expect(indexSource(tree).sites).toHaveLength(1);
  });
});

describe('indexSource invocation parsing', () => {
  const sites = (contents: string) => indexSource({ files: [{ path: 'a.rs', contents }] }).sites;
  const names = (contents: string) => sites(contents).map((site) => site.variant);

  it('reads a require! that rustfmt wrapped across lines, at the opener line', () => {
    const found = sites(
      'fn f() {\n    require!(\n        a > b,\n        ErrorCode::Wrapped\n    );\n}\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ variant: 'Wrapped', line: 2, form: 'require' });
  });

  it('takes the error argument, not an enum path in the condition', () => {
    expect(names('require!(pool.status == PoolStatus::Active, ErrorCode::PoolInactive);')).toEqual([
      'PoolInactive',
    ]);
  });

  it('indexes require_keys_eq! with an error and not without one', () => {
    expect(names('require_keys_eq!(a, crate::ID, ErrorCode::BadKey);')).toEqual(['BadKey']);
    expect(names('require_keys_eq!(a, crate::ID);')).toEqual([]);
  });

  it('indexes no variant for a comparing macro that omits the error', () => {
    expect(names('require_eq!(a, b);')).toEqual([]);
    expect(names('require_gt!(a, Limits::MAX);')).toEqual([]);
  });

  it('accepts a qualified or converted error argument', () => {
    expect(names('require!(x, crate::errors::ErrorCode::Deep);')).toEqual(['Deep']);
    expect(names('require!(x, ErrorCode::Into.into());')).toEqual(['Into']);
  });

  it('records nothing when the last argument is not an error path', () => {
    expect(names('require!(x, some_call(y));')).toEqual([]);
  });

  it('survives nested parentheses and a string holding ) and ,', () => {
    const source =
      'require!(\n  check(f(a, (b, c)), "close ) and, comma // not a comment") && x,\n  E::Nested\n);';
    expect(names(source)).toEqual(['Nested']);
  });

  it('still indexes an @ constraint', () => {
    expect(names('#[account(constraint = a == b @ VaultError::WrongAuthority)]')).toEqual([
      'WrongAuthority',
    ]);
  });

  it('reads a 450-character single-line condition', () => {
    const condition = Array.from({ length: 50 }, (_, i) => `a${String(i)} == 1`).join(' && ');
    expect(condition.length).toBeGreaterThan(400);
    expect(names(`require!(${condition}, ErrorCode::Long);`)).toEqual(['Long']);
  });

  it('reports an invocation past the cap instead of dropping it silently', () => {
    const condition = 'a'.repeat(MAX_INVOCATION_CHARS + 10);
    const index = indexSource({
      files: [{ path: 'big.rs', contents: `\nrequire!(${condition}, ErrorCode::Huge);` }],
    });
    expect(index.sites).toEqual([]);
    expect(index.skipped).toHaveLength(1);
    expect(index.skipped[0]?.path).toBe('big.rs');
    expect(index.skipped[0]?.reason).toContain('first at line 2');
  });

  it('skips an over-long identifier with an entry rather than truncating it', () => {
    const long = 'V'.repeat(MAX_IDENT + 10);
    const index = indexSource({
      files: [{ path: 'a.rs', contents: `require!(x, E::${long});\nrequire!(x, E::Short);` }],
    });
    expect(index.sites.map((site) => site.variant)).toEqual(['Short']);
    expect(index.skipped[0]?.reason).toContain('line 1');
  });

  it('does not take a // inside a string literal for a comment', () => {
    expect(names('require!(url != "http://x", E::Url);')).toEqual(['Url']);
  });
});

describe('indexSource regressions', () => {
  const names = (contents: string) =>
    indexSource({ files: [{ path: 'a.rs', contents }] }).sites.map((site) => site.variant);

  it('numbers an enum whose last variant has no trailing comma', () => {
    const tree = {
      files: [{ path: 'e.rs', contents: '#[error_code]\npub enum E {\n  A,\n  B\n}\n' }],
    };
    const codes = indexSource(tree).enums[0]?.codes;
    expect(codes?.get(6000)).toBe('A');
    expect(codes?.get(6001)).toBe('B');
  });

  it('refuses an enum with a discriminant it cannot follow', () => {
    const tree = {
      files: [{ path: 'e.rs', contents: '#[error_code]\npub enum E {\n  A = 1 << 3,\n  B,\n}\n' }],
    };
    const index = indexSource(tree);
    expect(index.enums).toEqual([]);
    expect(index.skipped[0]?.reason).toContain('discriminant');
  });

  it('indexes a block-bodied closure and a turbofish into', () => {
    expect(names('x.ok_or_else(|| { E::Block })?;')).toEqual(['Block']);
    expect(names('return Err(E::Turbo.into::<Error>());')).toEqual(['Turbo']);
  });

  it('does not index an opener that sits inside a string literal', () => {
    expect(names('msg!("err!(MyError::X)");')).toEqual([]);
    expect(names('let s = "require!(a, E::Y)";')).toEqual([]);
    expect(names('let s = "x@ Foo::Bar";')).toEqual([]);
  });

  it('indexes @ only inside #[account(...)] and not a pattern binding', () => {
    expect(names('match s { v @ State::Active => 1, _ => 0 }')).toEqual([]);
    expect(names('#[account(\n  mut,\n  constraint = a == b @ E::Wrapped\n)]')).toEqual([
      'Wrapped',
    ]);
  });

  it('skips Err(..) patterns and keeps expressions', () => {
    expect(names('match r { Err(E::Pat) => 1, _ => 0 }')).toEqual([]);
    expect(names('match r { Err(E::A) | Err(E::B) => 1, _ => 0 }')).toEqual([]);
    expect(names('if let Err(E::Let) = r {}')).toEqual([]);
    expect(names('assert!(matches!(r, Err(E::M)));')).toEqual([]);
    expect(names('return Err(E::Real.into());')).toEqual(['Real']);
    // Cannot be told cheaply, so it stays indexed.
    expect(names('match r { Err(E::Guard) if x => 1, _ => 0 }')).toEqual(['Guard']);
  });

  it('accepts [] and {} macro delimiters', () => {
    expect(names('require![a, E::Sq];')).toEqual(['Sq']);
    expect(names('require!{a, E::Cu};')).toEqual(['Cu']);
  });

  it('quotes the invocation, not just its opener, for a wrapped require!', () => {
    const [site] = indexSource({
      files: [{ path: 'a.rs', contents: 'require!(\n    a > b,\n    E::Wrapped\n);' }],
    }).sites;
    expect(site?.line).toBe(1);
    expect(site?.text).toBe('require!( a > b, E::Wrapped )');
  });
});
