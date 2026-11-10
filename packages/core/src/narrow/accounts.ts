import type { SourceTree } from '../rpc/source.ts';
import { attributeFor } from './constraints.ts';
import {
  lineOf,
  literalEnd,
  matchClose,
  prepareTree,
  type PreparedFile,
  type PreparedTree,
} from './lex.ts';
import { escapeRegExp, isRustIdentifier, notAnIdentifier } from './names.ts';

/** The field declaration an Anchor constraint error points at. */
export interface AccountDeclaration {
  file: string;
  /** The line the field itself is declared on, 1-based. */
  line: number;
  field: string;
  /** The `#[derive(Accounts)]` struct it belongs to. */
  struct: string;
  /** Every attribute in the field's `#[account(...)]`, in source order. */
  attributes: string[];
  /** The attribute the failed error points at, when one keyword names it. */
  constraint: string | null;
  /** The field's own declaration line, trimmed. */
  text: string;
  /**
   * True when the `#[account(...)]` block above the field could not be read in
   * full (unbalanced, or longer than `MAX_ATTRIBUTE_LINES`). `attributes` and
   * `constraint` are then empty because they are unread, not because the field
   * has none.
   */
  attributesTruncated?: boolean;
}

/** Why no declaration was reported, when none was. */
export type DeclarationOutcome = (
  | { kind: 'found'; declaration: AccountDeclaration; viaHandler: boolean }
  /** The handler's struct was read in full and does not declare this field. */
  | { kind: 'absent'; struct: string }
  /** Several structs declare a field of this name and none is the proven one. */
  | { kind: 'ambiguous'; structs: string[] }
  /** Nothing that was read declares a field of this name. */
  | { kind: 'unknown' }
  /**
   * A struct that could decide the question was too large, or had no closing
   * brace, so whether it declares the field is not established. Distinct from
   * `absent`: that is a statement about the tree, this is about the reader.
   */
  | { kind: 'truncated'; struct: string }
  /** The handler or field name is not a Rust identifier; nothing was searched. */
  | { kind: 'refused'; reason: string }
) & {
  /**
   * Parts of the tree not read (files over the size caps, structs cut short), for
   * the caller to state beside whatever conclusion it draws.
   */
  unread?: string[];
};

/**
 * Lines an accounts struct may span before it is given up on. A struct is read to
 * its real closing brace, which a legitimate 60-field struct with doc comments
 * and wrapped attributes needs several hundred lines for; this is a safety limit
 * far past that, and reaching it yields `truncated`, never `absent`.
 */
export const MAX_STRUCT_LINES = 20_000;

/**
 * Lines one `#[...]` attribute may span before it is called unread. A field's
 * attribute that long is reported as such, never as the field having none.
 */
export const MAX_ATTRIBUTE_LINES = 100;

/** Characters of a handler's parameter list read for its `Context<...>`. */
export const MAX_SIGNATURE_CHARS = 2_000;

/** Characters read inside one `Context<...>` before it is called unbalanced. */
export const MAX_CONTEXT_ARGS_CHARS = 256;

/** Characters between `struct Name` and its opening brace before it is not read. */
const MAX_STRUCT_HEADER_CHARS = 500;

/** Lines above a struct searched for its `#[derive(Accounts)]`. */
const MAX_PREAMBLE_LINES = 100;

/** `fn <handler>(` declarations examined before the lookup gives up. */
const MAX_HANDLER_DECLARATIONS = 500;

/** One `#[derive(Accounts)]` struct. */
interface AccountsStruct {
  file: PreparedFile;
  name: string;
  /** 0-based line of the `struct` keyword. */
  from: number;
  /** Offsets of the body's braces; `close` is -1 when `truncated`. */
  open: number;
  close: number;
  /** The struct has no closing brace in reach, or is past `MAX_STRUCT_LINES`. */
  truncated: boolean;
}

