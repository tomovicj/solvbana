import type { SourceTree } from '../rpc/source.ts';
import {
  lineOf,
  literalEnd,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  prepareTree,
  type PreparedFile,
  type PreparedTree,
  type SkippedFile,
  type WorkCounter,
} from './lex.ts';

export { MAX_FILE_CHARS, MAX_TOTAL_CHARS, type SkippedFile };

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
  /**
   * Files (or enums and invocations within them) that were refused rather than
   * read: over a size cap, an `#[error_code]` enum with no closing brace in reach,
   * a macro invocation longer than `MAX_INVOCATION_CHARS`, or an identifier too
   * long to be a name. A search space that silently omits text would let "no site
   * found" read as "no site exists", so every refusal is listed here for the
   * caller to state.
   */
  skipped: SkippedFile[];
  /**
   * Characters examined by the scanners below, summed. A deterministic stand-in
   * for running time: the scaling regression test asserts it grows linearly with
   * input, which a wall-clock measurement on a loaded machine cannot.
   */
  work: number;
}

/**
 * The longest macro invocation walked for its closing parenthesis, in characters.
 *
 * A `require!` wrapped by rustfmt is a few hundred characters; this is an order
 * of magnitude past that. Each opener's walk is bounded by it, so the pass costs
 * at most this much per opener, and an invocation that reaches it is reported in
 * `skipped` rather than dropped.
 */
export const MAX_INVOCATION_CHARS = 4_000;

/**
 * Total characters walked per tree, as a multiple of its length plus a floor.
 * Keeps the whole pass linear however many openers a tree contains; invocations
 * past it are counted in `skipped` like those over `MAX_INVOCATION_CHARS`.
 */
const WALK_BUDGET_FACTOR = 1;
const WALK_BUDGET_FLOOR = 100_000;

/**
 * Lines an `#[error_code]` enum may span before it is refused. Real enums run to
 * a few hundred variants; an enum with no closing brace would otherwise be read
 * to the end of the file.
 */
export const MAX_ENUM_LINES = 2_000;

/** Longest identifier, and most path segments, followed in an error path. */
export const MAX_IDENT = 64;
const MAX_SEGMENTS = 8;

/**
 * Anchor's default first error code.
 *
 * `#[error_code]` starts user errors at 6000, below which sit the framework's
 * own reserved bands. An `offset` argument can move it, and that is read from
 * the attribute when present rather than assumed.
 */
const DEFAULT_OFFSET = 6000;

