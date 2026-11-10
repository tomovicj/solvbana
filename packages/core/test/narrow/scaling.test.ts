import { describe, expect, it } from 'vitest';
import type { SourceTree } from '@solvbana/core';
import {
  indexSource,
  MAX_ENUM_LINES,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
} from '../../src/narrow/sites.ts';
import { contextStruct, findDeclaration } from '../../src/narrow/accounts.ts';
import { narrow } from '../../src/narrow/narrow.ts';
import type { Finding } from '../../src/analyze/types.ts';

/**
 * Worst-case inputs for the lexical scanners. Each builds a file of `n` repeats of
 * a shape the scanner starts on but can never finish: the cases a naive regex
 * re-scans from every start, so the cost goes with the square of the size.
 */
const shapes: Record<string, (n: number) => string> = {
  'require! with no semicolon': (n) => 'require!('.repeat(n),
  'ok_or with no semicolon': (n) => '.ok_or('.repeat(n),
  'path segments with no variant': (n) => `require!(${'a::'.repeat(n)}`,
  'unterminated block comment': (n) => '/* a '.repeat(n),
  'error_code with no closing brace': (n) => '#[error_code]\npub enum E {\n  A,\n'.repeat(n),
  'Context< with no >': (n) => 'fn buy(ctx: Context<'.repeat(n),
  'fn name< with no >': (n) => 'fn buy<'.repeat(n),
  'fn handler with no body': (n) => 'require!(a, E::Boom);\n' + 'fn settle(\n'.repeat(n),
  'fn handler with unclosed bodies': (n) => 'require!(a, E::Boom);\n' + 'fn settle() {\n'.repeat(n),
  'enum variant with no comma': (n) =>
    `#[error_code]\npub enum E {\n    A${' '.repeat(n * 10)}x\n}`,
  'nested accounts structs': (n) => '#[derive(Accounts)]\nstruct A {\n'.repeat(n) + '}\n'.repeat(n),
  'accounts structs with no closing brace': (n) =>
    '#[derive(Accounts)]\npub struct S {\n'.repeat(n),
};

const tree = (contents: string): SourceTree => ({ files: [{ path: 'src/lib.rs', contents }] });

const finding: Finding = {
  program: 'Vau1t1111111111111111111111111111111111111',
  programSource: 'logs',
  handler: null,
  handlerSource: null,
  error: { code: 6000, name: 'Boom', message: null, naming: 'logged' },
  failure: { kind: 'anchor', account: null, site: null, comparison: null },
  explanation: 'x',
};

function diagnose(source: SourceTree): number {
  const index = indexSource(source);
  contextStruct(source, 'buy');
  findDeclaration(source, 'buy', 'x', 'ConstraintSeeds');
  narrow(source, finding, 'Settle');
  narrow(source, finding, 'Buy');
  return index.work;
}

