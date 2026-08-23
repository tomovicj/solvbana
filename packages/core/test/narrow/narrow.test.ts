import { describe, expect, it } from 'vitest';
import { narrow, type Finding } from '@solvbana/core';
import { sourceTree } from '../fixtures.ts';

const vault = sourceTree('vault');
const stale = sourceTree('vault-stale');

function finding(name: string | null, code: number | null): Finding {
  return {
    program: 'Vau1t1111111111111111111111111111111111111',
    programSource: 'logs',
    handler: null,
    handlerSource: null,
    error: { code, name, message: null, naming: name === null ? 'none' : 'logged' },
    failure: { kind: 'anchor', account: null, site: null, comparison: null },
    explanation: 'A declared error was raised.',
  };
}

describe('narrow', () => {
  it('finds the single site raising the error that fired', () => {
    const { candidates } = narrow(vault, finding('VaultLocked', 6000), 'Withdraw');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.location.file).toBe('src/instructions/withdraw.rs');
    expect(candidates[0]?.rank).toBe(1);
  });

  it('reports every site when a variant is raised more than once', () => {
    // Three sites across two handlers. Collapsing them to the top one would be
    // exactly the confident guess the project refuses.
    const { candidates } = narrow(vault, finding('AmountTooSmall', 6001), 'Withdraw');

    expect(candidates).toHaveLength(3);
    expect(candidates.map((site) => site.rank)).toEqual([1, 2, 3]);
  });

  it('ranks sites inside the failing handler above sites outside it', () => {
    const { candidates } = narrow(vault, finding('AmountTooSmall', 6001), 'Deposit');
    const top = candidates[0]!;

    expect(top.location.file).toBe('src/instructions/deposit.rs');
    expect(top.rationale).toContain('inside deposit');
    // The two withdraw sites survive; they are ranked below, not dropped.
    expect(candidates.slice(1).every((c) => c.location.file.endsWith('withdraw.rs'))).toBe(true);
  });

  it('caps every rationale with the fact that the tree is unverified', () => {
    // What licenses `narrowed` and forbids `exact`, so it must reach the reader
    // on every candidate rather than sitting in a doc comment.
    const { candidates } = narrow(vault, finding('AmountTooSmall', 6001), 'Withdraw');
    expect(candidates.every((site) => site.rationale.includes('supplied rather than built'))).toBe(
      true,
    );
  });

  it('still reports a site the failing handler does not lexically contain', () => {
    // `LimitExceeded` is raised in a helper `withdraw` calls. A lexical index
    // cannot follow the call, and dropping the site would lose the only answer.
    const { candidates, reasons } = narrow(vault, finding('LimitExceeded', 6004), 'Withdraw');

    expect(candidates).toHaveLength(1);
    expect(reasons.join(' ')).toContain('never inside withdraw');
  });

  it('finds a site declared as an account constraint attribute', () => {
    const { candidates } = narrow(vault, finding('WrongAuthority', 6003), 'Withdraw');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rationale).toContain('constraint form');
  });

  it('refuses a tree whose error numbering contradicts the failure', () => {
    // The stale tree numbers 6001 as `NeverThrown`, not `AmountTooSmall`. Every
    // line it offers would be plausible and wrong.
    const { candidates, reasons } = narrow(stale, finding('AmountTooSmall', 6001), 'Withdraw');

    expect(candidates).toEqual([]);
    expect(reasons.join(' ')).toContain('different version');
  });

  it('reports a variant the tree declares but never raises', () => {
    const { candidates, reasons } = narrow(vault, finding('NeverThrown', 6002), 'Withdraw');

    expect(candidates).toEqual([]);
    expect(reasons.join(' ')).toContain('not raised anywhere');
  });

  it('refuses when no error name was established', () => {
    // 68% of live failures. Source cannot help until the code has a name.
    const { candidates, reasons } = narrow(vault, finding(null, 6001), 'Withdraw');

    expect(candidates).toEqual([]);
    expect(reasons.join(' ')).toContain('nothing to look for');
  });

  it('says the numbering went unchecked when the failure carried no code', () => {
    const { candidates, reasons } = narrow(vault, finding('VaultLocked', null), 'Withdraw');

    expect(candidates).toHaveLength(1);
    expect(reasons.join(' ')).toContain('no numeric error code');
    expect(candidates[0]?.rationale).toContain('could not be checked');
  });

  it('reports unranked when no handler was identified', () => {
    const { candidates, reasons } = narrow(vault, finding('AmountTooSmall', 6001), null);

    expect(candidates).toHaveLength(3);
    expect(reasons.join(' ')).toContain('No handler was identified');
  });
});