/**
 * Find the declaration Anchor blamed.
 *
 * Anchor names the offending field — `caused by account: coin_creator_vault_authority`
 * — which is a far stronger lexical key than an error variant, and the reason
 * this path exists at all: nothing in the source *raises* `ConstraintSeeds`, so
 * the throw-site index can never find it.
 *
 * The struct is read out of the handler's `Context<X>` type parameter rather
 * than assumed from its name. Anchor conventionally calls the struct after the
 * handler, but a convention is exactly what this project declines to decode, and
 * the link is written in the signature where it can simply be read. **Once that
 * link has been read, no other struct is ever offered**: if the named struct is
 * missing the answer is a refusal saying so, not the one struct that happens to
 * declare a field of that name.
 *
 * `prepared` lets a caller that has already read the tree share the pass.
 */
export function findDeclaration(
  tree: SourceTree,
  handler: string | null,
  field: string,
  errorName: string,
  prepared: PreparedTree = prepareTree(tree, { work: 0 }),
): DeclarationOutcome {
  if (!isRustIdentifier(field)) {
    return { kind: 'refused', reason: notAnIdentifier('account field', field) };
  }
  if (handler !== null && !isRustIdentifier(handler)) {
    return { kind: 'refused', reason: notAnIdentifier('handler', handler) };
  }
  if (!isRustIdentifier(errorName)) {
    return { kind: 'refused', reason: notAnIdentifier('error', errorName) };
  }

  const structs = accountsStructs(prepared);
  const context = handler === null ? ({ kind: 'none' } as const) : contextOf(prepared, handler);
  const unread = [
    ...prepared.skipped.map((entry) => `${entry.path} (${entry.reason})`),
    ...structs
      .filter((entry) => entry.truncated)
      .map((entry) => `struct ${entry.name} in ${entry.file.path} (no closing brace within reach)`),
  ];
  const withUnread = <T extends DeclarationOutcome>(outcome: T): T =>
    unread.length === 0 ? outcome : { ...outcome, unread };
  const refuse = (reason: string): DeclarationOutcome => withUnread({ kind: 'refused', reason });

  if (context.kind === 'capped') {
    return refuse(
      `More than ${String(MAX_HANDLER_DECLARATIONS)} functions named like ${handler ?? ''} were ` +
        "found, so the handler's Context type was not read and no accounts struct is chosen.",
    );
  }
  if (context.kind === 'several') {
    return refuse(
      `Functions named like ${handler ?? ''} take different Context types ` +
        `(${context.names.join(', ')}), so which accounts struct ran is not determined and no ` +
        'declaration is reported.',
    );
  }

  if (context.kind === 'one') {
    const named = context.name;
    const targets = structs.filter((entry) => entry.name === named);
    if (targets.length === 0) {
      return refuse(
        `The handler's signature takes Context<${named}>, but no #[derive(Accounts)] struct named ` +
          `${named} was found in the uploaded source. Another struct declaring a ${field} field ` +
          'is not substituted for it, so no declaration is reported.',
      );
    }
    if (targets.length > 1) {
      return refuse(
        `The handler's signature takes Context<${named}>, and ${String(targets.length)} ` +
          `#[derive(Accounts)] structs are named ${named} (${targets.map((t) => t.file.path).join(', ')}), ` +
          'so which one ran is not determined.',
      );
    }
    const target = targets[0]!;
    if (target.truncated) return withUnread({ kind: 'truncated', struct: named });
    const found = fieldIn(target, field, errorName);
    if (found === 'unreadable') return withUnread({ kind: 'truncated', struct: named });
    // The struct that ran is known, was read in full, and does not declare the
    // field: the tree and the deployed binary disagree about this instruction,
    // the same conclusion an IDL declaring too few accounts already produces.
    return withUnread(
      found === null
        ? { kind: 'absent', struct: named }
        : { kind: 'found', declaration: found, viaHandler: true },
    );
  }

  // No handler, or no `Context<...>` could be read from its signature. Fall back
  // to the field name alone, and only when one struct declares it — two prove
  // nothing about which one ran.
  const unreadStructs: string[] = [];
  const found = structs.flatMap((entry) => {
    if (entry.truncated) return [];
    const hit = fieldIn(entry, field, errorName);
    if (hit === 'unreadable') {
      unreadStructs.push(entry.name);
      return [];
    }
    return hit === null ? [] : [{ struct: entry.name, declaration: hit }];
  });

  for (const name of unreadStructs)
    unread.push(`struct ${name} (an attribute could not be read in full)`);
  if (found.length === 1) {
    return withUnread({ kind: 'found', declaration: found[0]!.declaration, viaHandler: false });
  }
  if (found.length > 1) {
    return withUnread({ kind: 'ambiguous', structs: found.map((entry) => entry.struct) });
  }
  const cut = structs.find((entry) => entry.truncated)?.name ?? unreadStructs[0];
  if (cut !== undefined) return withUnread({ kind: 'truncated', struct: cut });
  return withUnread({ kind: 'unknown' });
}

