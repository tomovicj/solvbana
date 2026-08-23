import { describe, expect, it } from 'vitest';
import { indexSource, type SourceTree } from '@solvbana/core';
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