/** Best of a few runs: the minimum is the least disturbed by a busy machine. */
function best(source: SourceTree): number {
  let fastest = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    diagnose(source);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

const N = 1_500;
/** Shapes whose per-start constant is a whole capped block get a smaller N. */
const SIZES: Record<string, number> = { 'accounts structs with no closing brace': 400 };

describe('scanner scaling', () => {
  for (const [name, build] of Object.entries(shapes)) {
    it(`grows linearly on ${name}`, () => {
      const n = SIZES[name] ?? N;
      const small = tree(build(n));
      const large = tree(build(4 * n));

      // Deterministic: characters examined must follow input size. Linear is
      // 4x; 6x leaves room for per-line constants and still fails a square (16x).
      const workSmall = indexSource(small).work;
      const workLarge = indexSource(large).work;
      expect(workLarge).toBeLessThan(6 * Math.max(workSmall, 1));

      // Wall clock catches what the counter cannot see, a regex backtracking
      // inside one match. Linear is 4x and quadratic 16x, so 10x separates them
      // with margin; the floor keeps timer noise on tiny durations from deciding.
      const timeSmall = best(small);
      const timeLarge = best(large);
      expect(timeLarge).toBeLessThan(10 * Math.max(timeSmall, 5));
    });
  }
});

describe('input bounds', () => {
  it('skips a file over the size cap and says so', () => {
    const big = { path: 'src/big.rs', contents: ' '.repeat(MAX_FILE_CHARS + 1) };
    const small = { path: 'src/ok.rs', contents: 'require!(a, E::Thing);' };
    const index = indexSource({ files: [big, small] });

    expect(index.files).toBe(1);
    expect(index.sites.map((site) => site.variant)).toEqual(['Thing']);
    expect(index.skipped).toHaveLength(1);
    expect(index.skipped[0]?.path).toBe('src/big.rs');
    expect(index.skipped[0]?.reason).toContain(String(MAX_FILE_CHARS));
  });

  it('skips files past the total budget, in order', () => {
    const chunk = ' '.repeat(MAX_FILE_CHARS);
    const count = Math.floor(MAX_TOTAL_CHARS / MAX_FILE_CHARS) + 1;
    const files = Array.from({ length: count }, (_, i) => ({
      path: `src/f${String(i)}.rs`,
      contents: chunk,
    }));
    const index = indexSource({ files });

    expect(index.files).toBe(count - 1);
    expect(index.skipped.map((entry) => entry.path)).toEqual([`src/f${String(count - 1)}.rs`]);
  });

  it('reports nothing skipped for a tree within bounds', () => {
    expect(indexSource(tree('require!(a, E::Thing);')).skipped).toEqual([]);
  });

  it('refuses an error enum with no closing brace in reach', () => {
    const body = '  A,\n'.repeat(MAX_ENUM_LINES + 10);
    const index = indexSource(tree(`#[error_code]\npub enum E {\n${body}`));

    expect(index.enums).toEqual([]);
    expect(index.skipped[0]?.reason).toContain('enum E');
  });

  it('still reads an enum cut off by the next error_code attribute', () => {
    const index = indexSource(
      tree('#[error_code]\npub enum A {\n  X,\n#[error_code]\npub enum B {\n  Y,\n}\n'),
    );

    expect(index.enums.map((entry) => entry.name)).toEqual(['A', 'B']);
    expect(index.skipped).toEqual([]);
  });
});

describe('narrow() on hostile input', () => {
  const source = tree('require!(a, E::Boom);\n' + 'fn settle(\n'.repeat(20_000));

  it('stays fast with a handler on the unclosed-fn shape', () => {
    const start = performance.now();
    const { candidates, reasons } = narrow(source, finding, 'Settle');
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(candidates).toHaveLength(1);
    expect(reasons.join(' ')).toContain('had no body');
  });

  it('refuses regex-shaped names without running them', () => {
    for (const hostile of ['(a+)+', '(a+)+$', 'a'.repeat(65), '', 'x y', '.*']) {
      const start = performance.now();
      const named = narrow(source, finding, hostile);
      expect(performance.now() - start).toBeLessThan(200);
      expect(named.reasons.join(' ')).toContain('not a Rust identifier');

      const variant = narrow(
        source,
        { ...finding, error: { ...finding.error, name: hostile } },
        null,
      );
      expect(variant.reasons.join(' ')).toContain('not a Rust identifier');
    }
    const start = performance.now();
    findDeclaration(source, '(a+)+', '(a+)+', 'ConstraintSeeds');
    contextStruct(source, '(a+)+');
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('whole-tree bounds', () => {
  const files = (line: string) =>
    Array.from({ length: 8 }, (_, i) => ({
      path: `src/f${String(i)}.rs`,
      contents: line.repeat(Math.floor(MAX_FILE_CHARS / line.length)),
    }));
  const boom: Finding = {
    program: 'Vau1t1111111111111111111111111111111111111',
    programSource: 'logs',
    handler: null,
    handlerSource: null,
    error: { code: 6000, name: 'Boom', message: null, naming: 'logged' },
    failure: { kind: 'anchor', account: null, site: null, comparison: null },
    explanation: 'x',
  };

  for (const [name, line] of Object.entries({
    'fn with a site': 'fn buy() { require!(a, E::Boom); }\n',
    'bare sites': 'require!(a, E::Boom);\n',
    'Err openers': 'Err(',
  })) {
    it(`narrows 8 x 1 MB of ${name} in about a second, with a capped candidate list`, () => {
      const tree = { files: files(line) };
      const start = performance.now();
      const result = narrow(tree, boom, 'Buy');
      expect(performance.now() - start).toBeLessThan(5_000);
      expect(result.candidates.length).toBeLessThanOrEqual(50);
      expect(JSON.stringify(result).length).toBeLessThan(100_000);
    });
  }

  it('narrows a declaration error over the same trees in the same time', () => {
    const tree = { files: files('Err(') };
    const f: Finding = {
      ...boom,
      error: { ...boom.error, name: 'ConstraintSeeds', code: 2006 },
      failure: { kind: 'anchor', account: 'x', site: null, comparison: null },
    };
    const start = performance.now();
    narrow(tree, f, 'Buy');
    expect(performance.now() - start).toBeLessThan(5_000);
  });
});
