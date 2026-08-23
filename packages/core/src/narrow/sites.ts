import type { SourceFile, SourceTree } from '../rpc/source.ts';

/**
 * How a throw site raises its error.
 *
 * Kept as data rather than folded into the rationale prose because the form is
 * a real ranking signal — an `#[account(...)]` attribute and a `require!` in a
 * handler body fail for different reasons, and a reader looking for a constraint
 * violation should be able to filter for one.
 */
export type ThrowForm =
  /** `require!(cond, X::Variant)` and its comparing relatives. */
  | 'require'
  /** `err!` / `error!` / `return Err(X::Variant.into())`. */
  | 'err'
  /** `.ok_or(X::Variant)?` and `.ok_or_else(|| X::Variant)?`. */
  | 'ok-or'
  /** An `#[account(...)]` attribute carrying `@ X::Variant`. */
  | 'constraint';

/** One place in the supplied source that raises a named error variant. */
export interface ThrowSite {
  file: string;
  /** 1-based, so it can be quoted to a reader or opened in an editor. */
  line: number;
  /** The variant identifier alone — the enum it belongs to is not resolved. */
  variant: string;
  form: ThrowForm;
  /** The source line, trimmed. What makes a candidate checkable by eye. */
  text: string;
}

/**
 * An `#[error_code]` enum as the source declares it.
 *
 * The declaration order is the load-bearing part: Anchor numbers variants
 * sequentially from a base, so the order maps a `Custom(n)` code back to a name.
 * That is what lets an uploaded tree prove it describes the program that ran.
 */
export interface ErrorEnum {
  name: string;
  file: string;
  /** Variant name by the code Anchor would assign it. */
  codes: Map<number, string>;
}

export interface SourceIndex {
  sites: ThrowSite[];
  enums: ErrorEnum[];
  /** Files that were scanned, for stating the search space in a refusal. */
  files: number;
}

/**
 * Anchor's default first error code.
 *
 * `#[error_code]` starts user errors at 6000, below which sit the framework's
 * own reserved bands. An `offset` argument can move it, and that is read from
 * the attribute when present rather than assumed.
 */
const DEFAULT_OFFSET = 6000;

/**
 * A Rust path segment ending in the variant: `ErrorCode::Foo`, `crate::E::Foo`.
 *
 * Matched on the *variant* rather than the enum, because the enum is whatever
 * the author named it while the variant is what Anchor logs and what Phase 1 and
 * 2 establish. Restricting matches to throw positions — inside a `require!`,
 * after an `@`, inside an `Err(...)` — is what keeps an ordinary enum reference
 * out of the index.
 */
const VARIANT = '(?:[A-Za-z_][A-Za-z0-9_]*\\s*::\\s*)+([A-Z][A-Za-z0-9_]*)';

const PATTERNS: { form: ThrowForm; regex: RegExp }[] = [
  // `require!(x > 0, MyError::TooSmall)` and require_eq!/_neq!/_gt!/_gte!/
  // _keys_eq!/_keys_neq!, whose error argument is always the last one.
  { form: 'require', regex: new RegExp(`\\brequire(?:_[a-z_]+)?!\\s*\\([^;]*?${VARIANT}`, 'g') },
  // `err!(MyError::X)`, `error!(MyError::X)`, `return Err(MyError::X.into())`.
  { form: 'err', regex: new RegExp(`\\b(?:err|error)!\\s*\\(\\s*${VARIANT}`, 'g') },
  { form: 'err', regex: new RegExp(`\\bErr\\s*\\(\\s*${VARIANT}`, 'g') },
  // `.ok_or(MyError::X)?` and `.ok_or_else(|| MyError::X)?`.
  { form: 'ok-or', regex: new RegExp(`\\.ok_or(?:_else)?\\s*\\([^;]*?${VARIANT}`, 'g') },
  // An `#[account(constraint = a == b @ MyError::X)]` attribute. The `@` is
  // Anchor's own syntax for "raise this when the constraint fails", so it is an
  // unambiguous throw position.
  { form: 'constraint', regex: new RegExp(`@\\s*${VARIANT}`, 'g') },
];

/**
 * Index every place the supplied source raises a named error.
 *
 * Deliberately lexical. A call graph would be needed to say which sites the
 * failing handler can actually reach, and that is a Rust front end's job; what
 * this produces is every site raising a variant, which is enough because the
 * variant that fired is already known. Ranking, not reachability, is what
 * narrows the set — see `narrow.ts`.
 *
 * Comments are stripped before matching so a commented-out `require!` cannot
 * become a candidate line.
 */
export function indexSource(tree: SourceTree): SourceIndex {
  const sites: ThrowSite[] = [];
  const enums: ErrorEnum[] = [];

  for (const file of tree.files) {
    const lines = stripComments(file.contents).split('\n');
    sites.push(...sitesIn(file, lines));
    enums.push(...enumsIn(file, lines));
  }

  return { sites, enums, files: tree.files.length };
}

function sitesIn(file: SourceFile, lines: readonly string[]): ThrowSite[] {
  const found: ThrowSite[] = [];

  lines.forEach((line, index) => {
    const seen = new Set<string>();
    for (const { form, regex } of PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const variant = match[1]!;
        // One site per variant per line. `require!` and `Err(` both match a
        // `return Err(require_x)` shape, and reporting one line twice would
        // inflate a candidate set with a duplicate rather than a real
        // alternative.
        const key = `${variant}:${String(index)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          file: file.path,
          line: index + 1,
          variant,
          form,
          text: line.trim(),
        });
      }
    }
  });

  return found;
}

/**
 * Read `#[error_code] pub enum X { ... }` into the codes Anchor assigns.
 *
 * An explicit discriminant is honoured and moves the running counter, exactly as
 * Rust and therefore Anchor treat it. Without that, a program that pins one
 * variant's code would have every later variant misnumbered, and the proof built
 * on this ordering would reject a tree that is perfectly correct.
 */
function enumsIn(file: SourceFile, lines: readonly string[]): ErrorEnum[] {
  const found: ErrorEnum[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const attribute = /#\[error_code(?:\s*\(\s*offset\s*=\s*(\d+)\s*\))?\s*\]/.exec(lines[i]!);
    if (attribute === null) continue;

    const header = lines.slice(i + 1, i + 6).findIndex((line) => /\benum\s+[A-Za-z_]/.test(line));
    if (header < 0) continue;
    const start = i + 1 + header;
    const name = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[start]!)?.[1];
    if (name === undefined) continue;

    const codes = new Map<number, string>();
    let next = attribute[1] === undefined ? DEFAULT_OFFSET : Number(attribute[1]);

    for (let j = start; j < lines.length; j += 1) {
      if (j > start && lines[j]!.includes('}')) break;
      const variant = /^\s*([A-Z][A-Za-z0-9_]*)\s*(?:=\s*(\d+))?\s*,/.exec(lines[j]!);
      if (variant === null) continue;
      if (variant[2] !== undefined) next = Number(variant[2]);
      codes.set(next, variant[1]!);
      next += 1;
    }

    found.push({ name, file: file.path, codes });
  }

  return found;
}

/**
 * Blank out comments, preserving line numbering.
 *
 * Replaced with spaces rather than removed so every reported line number still
 * refers to the same line of the file the developer uploaded. String literals
 * containing `//` are not handled — a false negative there costs a candidate,
 * while treating a real comment as code would cost a wrong one.
 */
function stripComments(contents: string): string {
  const withoutBlocks = contents.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at < 0 ? line : line.slice(0, at);
    })
    .join('\n');
}
