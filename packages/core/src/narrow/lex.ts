import type { SourceFile, SourceTree } from '../rpc/source.ts';

/**
 * The largest single file read, in UTF-16 code units (`String.length`).
 *
 * Hand-written Rust source files run to tens of kilobytes and generated ones to a
 * few hundred; a megabyte is well past anything a person wrote and keeps one
 * file's scan from stalling the single-threaded server.
 */
export const MAX_FILE_CHARS = 1_000_000;

/**
 * The most source read across one tree, in the same unit. Files past the budget
 * are skipped whole, in upload order, rather than truncated mid-file.
 */
export const MAX_TOTAL_CHARS = 8_000_000;

/** A file (or part of one) a scanner declined to read, and why. */
export interface SkippedFile {
  path: string;
  reason: string;
}

/** Shared deterministic stand-in for running time; see `SourceIndex.work`. */
export interface WorkCounter {
  work: number;
}

function isIdentChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Where the string or character literal starting at `at` ends (exclusive).
 *
 * Returns `at` when no literal starts there — including a lifetime such as `'a`,
 * which opens with the same quote as a character — and `-1` when one starts and
 * is not closed before `limit`. Handles `"..."`, `b"..."`, raw strings with any
 * number of `#`, and `'x'` / `'\n'` / `b'x'`. One forward pass over the literal.
 */
export function literalEnd(text: string, at: number, limit: number = text.length): number {
  const first = text[at];
  if (first === '"') return stringEnd(text, at + 1, limit);
  if (first === "'") return charEnd(text, at);

  if (first !== 'r' && first !== 'b') return at;
  if (isIdentChar(text[at - 1])) return at;

  let p = at;
  if (first === 'b') {
    const next = text[at + 1];
    if (next === '"') return stringEnd(text, at + 2, limit);
    if (next === "'") {
      const end = charEnd(text, at + 1);
      return end === at + 1 ? at : end;
    }
    if (next !== 'r') return at;
    p = at + 1;
  }

  // Raw string: r#*" ... "#*
  let hashes = 0;
  let q = p + 1;
  while (text[q] === '#') {
    hashes += 1;
    q += 1;
  }
  if (text[q] !== '"') return at;
  for (let j = q + 1; j < limit; j += 1) {
    if (text[j] !== '"') continue;
    let k = 0;
    while (k < hashes && text[j + 1 + k] === '#') k += 1;
    if (k === hashes) return j + 1 + hashes;
  }
  return -1;
}

function stringEnd(text: string, from: number, limit: number): number {
  for (let j = from; j < limit; j += 1) {
    const char = text[j];
    if (char === '\\') j += 1;
    else if (char === '"') return j + 1;
  }
  return -1;
}

/** End of a character literal at `at`, or `at` when the quote is a lifetime's. */
function charEnd(text: string, at: number): number {
  if (text[at + 1] === '\\') {
    // '\n', '\'', '\x41', '\u{1F600}': the closing quote is within a few chars.
    for (let j = at + 3; j < at + 14 && j < text.length; j += 1) {
      if (text[j] === "'") return j + 1;
    }
    return at;
  }
  if (text[at + 1] === "'" || text[at + 1] === undefined) return at;
  if (text[at + 2] === "'") return at + 3;
  // A character outside the BMP is two UTF-16 units.
  const unit = text.charCodeAt(at + 1);
  if (unit >= 0xd800 && unit <= 0xdbff && text[at + 3] === "'") return at + 4;
  return at;
}

/**
 * Blank out comments, preserving line numbering.
 *
 * Replaced with spaces rather than removed so every reported line number still
 * refers to the same line of the file the developer uploaded. String and character
 * literals are stepped over, so a `//` inside a URL in a message does not cut the
 * rest of the line (and with it a closing parenthesis).
 *
 * One forward pass. A `/*` with no closer is left as code and ends block-comment
 * handling, since no later block-comment closer exists either; a string with no closer likewise
 * ends literal handling. Neither is retried, which is what keeps a file of
 * repeated unterminated openers linear.
 */
export function stripComments(contents: string, counter: WorkCounter): string {
  const pieces: string[] = [];
  let last = 0;
  let at = 0;
  let blocks = true;
  let literals = true;
  const length = contents.length;
  counter.work += length;

  while (at < length) {
    const char = contents[at];
    if (char === '/' && contents[at + 1] === '/') {
      const newline = contents.indexOf('\n', at);
      const end = newline < 0 ? length : newline;
      pieces.push(contents.slice(last, at), ' '.repeat(end - at));
      last = end;
      at = end;
    } else if (char === '/' && contents[at + 1] === '*' && blocks) {
      const close = contents.indexOf('*/', at + 2);
      if (close < 0) {
        blocks = false;
        at += 2;
        continue;
      }
      pieces.push(contents.slice(last, at), contents.slice(at, close + 2).replace(/[^\n]/g, ' '));
      last = close + 2;
      at = close + 2;
    } else if (literals && (char === '"' || char === "'" || char === 'r' || char === 'b')) {
      const end = literalEnd(contents, at);
      if (end < 0) {
        literals = false;
        at += 1;
      } else at = end > at ? end : at + 1;
    } else {
      at += 1;
    }
  }
  pieces.push(contents.slice(last));
  return pieces.join('');
}