// Openers, matched on their own. The arguments are then read by a bracket-matching
// walk (`walk`) rather than by a pattern, because the error is the last argument
// of an invocation that may wrap across lines and contain paths of its own.
const REQUIRE = /\b(require(?:_[a-z_]{1,40})?)!\s{0,16}[([{]/g;
const ERR_MACRO = /\b(?:err|error)!\s{0,16}[([{]/g;
const ACCOUNT_ATTRIBUTE = /#\s{0,16}\[\s{0,16}account\s{0,16}\(/g;
const ERR_RETURN = /\bErr\s{0,16}\(/g;
const OK_OR = /\.ok_or(?:_else)?\s{0,16}\(/g;
const INTO = /^\.\s{0,16}into\s{0,16}(?:::\s{0,16}<[^()]{0,64}>\s{0,16})?\(\s{0,16}\)$/;

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
  const counter: WorkCounter = { work: 0 };
  return indexPrepared(prepareTree(tree, counter), counter);
}

/** `indexSource` over a tree already prepared, so a caller can share the pass. */
export function indexPrepared(prepared: PreparedTree, counter: WorkCounter): SourceIndex {
  const sites: ThrowSite[] = [];
  const enums: ErrorEnum[] = [];
  const skipped: SkippedFile[] = [...prepared.skipped];
  // One walking budget for the whole tree, so it is the tree's size and not the
  // number of files that bounds the work.
  let total = 0;
  for (const file of prepared.files) total += file.text.length;
  const walking = { spent: 0, budget: WALK_BUDGET_FACTOR * total + WALK_BUDGET_FLOOR };

  // Pushed one at a time: spreading hundreds of thousands of sites into `push`
  // overflows the argument limit.
  for (const file of prepared.files) {
    for (const site of sitesIn(file, counter, skipped, walking)) sites.push(site);
    for (const entry of enumsIn(file, file.codeLines, skipped, counter)) enums.push(entry);
  }

  return { sites, enums, files: prepared.files.length, skipped, work: counter.work };
}

type Walked =
  | { kind: 'ok'; close: number; commas: number[] }
  /** The invocation is longer than `MAX_INVOCATION_CHARS`. */
  | { kind: 'cap' }
  /** Not a well-formed invocation: unbalanced, or a `;` directly inside parentheses. */
  | { kind: 'open' };

/**
 * Walk from the `(` at `open` to its matching `)`, across lines.
 *
 * Counts parenthesis, bracket and brace depth and steps over string and character
 * literals, so a `)` or `,` inside a message does not end an argument. Records the
 * commas that sit directly inside the opening parenthesis. A `;` directly inside
 * parentheses is not Rust, so it ends the walk early; inside braces or brackets
 * (`{ a; b }`, `[0; 8]`) it is ordinary. Bounded by `MAX_INVOCATION_CHARS`, and
 * each character is examined once per opener.
 */
function walk(text: string, open: number, counter: WorkCounter): Walked {
  const limit = Math.min(text.length, open + MAX_INVOCATION_CHARS);
  const stack: string[] = [];
  const commas: number[] = [];
  const finish = (at: number, result: Walked): Walked => {
    counter.work += at - open + 1;
    return result;
  };

  for (let at = open; at < limit; at += 1) {
    const char = text[at]!;
    if (char === '(') stack.push(')');
    else if (char === '[') stack.push(']');
    else if (char === '{') stack.push('}');
    else if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) return finish(at, { kind: 'open' });
      if (stack.length === 0) return finish(at, { kind: 'ok', close: at, commas });
    } else if (char === ',') {
      if (stack.length === 1) commas.push(at);
    } else if (char === ';') {
      if (stack.at(-1) === ')') return finish(at, { kind: 'open' });
    } else if (char === '"' || char === "'" || char === 'r' || char === 'b') {
      const end = literalEnd(text, at, limit);
      if (end < 0) return finish(limit, limit < text.length ? { kind: 'cap' } : { kind: 'open' });
      if (end > at) at = end - 1;
    }
  }
  return finish(limit, limit < text.length ? { kind: 'cap' } : { kind: 'open' });
}

/** The invocation's top-level arguments, trimmed; a trailing comma adds none. */
function argumentsOf(text: string, open: number, walked: Walked & { kind: 'ok' }): string[] {
  const starts = [open + 1, ...walked.commas.map((comma) => comma + 1)];
  const ends = [...walked.commas, walked.close];
  const args = starts.map((start, i) => text.slice(start, ends[i]).trim());
  if (args.at(-1) === '') args.pop();
  return args;
}

type PathRead = { kind: 'path'; variant: string; end: number } | { kind: 'too-long' } | null;

function isIdentStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isIdentPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  return at;
}

/**
 * Read `Type::Variant` (any number of leading segments) starting at `from`.
 *
 * Needs at least two segments and an upper-case last one, and an identifier past
 * `MAX_IDENT` is reported as `too-long` rather than truncated, so it cannot be
 * mistaken for a different, shorter name.
 */
function readPath(text: string, from: number): PathRead {
  let at = skipSpace(text, from);
  let segments = 0;
  let last = '';
  let end = at;
  let tooLong = false;

  for (;;) {
    if (!isIdentStart(text[at])) return null;
    const start = at;
    while (isIdentPart(text[at])) at += 1;
    last = text.slice(start, at);
    if (last.length > MAX_IDENT) tooLong = true;
    segments += 1;
    end = at;
    if (segments > MAX_SEGMENTS) return null;

    const colons = skipSpace(text, at);
    if (text[colons] !== ':' || text[colons + 1] !== ':') break;
    at = skipSpace(text, colons + 2);
  }

  if (segments < 2 || !/[A-Z]/.test(last[0]!)) return null;
  return tooLong ? { kind: 'too-long' } : { kind: 'path', variant: last, end };
}

/** The error an argument names: a bare path, optionally `.into()`. */
function errorArgument(arg: string): PathRead {
  const read = readPath(arg, 0);
  if (read === null || read.kind === 'too-long') return read;
  const rest = arg.slice(read.end).trim();
  return rest === '' || INTO.test(rest) ? read : null;
}

/** Per-file tally of what the site scan declined to read. */
class Declined {
  private readonly counts = new Map<string, { count: number; line: number }>();

  add(kind: 'invocation' | 'identifier', line: number): void {
    const entry = this.counts.get(kind);
    if (entry === undefined) this.counts.set(kind, { count: 1, line });
    else entry.count += 1;
  }

  flush(path: string, skipped: SkippedFile[]): void {
    const invocation = this.counts.get('invocation');
    if (invocation !== undefined) {
      skipped.push({
        path,
        reason:
          `${String(invocation.count)} macro invocation(s) longer than ${String(MAX_INVOCATION_CHARS)} ` +
          `characters, or past the walk budget, were not read (first at line ${String(invocation.line)}), so a throw site ` +
          'inside may be missing',
      });
    }
    const identifier = this.counts.get('identifier');
    if (identifier !== undefined) {
      skipped.push({
        path,
        reason:
          `${String(identifier.count)} error path(s) with an identifier longer than ${String(MAX_IDENT)} ` +
          `characters were not indexed (first at line ${String(identifier.line)})`,
      });
    }
  }
}

/** Longest quoted `text` of a multi-line invocation, in characters. */
const MAX_QUOTED_CHARS = 200;

/** `Err(` followed by one of these is a match pattern, not a raise. */
const PATTERN_AFTER = /^\s{0,16}(?:=>|\|)/;
/** `if let Err(`, `while let Err(`, `let Err(`. */
const LET_BEFORE = /\blet\s{0,16}$/;
/** `matches!(x, Err(`: an unclosed `matches!(` earlier in the same statement. */
const MATCHES_BEFORE = /\bmatches!\s{0,16}\([^;{}]{0,150}$/;

function sitesIn(
  file: PreparedFile,
  counter: WorkCounter,
  skipped: SkippedFile[],
  walking: { spent: number; budget: number },
): ThrowSite[] {
  // Matched on the literal-blanked code, so an opener inside a message is not an
  // opener. Quoted text is taken from the original, where the literals are intact.
  const { code, lines } = file;
  const found: ThrowSite[] = [];
  const declined = new Declined();
  // One site per variant per line. `return Err(error!(E::Boom))` matches both
  // `Err(` and `error!(`, and reporting one line twice would inflate a candidate
  // set with a duplicate rather than a real alternative.
  const seen = new Set<string>();
  counter.work += code.length;

  const record = (form: ThrowForm, at: number, read: PathRead, close: number = at): void => {
    if (read === null) return;
    const index = lineOf(file, at);
    if (read.kind === 'too-long') {
      declined.add('identifier', index + 1);
      return;
    }
    const key = `${read.variant}:${String(index)}`;
    if (seen.has(key)) return;
    seen.add(key);
    // The location is the opener's line. For an invocation wrapped over several
    // lines the opener alone ("require!(") says nothing, so the quoted text is
    // the invocation collapsed to one line, which carries the error argument.
    const spans = close > at && lineOf(file, close) !== index;
    const quoted = spans
      ? file.text.slice(at, close + 1).replace(/\s+/g, ' ')
      : lines[index]!.trim();
    found.push({
      file: file.path,
      line: index + 1,
      variant: read.variant,
      form,
      text:
        quoted.length > MAX_QUOTED_CHARS ? `${quoted.slice(0, MAX_QUOTED_CHARS - 3)}...` : quoted,
    });
  };

  type Invocation = { args: string[]; close: number };
  /** Walk one opener's invocation, or report that it could not be read whole. */
  const invocation = (match: RegExpExecArray): Invocation | null => {
    const open = match.index + match[0].length - 1;
    // Ordinary code walks a small fraction of the tree. A tree of openers that
    // never close would walk `MAX_INVOCATION_CHARS` from each, so the total is
    // budgeted, and what is left unwalked once it is spent is reported.
    if (walking.spent > walking.budget) {
      declined.add('invocation', lineOf(file, match.index) + 1);
      return null;
    }
    const before = counter.work;
    const walked = walk(code, open, counter);
    walking.spent += counter.work - before;
    if (walked.kind === 'cap') {
      declined.add('invocation', lineOf(file, match.index) + 1);
      return null;
    }
    return walked.kind === 'ok'
      ? { args: argumentsOf(code, open, walked), close: walked.close }
      : null;
  };

  for (const match of matches(REQUIRE, code)) {
    const call = invocation(match);
    if (call === null) continue;
    // `require!(cond, E::X)` has two arguments. The comparing forms take two
    // operands first, so with only those the error was omitted and Anchor raises
    // its own: there is no user variant here, and the operands must not be read as
    // one (`require_keys_eq!(a, crate::ID)` would index `ID`).
    const needed = match[1] === 'require' ? 2 : 3;
    if (call.args.length < needed) continue;
    record('require', match.index, errorArgument(call.args.at(-1)!), call.close);
  }

  for (const regex of [ERR_MACRO, ERR_RETURN]) {
    for (const match of matches(regex, code)) {
      const call = invocation(match);
      if (call?.args.length !== 1) continue;
      if (regex === ERR_RETURN && isPattern(code, match.index, call.close)) continue;
      record('err', match.index, errorArgument(call.args[0]!), call.close);
    }
  }

  for (const match of matches(OK_OR, code)) {
    const call = invocation(match);
    if (call?.args.length !== 1) continue;
    let arg = call.args[0]!;
    if (arg.startsWith('|')) {
      // `ok_or_else(|| E::X)`: the closure's parameters end at the second `|`.
      const close = arg.indexOf('|', 1);
      if (close < 0) continue;
      arg = arg.slice(close + 1).trim();
      // `|| { E::X }`: a block-bodied closure.
      if (arg.startsWith('{') && arg.endsWith('}')) arg = arg.slice(1, -1).trim();
    }
    record('ok-or', match.index, errorArgument(arg), call.close);
  }

  // `#[account(constraint = a == b @ MyError::X)]`. The `@` is Anchor's own syntax
  // for "raise this when the constraint fails", so inside an `#[account(...)]`
  // attribute it is an unambiguous throw position. Elsewhere `@` binds a pattern
  // (`v @ State::Active`) and says nothing about errors, so only attributes are
  // searched.
  for (const match of matches(ACCOUNT_ATTRIBUTE, code)) {
    const call = invocation(match);
    if (call === null) continue;
    for (
      let at = code.indexOf('@', match.index);
      at >= 0 && at < call.close;
      at = code.indexOf('@', at + 1)
    ) {
      record('constraint', at, readPath(code, at + 1));
    }
  }

  declined.flush(file.path, skipped);
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Whether the `Err(...)` ending at `close` is a pattern rather than an
 * expression: followed by `=>` or `|`, or the target of `if let` / `while let` /
 * `matches!`. Where this cannot be told cheaply the site is kept: a missed real
 * site is worse than an extra candidate. A guard-only arm such as
 * `Err(E::X) if cond =>` is therefore still indexed.
 */
function isPattern(code: string, start: number, close: number): boolean {
  if (PATTERN_AFTER.test(code.slice(close + 1, close + 20))) return true;
  const before = code.slice(Math.max(0, start - 200), start);
  return LET_BEFORE.test(before) || MATCHES_BEFORE.test(before);
}

function* matches(regex: RegExp, text: string): Generator<RegExpExecArray> {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) yield match;
}

const ERROR_CODE =
  /#\[error_code(?:\s{0,16}\(\s{0,16}offset\s{0,16}=\s{0,16}(\d{1,10})\s{0,16}\))?\s{0,16}\]/;

/**
 * Read `#[error_code] pub enum X { ... }` into the codes Anchor assigns.
 *
 * An explicit discriminant is honoured and moves the running counter, exactly as
 * Rust and therefore Anchor treat it. Without that, a program that pins one
 * variant's code would have every later variant misnumbered, and the proof built
 * on this ordering would reject a tree that is perfectly correct.
 */
function enumsIn(
  file: PreparedFile,
  lines: readonly string[],
  skipped: SkippedFile[],
  counter: WorkCounter,
): ErrorEnum[] {
  const found: ErrorEnum[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const attribute = ERROR_CODE.exec(lines[i]!);
    if (attribute === null) continue;

    const header = lines.slice(i + 1, i + 6).findIndex((line) => /\benum\s+[A-Za-z_]/.test(line));
    if (header < 0) continue;
    const start = i + 1 + header;
    const name = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[start]!)?.[1];
    if (name === undefined) continue;

    const codes = new Map<number, string>();
    let next = attribute[1] === undefined ? DEFAULT_OFFSET : Number(attribute[1]);

    // The body ends at the first line with a `}`. Reading stops early at the next
    // `#[error_code]` too, and at `MAX_ENUM_LINES`, so an enum with no closing
    // brace costs a bounded read instead of the rest of the file per attribute.
    let capped = false;
    let unreadable: string | null = null;
    for (let j = start; j < lines.length && j - start <= MAX_ENUM_LINES; j += 1) {
      counter.work += 1;
      if (j - start === MAX_ENUM_LINES) capped = true;
      const closing = j > start ? lines[j]!.indexOf('}') : -1;
      if (j > start && closing < 0 && ERROR_CODE.test(lines[j]!)) break;
      // The text before a `}` on the same line still holds a variant: the last one
      // is often written without a trailing comma.
      const variant = readVariant(closing < 0 ? lines[j]! : lines[j]!.slice(0, closing));
      if (variant !== null) {
        if (variant.value === 'unparsed') unreadable ??= variant.name;
        else {
          if (variant.value !== null) next = variant.value;
          codes.set(next, variant.name);
          next += 1;
        }
      }
      if (closing >= 0) {
        capped = false;
        break;
      }
    }

    // A discriminant that is not a plain integer (`1 << 3`, `0x10`) cannot be
    // followed, and every later code would be misnumbered. Refuse the enum, so the
    // proof is unchecked rather than wrong.
    if (unreadable !== null) {
      skipped.push({
        path: file.path,
        reason: `enum ${name} variant ${unreadable} has a discriminant that is not a plain integer`,
      });
      continue;
    }

    if (capped) {
      skipped.push({
        path: file.path,
        reason: `enum ${name} has no closing brace within ${String(MAX_ENUM_LINES)} lines`,
      });
      continue;
    }

    found.push({ name, file: file.path, codes });
  }

  return found;
}

/**
 * One enum body line as `Variant`, `Variant,` or `Variant = 123,`.
 *
 * Hand-scanned rather than matched: a pattern with several adjacent optional
 * whitespace runs backtracks quadratically on a long line that never reaches its
 * comma (a variant followed by thousands of spaces, or a blanked comment).
 * `value` is `null` when no discriminant is written and `'unparsed'` when one is
 * written that is not a plain integer.
 */
function readVariant(line: string): { name: string; value: number | null | 'unparsed' } | null {
  let at = 0;
  while (at < line.length && (line[at] === ' ' || line[at] === '\t' || line[at] === '\r')) at += 1;
  const first = line.charCodeAt(at);
  if (!(first >= 65 && first <= 90)) return null;

  const start = at;
  while (at < line.length && isIdentPart(line[at])) at += 1;
  const name = line.slice(start, at);
  while (at < line.length && /\s/.test(line[at]!)) at += 1;

  let value: number | null | 'unparsed' = null;
  if (line[at] === '=') {
    at += 1;
    while (at < line.length && /\s/.test(line[at]!)) at += 1;
    const digits = at;
    while (at < line.length && line[at]! >= '0' && line[at]! <= '9') at += 1;
    value = at > digits ? Number(line.slice(digits, at)) : 'unparsed';
    while (at < line.length && /\s/.test(line[at]!)) at += 1;
    if (value !== 'unparsed' && at < line.length && line[at] !== ',') value = 'unparsed';
  }

  if (value === 'unparsed') return { name, value };
  if (at < line.length && line[at] !== ',') return null;
  return { name, value };
}