/**
 * The accounts struct a handler takes, read from its `Context<X>` parameter.
 *
 * `pub fn buy(ctx: Context<Buy>, ...)` states the link outright. Lifetimes,
 * whitespace and paths vary — `Context<'_, '_, '_, 'info, Buy<'info>>` and
 * `Context<crate::instructions::Buy>` are as common as the short form — so the
 * *last* type argument is taken, and of its path the last segment. Null when no
 * single type could be read.
 */
export function contextStruct(tree: SourceTree, handler: string): string | null {
  if (!isRustIdentifier(handler)) return null;
  const read = contextOf(prepareTree(tree, { work: 0 }), handler);
  return read.kind === 'one' ? read.name : null;
}

type ContextRead =
  | { kind: 'none' }
  | { kind: 'one'; name: string }
  /** Declarations of the handler's name take different Context types. */
  | { kind: 'several'; names: string[] }
  | { kind: 'capped' };

function contextOf(prepared: PreparedTree, handler: string): ContextRead {
  const declaration = new RegExp(
    `\\bfn\\s{1,16}${escapeRegExp(snakeCase(handler))}(?![A-Za-z0-9_])`,
    'g',
  );
  const names = new Set<string>();
  let seen = 0;

  for (const file of prepared.files) {
    const code = file.code;
    declaration.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(code)) !== null) {
      seen += 1;
      if (seen > MAX_HANDLER_DECLARATIONS) return { kind: 'capped' };

      let at = skipSpaces(code, match.index + match[0].length);
      if (code[at] === '<') {
        const generics = angleClose(code, at);
        if (generics < 0) continue;
        at = skipSpaces(code, generics + 1);
      }
      if (code[at] !== '(') continue;
      // The parameter list ends at its own closing parenthesis, so a `Context<..>`
      // in the next function is never read as this one's.
      const close = matchClose(code, at, MAX_SIGNATURE_CHARS);
      if (close < 0) continue;

      const args = contextArguments(code.slice(at + 1, close));
      const name = args === null ? null : lastTypeName(args);
      if (name !== null) names.add(name);
    }
  }

  if (names.size === 0) return { kind: 'none' };
  if (names.size > 1) return { kind: 'several', names: [...names] };
  return { kind: 'one', name: [...names][0]! };
}

function skipSpaces(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  return at;
}

/** The `>` closing the `<` at `open`, within 200 characters, or -1. */
function angleClose(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length && at < open + 200; at += 1) {
    if (text[at] === '<') depth += 1;
    else if (text[at] === '>' && text[at - 1] !== '-') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * The text between the angle brackets of the first balanced `Context<...>`.
 *
 * Counted by depth in one forward pass per candidate, capped at
 * `MAX_CONTEXT_ARGS_CHARS`. A regex with two adjacent `[^>]*` around an optional
 * group can split an unclosed argument list exponentially many ways.
 */
function contextArguments(signature: string): string | null {
  const opener = /\bContext\s{0,16}</g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(signature)) !== null) {
    const from = match.index + match[0].length;
    const limit = Math.min(signature.length, from + MAX_CONTEXT_ARGS_CHARS);
    let depth = 1;
    for (let at = from; at < limit; at += 1) {
      const char = signature[at];
      if (char === '<') depth += 1;
      else if (char === '>') {
        depth -= 1;
        if (depth === 0) return signature.slice(from, at);
      }
    }
  }

  return null;
}

/** The last segment of the last top-level type argument, if it is an identifier. */
function lastTypeName(args: string): string | null {
  let depth = 0;
  let start = 0;
  for (let at = 0; at < args.length; at += 1) {
    const char = args[at];
    if (char === '<' || char === '(' || char === '[') depth += 1;
    else if (char === '>' || char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) start = at + 1;
  }
  let last = args.slice(start).trim();
  while (last.startsWith('&')) last = last.slice(1).trim();
  const generic = last.indexOf('<');
  if (generic >= 0) last = last.slice(0, generic);
  const segment = last.split('::').at(-1)?.trim();
  return segment !== undefined && isRustIdentifier(segment) ? segment : null;
}

