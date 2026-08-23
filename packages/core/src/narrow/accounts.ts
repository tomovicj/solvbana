import type { SourceFile, SourceTree } from '../rpc/source.ts';
import { attributeFor } from './constraints.ts';

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
}

/** Why no declaration was reported, when none was. */
export type DeclarationOutcome =
  | { kind: 'found'; declaration: AccountDeclaration; viaHandler: boolean }
  /** The handler's struct exists and does not declare this field. */
  | { kind: 'absent'; struct: string }
  /** Several structs declare a field of this name and none is the proven one. */
  | { kind: 'ambiguous'; structs: string[] }
  /** Nothing in the tree declares a field of this name. */
  | { kind: 'unknown' };

/** One `#[derive(Accounts)]` struct, with the lines it spans. */
interface AccountsStruct {
  file: SourceFile;
  name: string;
  from: number;
  to: number;
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
 * the link is written in the signature where it can simply be read.
 */
export function findDeclaration(
  tree: SourceTree,
  handler: string | null,
  field: string,
  errorName: string,
): DeclarationOutcome {
  const structs = accountsStructs(tree);
  const named = handler === null ? null : contextStruct(tree, handler);

  if (named !== null) {
    const target = structs.find((entry) => entry.name === named);
    if (target !== undefined) {
      const found = fieldIn(target, field, errorName);
      // The struct that ran is known and does not declare the field: the tree
      // and the deployed binary disagree about this instruction, which is the
      // same conclusion an IDL declaring too few accounts already produces.
      return found === null
        ? { kind: 'absent', struct: named }
        : { kind: 'found', declaration: found, viaHandler: true };
    }
  }

  // No handler, or its struct is not in the uploaded files. Fall back to the
  // field name alone, and only when one struct declares it — two prove nothing
  // about which one ran.
  const matches = structs.flatMap((entry) => {
    const found = fieldIn(entry, field, errorName);
    return found === null ? [] : [{ struct: entry.name, declaration: found }];
  });

  if (matches.length === 1) {
    return { kind: 'found', declaration: matches[0]!.declaration, viaHandler: false };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', structs: matches.map((entry) => entry.struct) };
  }
  return { kind: 'unknown' };
}

/**
 * The accounts struct a handler takes, read from its `Context<X>` parameter.
 *
 * `pub fn buy(ctx: Context<Buy>, ...)` states the link outright. Lifetimes and
 * whitespace vary — `Context<'_, '_, '_, 'info, Buy<'info>>` is as common as the
 * short form — so the *last* type argument is taken, which is where the accounts
 * struct sits in every arity Anchor generates.
 */
export function contextStruct(tree: SourceTree, handler: string): string | null {
  const snake = snakeCase(handler);

  for (const file of tree.files) {
    const lines = file.contents.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!new RegExp(`\\bfn\\s+${snake}\\s*(?:<[^>]*>)?\\s*\\(`).test(lines[i]!)) continue;

      // The signature may wrap, so read forward until the parameter list closes.
      const signature = lines.slice(i, i + 6).join(' ');
      const context = /Context\s*<([^>]*(?:<[^>]*>)?[^>]*)>/.exec(signature);
      if (context === null) continue;

      const last = context[1]!.split(',').at(-1)?.trim();
      const name = last === undefined ? null : /^([A-Za-z_][A-Za-z0-9_]*)/.exec(last)?.[1];
      if (name !== undefined && name !== null) return name;
    }
  }

  return null;
}

/** Every `#[derive(Accounts)]` struct in the tree, with its line span. */
function accountsStructs(tree: SourceTree): AccountsStruct[] {
  const found: AccountsStruct[] = [];

  for (const file of tree.files) {
    const lines = file.contents.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const name = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]!)?.[1];
      if (name === undefined) continue;
      // Only structs Anchor treats as accounts. The derive sits a line or two
      // above, with `#[instruction(...)]` sometimes between.
      const preceding = lines.slice(Math.max(0, i - 4), i).join(' ');
      if (!preceding.includes('#[derive(') || !preceding.includes('Accounts')) continue;

      found.push({ file, name, from: i, to: blockEnd(lines, i) });
    }
  }

  return found;
}

/**
 * Locate a field inside a struct and collect the attributes above it.
 *
 * The `#[account(...)]` block routinely spans several lines, so it is gathered
 * by walking upward from the field and balancing parentheses rather than by
 * reading the line above — a `seeds = [...]` split across three lines is the
 * normal case, not the exception.
 */
function fieldIn(
  entry: AccountsStruct,
  field: string,
  errorName: string,
): AccountDeclaration | null {
  const lines = entry.file.contents.split('\n');
  const declaration = new RegExp(`^\\s*(?:pub\\s+)?${field}\\s*:`);

  for (let i = entry.from; i <= entry.to && i < lines.length; i += 1) {
    if (!declaration.test(lines[i]!)) continue;

    const attributes = attributesAbove(lines, i);
    const keyword = attributeFor(errorName);

    return {
      file: entry.file.path,
      line: i + 1,
      field,
      struct: entry.name,
      attributes,
      constraint: keyword === null ? null : (attributes.find((a) => matches(a, keyword)) ?? null),
      text: lines[i]!.trim(),
    };
  }

  return null;
}

/** Whether an attribute is the one a keyword names. `seeds = [..]` for `seeds`. */
function matches(attribute: string, keyword: string): boolean {
  const head = attribute.split('=')[0]!.trim();
  return head === keyword || attribute.trim() === keyword;
}

/**
 * The `#[account(...)]` attributes immediately above a field.
 *
 * Walks up while the lines belong to one attribute block, balancing parentheses
 * so a multi-line block is taken whole. Returns an empty list for a field with
 * no attributes at all, which is the ordinary case for `AccountNotInitialized`.
 */
function attributesAbove(lines: readonly string[], field: number): string[] {
  let end = field - 1;
  while (end >= 0 && lines[end]!.trim() === '') end -= 1;
  if (end < 0 || !lines[end]!.includes(')]')) return [];

  // Balance back to the `#[account(` that opened this block.
  let depth = 0;
  let start = end;
  for (; start >= 0; start -= 1) {
    for (const char of [...lines[start]!].reverse()) {
      if (char === ')') depth += 1;
      else if (char === '(') depth -= 1;
    }
    if (depth <= 0) break;
  }
  if (start < 0) return [];

  const block = lines.slice(start, end + 1).join(' ');
  const open = block.indexOf('(');
  if (!block.slice(0, open).includes('account') || open < 0) return [];

  return splitTopLevel(block.slice(open + 1, block.lastIndexOf(')')));
}

/**
 * Split an attribute list on commas that are not inside brackets.
 *
 * `seeds = [b"vault", authority.key().as_ref()]` is one attribute, not two, and
 * splitting it naively would report a fragment as the failing constraint.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quoted = false;

  for (const char of inner) {
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === '[' || char === '(') depth += 1;
      else if (char === ']' || char === ')') depth -= 1;
      else if (char === ',' && depth === 0) {
        if (current.trim() !== '') parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }

  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** The line closing the block that opens at or after `start`. */
function blockEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  let opened = false;

  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i]!) {
      if (char === '{') {
        depth += 1;
        opened = true;
      } else if (char === '}') depth -= 1;
    }
    if (opened && depth <= 0) return i;
  }

  return lines.length - 1;
}

/** `BuyExactQuoteIn` to `buy_exact_quote_in`, as `resolve/idl.ts` does. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