/** A source file, comment-stripped once and indexed for position lookups. */
export interface PreparedFile {
  path: string;
  /** Comments blanked; same length and line structure as the upload. */
  text: string;
  lines: string[];
  /**
   * `text` with the inside of every string and character literal blanked (quotes
   * kept, newlines kept), so a scanner matching on it cannot be fooled by code-
   * shaped text in a message, and braces or commas in a message cannot unbalance
   * it. Same offsets and line structure as `text`.
   */
  code: string;
  codeLines: string[];
  /** Offset of the first character of each line. */
  lineStarts: number[];
  /**
   * Offset of each `{` to the offset of its matching `}`, from one pass over the
   * file. Computing every block's end here is what keeps looking one up constant
   * — scanning forward from each opener instead is quadratic on a file of
   * unclosed ones.
   */
  closeOf: Map<number, number>;
}

/** 0-based line of an offset. */
export function lineOf(file: PreparedFile, offset: number): number {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (file.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Blank the body of every string and character literal; see `PreparedFile.code`. */
function blankLiterals(text: string, counter: WorkCounter): string {
  const pieces: string[] = [];
  let last = 0;
  let at = 0;
  let literals = true;
  counter.work += text.length;

  while (at < text.length) {
    const char = text[at];
    if (literals && (char === '"' || char === "'" || char === 'r' || char === 'b')) {
      const end = literalEnd(text, at);
      if (end < 0) {
        literals = false;
        at += 1;
      } else if (end > at) {
        pieces.push(text.slice(last, at), text.slice(at, end).replace(/[^\n]/g, ' '));
        last = end;
        at = end;
      } else at += 1;
    } else at += 1;
  }
  pieces.push(text.slice(last));
  return pieces.join('');
}

/** Match braces over literal-blanked code in one pass. */
function braceMatches(code: string, counter: WorkCounter): Map<number, number> {
  const closeOf = new Map<number, number>();
  const open: number[] = [];
  counter.work += code.length;

  for (let at = 0; at < code.length; at += 1) {
    const char = code[at];
    if (char === '{') open.push(at);
    else if (char === '}') {
      const from = open.pop();
      if (from !== undefined) closeOf.set(from, at);
    }
  }
  return closeOf;
}

export function prepareFile(file: SourceFile, counter: WorkCounter): PreparedFile {
  const text = stripComments(file.contents, counter);
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const code = blankLiterals(text, counter);
  return {
    path: file.path,
    text,
    lines,
    code,
    codeLines: code.split('\n'),
    lineStarts,
    closeOf: braceMatches(code, counter),
  };
}

/** A tree's readable files, prepared, and the ones refused for size. */
export interface PreparedTree {
  files: PreparedFile[];
  skipped: SkippedFile[];
}

/**
 * Apply the size caps and prepare what remains. Every entry point that reads
 * source goes through here, so none of them can read a file another declined.
 */
export function prepareTree(tree: SourceTree, counter: WorkCounter): PreparedTree {
  const files: PreparedFile[] = [];
  const skipped: SkippedFile[] = [];
  let read = 0;

  for (const file of tree.files) {
    if (file.contents.length > MAX_FILE_CHARS) {
      skipped.push({
        path: file.path,
        reason: `file is ${String(file.contents.length)} characters, over the ${String(MAX_FILE_CHARS)} limit`,
      });
      continue;
    }
    if (read + file.contents.length > MAX_TOTAL_CHARS) {
      skipped.push({
        path: file.path,
        reason: `the tree's total size would pass the ${String(MAX_TOTAL_CHARS)} character limit`,
      });
      continue;
    }
    read += file.contents.length;
    files.push(prepareFile(file, counter));
  }

  return { files, skipped };
}

/**
 * The offset of the `{` opening the body that follows `from`, or why none.
 *
 * Looks no further than `window` characters and stops at a `;`, which ends a
 * declaration with no body (`fn f();`, `struct S;`). Callers report `capped`.
 */
export function bodyOpen(
  text: string,
  from: number,
  window: number,
  counter: WorkCounter,
): { kind: 'open'; at: number } | { kind: 'none' } | { kind: 'capped' } {
  const limit = Math.min(text.length, from + window);
  for (let at = from; at < limit; at += 1) {
    const char = text[at];
    if (char === '{') {
      counter.work += at - from;
      return { kind: 'open', at };
    }
    if (char === ';') {
      counter.work += at - from;
      return { kind: 'none' };
    }
  }
  counter.work += limit - from;
  return limit < text.length ? { kind: 'capped' } : { kind: 'none' };
}

/**
 * The offset of the bracket closing the one at `open`, or `-1`.
 *
 * Counts `()`, `[]` and `{}` together, steps over string and character literals,
 * and reads at most `maxChars` characters. `-1` covers unbalanced text and a
 * block longer than the cap alike; the caller says it was not read.
 */
export function matchClose(text: string, open: number, maxChars: number): number {
  const limit = Math.min(text.length, open + maxChars);
  const stack: string[] = [];
  for (let at = open; at < limit; at += 1) {
    const char = text[at]!;
    if (char === '(') stack.push(')');
    else if (char === '[') stack.push(']');
    else if (char === '{') stack.push('}');
    else if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return at;
    } else if (char === '"' || char === "'" || char === 'r' || char === 'b') {
      const end = literalEnd(text, at, limit);
      if (end < 0) return -1;
      if (end > at) at = end - 1;
    }
  }
  return -1;
}