/**
 * Every `#[derive(Accounts)]` struct in the tree.
 *
 * The derive is found by walking up from the `struct` line over attributes, doc
 * comments (blank once stripped) and blank lines until the previous item ends,
 * rather than within a fixed window: `#[instruction(..)]` and a few doc lines are
 * enough to push it out of any short one. Rust structs do not nest, so a struct
 * whose body opens inside one already recorded is skipped — that is also what
 * keeps a file of nested braces from being scanned once per overlap.
 */
function accountsStructs(prepared: PreparedTree): AccountsStruct[] {
  const found: AccountsStruct[] = [];

  for (const file of prepared.files) {
    const lines = file.codeLines;
    let coveredUntil = -1;

    for (let i = 0; i < lines.length; i += 1) {
      const name = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]!)?.[1];
      if (name === undefined || !derivesAccounts(lines, i)) continue;

      // The body is the brace pair that follows the name, found in the file's
      // precomputed matching rather than by scanning forward per struct.
      const from = file.lineStarts[i]! + lines[i]!.indexOf('struct');
      const limit = Math.min(file.code.length, from + MAX_STRUCT_HEADER_CHARS);
      let open = -1;
      for (let at = from; at < limit; at += 1) {
        const char = file.code[at];
        if (char === ';') break;
        if (char === '{') {
          open = at;
          break;
        }
      }
      if (open < 0 || open < coveredUntil) continue;

      const close = file.closeOf.get(open);
      const truncated = close === undefined || lineOf(file, close) - i > MAX_STRUCT_LINES;
      if (close !== undefined && !truncated) coveredUntil = close;
      found.push({
        file,
        name,
        from: i,
        open,
        close: truncated ? -1 : close,
        truncated,
      });
    }
  }

  return found;
}

/** Whether the item whose `struct` line is `at` carries `#[derive(.. Accounts ..)]`. */
function derivesAccounts(lines: readonly string[], at: number): boolean {
  const collected: string[] = [];
  for (let i = at - 1; i >= 0 && at - i <= MAX_PREAMBLE_LINES; i -= 1) {
    const trimmed = lines[i]!.trim();
    // The previous item ended here; its attributes are not this struct's.
    if (trimmed.endsWith(';') || trimmed.endsWith('}') || trimmed.endsWith('{')) break;
    collected.push(trimmed);
  }
  // Only the nearest part of a very long preamble is searched.
  const preamble = collected.reverse().join(' ').slice(-4_000);
  return /#\s{0,16}\[\s{0,16}derive\s{0,16}\([^\]]{0,2000}\bAccounts\b/.test(preamble);
}

/**
 * Locate a field inside a struct and collect the attributes above it.
 *
 * Read forward through the struct body in one pass: attributes are taken whole,
 * to their matching bracket with string literals stepped over, so a `(` inside a
 * `seeds = [b"v(", ..]` literal cannot unbalance one and a `#[doc = ".."]`
 * between `#[account(..)]` and the field cannot hide it. A field whose attribute
 * could not be read in full is returned with `attributesTruncated`.
 */
function fieldIn(
  entry: AccountsStruct,
  field: string,
  errorName: string,
): AccountDeclaration | null | 'unreadable' {
  const { file } = entry;
  const text = file.text;
  let attributes: string[] = [];
  // Set when an attribute was found but is longer than `MAX_ATTRIBUTE_LINES`: it
  // was skipped unread, so the field after it is reported as having unread
  // attributes rather than none.
  let unreadable = false;
  let at = entry.open + 1;

  while (at < entry.close) {
    const char = text[at]!;
    if (/\s/.test(char) || char === ',') {
      at += 1;
      continue;
    }

    if (char === '#') {
      let open = skipSpaces(text, at + 1);
      if (text[open] === '!') open = skipSpaces(text, open + 1);
      const close = text[open] === '[' ? matchClose(text, open, MAX_ATTRIBUTE_CHARS) : -1;
      // An attribute whose end cannot be found leaves no boundary to resume from,
      // so the rest of the struct cannot be tokenised: say so, do not guess.
      if (close < 0 || close > entry.close) return 'unreadable';
      if (lineOf(file, close) - lineOf(file, open) > MAX_ATTRIBUTE_LINES) {
        unreadable = true;
        at = close + 1;
        continue;
      }
      attributes.push(...accountAttributes(text.slice(open + 1, close)));
      at = close + 1;
      continue;
    }

    // A field: visibility, name, `:`, then a type up to the next top-level comma.
    const line = lineOf(file, at);
    if (fieldName(text, at) === field) {
      const keyword = attributeFor(errorName);
      return {
        file: file.path,
        line: line + 1,
        field,
        struct: entry.name,
        attributes: unreadable ? [] : attributes,
        constraint:
          keyword === null || unreadable
            ? null
            : (attributes.find((a) => matches(a, keyword)) ?? null),
        text: file.lines[line]!.trim(),
        ...(unreadable ? { attributesTruncated: true } : {}),
      };
    }
    attributes = [];
    at = fieldEnd(text, at, entry.close);
  }

  return null;
}

/** The field name declared at `at` (`pub(crate) name:`), or null. */
function fieldName(text: string, at: number): string | null {
  let p = at;
  if (text.startsWith('pub', p) && !/[A-Za-z0-9_]/.test(text[p + 3] ?? ' ')) {
    p = skipSpaces(text, p + 3);
    if (text[p] === '(') {
      const close = matchClose(text, p, 200);
      if (close < 0) return null;
      p = skipSpaces(text, close + 1);
    }
  }
  const start = p;
  while (p < text.length && /[A-Za-z0-9_]/.test(text[p]!)) p += 1;
  if (p === start) return null;
  const name = text.slice(start, p);
  p = skipSpaces(text, p);
  return text[p] === ':' && text[p + 1] !== ':' ? name : null;
}

/** Longest single attribute read, in characters. */
const MAX_ATTRIBUTE_CHARS = 20_000;

/** The offset after the field starting at `at`: past its type, to the next comma. */
function fieldEnd(text: string, at: number, limit: number): number {
  let depth = 0;
  for (let i = at; i < limit; i += 1) {
    const char = text[i]!;
    if (char === '(' || char === '[' || char === '{' || char === '<') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === '>' && text[i - 1] !== '-') depth -= 1;
    else if (char === ',' && depth <= 0) return i + 1;
    else if (char === '"' || char === "'" || char === 'r' || char === 'b') {
      const end = literalEnd(text, i);
      if (end < 0) return limit;
      if (end > i) i = end - 1;
    }
  }
  return limit;
}

/** The `account(...)` arguments of the attribute `[...]` body, or none. */
function accountAttributes(body: string): string[] {
  const head = /^\s{0,16}account\s{0,16}\(/.exec(body);
  if (head === null) return [];
  const open = head[0].length - 1;
  const close = matchClose(body, open, body.length);
  if (close < 0) return [];
  return splitTopLevel(body.slice(open + 1, close));
}

/** Whether an attribute is the one a keyword names. `seeds = [..]` for `seeds`. */
function matches(attribute: string, keyword: string): boolean {
  const head = attribute.split('=')[0]!.trim();
  return head === keyword || attribute.trim() === keyword;
}

/**
 * Split an attribute list on commas that are not inside brackets or literals.
 *
 * `seeds = [b"vault", authority.key().as_ref()]` is one attribute, not two, and
 * splitting it naively would report a fragment as the failing constraint.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number): void => {
    const part = inner
      .slice(start, end)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (part !== '') parts.push(part);
  };

  for (let at = 0; at < inner.length; at += 1) {
    const char = inner[at]!;
    if (char === '[' || char === '(' || char === '{') depth += 1;
    else if (char === ']' || char === ')' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      push(at);
      start = at + 1;
    } else if (char === '"' || char === "'" || char === 'r' || char === 'b') {
      const end = literalEnd(inner, at);
      if (end > at) at = end - 1;
    }
  }
  push(inner.length);
  return parts;
}

/** `BuyExactQuoteIn` to `buy_exact_quote_in`, as `resolve/idl.ts` does. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
