import type { Finding } from '../analyze/types.ts';
import type { CandidateSite } from '../diagnosis.ts';
import type { SourceTree } from '../rpc/source.ts';
import { findDeclaration, type AccountDeclaration } from './accounts.ts';
import { isDeclarationError } from './constraints.ts';
import {
  bodyOpen,
  lineOf,
  prepareTree,
  type PreparedFile,
  type PreparedTree,
  type WorkCounter,
} from './lex.ts';
import { escapeRegExp, isRustIdentifier, notAnIdentifier } from './names.ts';
import { indexPrepared, type SourceIndex, type ThrowSite } from './sites.ts';

/**
 * What narrowing concluded, including when it concluded nothing.
 *
 * A refusal carries its reason for the same purpose everywhere else in this
 * project does: an empty candidate list that does not say why reads as "no
 * source was uploaded", which is a different fact from "the source you uploaded
 * never raises this error".
 */
export interface Narrowing {
  candidates: CandidateSite[];
  reasons: string[];
  /** The declaration located, when the failure blamed an account and one was found. */
  declaration: AccountDeclaration | null;
  /**
   * What the numbering proof concluded, or `null` when none was attempted.
   *
   * Exposed so the caller can weigh the candidates against chain state: whether a
   * tree was tied to the failing revision is a different question from whether
   * it contains the line, and only the caller knows the deployment history.
   */
  proof: SourceProof | null;
}

/**
 * The uploaded tree has to prove it describes the program that ran.
 *
 * Same demand made of an uploaded IDL, which must declare the discriminator the
 * failing instruction used, and for the same reason: anyone can write a file.
 * The proof here is Anchor's error numbering. `#[error_code]` assigns variants
 * sequential codes from 6000, so the enum's declaration order maps the
 * transaction's `Custom(n)` to a name — and if that name matches the one the
 * logs or the IDL established independently, two unrelated sources agree.
 */
export type SourceProof =
  /** The tree's own numbering reproduces the name established elsewhere. */
  | { kind: 'confirmed'; enumName: string }
  /** The tree numbers this code as a different error: a different version. */
  | { kind: 'contradicted'; enumName: string; declares: string }
  /** No `#[error_code]` enum, or no code to check it against. */
  | { kind: 'unchecked'; reason: string };

/**
 * Check the uploaded tree's error numbering against what the failure named.
 *
 * `contradicted` is the outcome worth having. A tree that numbers `Custom(6001)`
 * as something other than the error that fired is a different version of the
 * program, and every line number derived from it would be confidently wrong —
 * which is the failure mode this project exists to avoid.
 */
export function proveSource(index: SourceIndex, code: number | null, name: string): SourceProof {
  if (code === null) {
    return {
      kind: 'unchecked',
      reason:
        'The failure carried no numeric error code, so the uploaded source could not be checked ' +
        'against the numbering the deployed program used.',
    };
  }

  const declaring = index.enums.filter((entry) => entry.codes.has(code));
  if (declaring.length === 0) {
    return {
      kind: 'unchecked',
      reason:
        `No #[error_code] enum in the uploaded source declares code ${String(code)}, so the tree ` +
        'could not be checked against the numbering the deployed program used.',
    };
  }

  const match = declaring.find((entry) => entry.codes.get(code) === name);
  if (match !== undefined) return { kind: 'confirmed', enumName: match.name };

  const first = declaring[0]!;
  return { kind: 'contradicted', enumName: first.name, declares: first.codes.get(code)! };
}

/**
 * Locate the lines that raise the error that fired.
 *
 * The filter is the error variant, not reachability. The name is already
 * established by the logs or the IDL, so the question is only which lines raise
 * *that* variant — which a lexical index answers, where "which lines can this
 * handler reach" would need a Rust front end and a call graph.
 *
 * Ranking is by lexical containment in the failing handler. That is weaker than
 * reachability and is described as such in every rationale: a site inside the
 * handler's own body is more likely to be the one, and a site in a helper the
 * handler calls is not distinguished from one in an unrelated handler.
 */
export function narrow(tree: SourceTree, finding: Finding, handlerName: string | null): Narrowing {
  const name = finding.error.name;
  if (name === null) {
    return {
      candidates: [],
      declaration: null,
      proof: null,
      reasons: [
        'Source was uploaded but no error name was established, so there is nothing to look for ' +
          'in it. A line number needs a variant to search for, and no error name was established, ' +
          'so the code stays a number.',
      ],
    };
  }

  // Names arrive from logs and IDLs, so they are admitted only if they could be
  // names in source. Anything else has nothing to be looked up under.
  const refuse = (kind: string, bad: string): Narrowing => ({
    candidates: [],
    declaration: null,
    proof: null,
    reasons: [notAnIdentifier(kind, bad)],
  });
  if (!isRustIdentifier(name)) return refuse('error', name);

  // The handler only affects ranking and which accounts struct is chosen, so one
  // that cannot be a Rust identifier is set aside with a reason rather than
  // discarding an answer that does not depend on it.
  const notes: string[] = [];
  let handler = handlerName;
  if (handler !== null && !isRustIdentifier(handler)) {
    notes.push(
      `${notAnIdentifier('handler', handler)} It was not used: candidates are not ranked by ` +
        'handler and no accounts struct was selected from it.',
    );
    handler = null;
  }

  const counter: WorkCounter = { work: 0 };
  // Read once and shared by the declaration path and the variant path.
  const prepared = prepareTree(tree, counter);
  const result = narrowPrepared(tree, prepared, counter, finding, handler, name, refuse);
  return notes.length === 0 ? result : { ...result, reasons: [...notes, ...result.reasons] };
}

function narrowPrepared(
  tree: SourceTree,
  prepared: PreparedTree,
  counter: WorkCounter,
  finding: Finding,
  handlerName: string | null,
  name: string,
  refuse: (kind: string, bad: string) => Narrowing,
): Narrowing {
  // An error Anchor generated from a declaration is not raised anywhere in the
  // source, so the throw-site index can never find it. It comes with something
  // better: the name of the field it blamed.
  const blamed = finding.failure.kind === 'anchor' ? finding.failure.account : null;
  if (blamed !== null && isDeclarationError(name)) {
    if (!isRustIdentifier(blamed)) return refuse('account field', blamed);
    const located = fromDeclaration(tree, prepared, handlerName, blamed, name);
    // Fall through to the variant path only when the declaration search found
    // nothing to say. A program may also raise a custom error from a handler
    // body while Anchor blames an account, and either answer beats none.
    if (located.candidates.length > 0) return located;
    const searched = searchVariants(prepared, counter, finding, handlerName, name);
    if (searched.result.candidates.length > 0) {
      return {
        ...searched.result,
        reasons: [...located.reasons, ...searched.result.reasons, ...searched.coverage],
      };
    }
    // Nothing found either way. The variant search's own "not raised" verdict is
    // beside the point for a declaration error, but what it did not read is not.
    return { ...located, reasons: [...located.reasons, ...searched.coverage] };
  }

  const { result, coverage } = searchVariants(prepared, counter, finding, handlerName, name);
  return coverage.length === 0 ? result : { ...result, reasons: [...result.reasons, ...coverage] };
}

/**
 * The proof a field-located answer carries, which is none.
 *
 * Anchor's own constraint codes are not the program's, so the tree's
 * `#[error_code]` numbering can say nothing about them and nothing else ties the
 * tree to the revision that ran.
 */
const DECLARATION_PROOF: SourceProof = {
  kind: 'unchecked',
  reason:
    "The failure was located by the field Anchor blamed. Its codes are Anchor's own rather than " +
    "the program's, so the uploaded tree's #[error_code] numbering could not be checked against " +
    'them.',
};

/**
 * Locate the `#[account(...)]` declaration Anchor blamed, and the attribute
 * within it that failed.
 *
 * This is the answer `CLAUDE.md` calls the differentiator: the constraint
 * expression from source, next to the runtime values the earlier tiers already
 * established. For a `ConstraintSeeds` failure it yields the seed expression
 * itself — which is worth most exactly where the explanation tier had to refuse
 * to recompute it, because a seed component reads another account's current
 * state.
 */
function fromDeclaration(
  tree: SourceTree,
  prepared: PreparedTree,
  handlerName: string | null,
  field: string,
  name: string,
): Narrowing {
  const outcome = findDeclaration(tree, handlerName, field, name, prepared);
  const unread =
    outcome.unread === undefined || outcome.unread.length === 0
      ? []
      : [
          `Parts of the uploaded source were not read: ${outcome.unread.slice(0, 5).join('; ')}` +
            `${outcome.unread.length > 5 ? `, and ${String(outcome.unread.length - 5)} more` : ''}. ` +
            'What is said here about the account declaration covers only what was read.',
        ];

  if (outcome.kind === 'refused') {
    return { candidates: [], declaration: null, proof: null, reasons: [outcome.reason] };
  }

  if (outcome.kind === 'truncated') {
    return {
      candidates: [],
      declaration: null,
      proof: DECLARATION_PROOF,
      reasons: [
        `The accounts struct ${outcome.struct} was too large to read in full, so whether it ` +
          `declares the ${field} field Anchor blamed is not established. This is a limit of the ` +
          'reader, not a finding that the source and the deployed binary disagree.',
        ...unread,
      ],
    };
  }

  if (outcome.kind === 'absent') {
    return {
      candidates: [],
      declaration: null,
      proof: DECLARATION_PROOF,
      reasons: [
        `Anchor blamed the ${field} account, but ${outcome.struct} — the accounts struct the ` +
          'handler that ran declares — has no such field. The uploaded source and the deployed ' +
          'binary disagree about this instruction, so no line from it is reported.',
        ...unread,
      ],
    };
  }

  if (outcome.kind === 'ambiguous') {
    return {
      candidates: [],
      declaration: null,
      proof: DECLARATION_PROOF,
      reasons: [
        `${outcome.structs.length} accounts structs declare a ${field} field ` +
          `(${outcome.structs.join(', ')}) and the handler that ran was not identified, so which ` +
          'declaration failed is not determined.',
        ...unread,
      ],
    };
  }

  if (outcome.kind === 'unknown' && unread.length > 0) {
    return {
      candidates: [],
      declaration: null,
      proof: DECLARATION_PROOF,
      reasons: [
        `No accounts struct that was read declares a ${field} field, but part of the uploaded ` +
          'source was not read, so whether any struct declares it is not established.',
        ...unread,
      ],
    };
  }

  if (outcome.kind === 'unknown') {
    return {
      candidates: [],
      declaration: null,
      proof: DECLARATION_PROOF,
      reasons: [
        `No accounts struct in the uploaded source declares a ${field} field, which is the ` +
          'account Anchor blamed. The tree is missing the file that declares it, or describes a ' +
          'different version of the program.',
        ...unread,
      ],
    };
  }

  const { declaration, viaHandler } = outcome;
  const reasons: string[] = [...unread];

  if (declaration.attributesTruncated === true) {
    reasons.push(
      `The ${field} declaration was found, but its #[account(...)] attributes could not be read ` +
        'in full, so no constraint expression is reported and the field must not be taken to have ' +
        'none.',
    );
  }
  if (!viaHandler) {
    reasons.push(
      `The handler's accounts struct could not be read from the source, so ${declaration.struct} ` +
        `was identified as the only struct declaring a ${field} field rather than as the one ` +
        'that ran.',
    );
  }
  if (
    declaration.constraint === null &&
    declaration.attributes.length > 0 &&
    declaration.attributesTruncated !== true
  ) {
    reasons.push(
      `${name} does not come from any single #[account(...)] attribute, so the whole declaration ` +
        'is reported rather than one expression within it.',
    );
  }

  return {
    candidates: [
      {
        location: { file: declaration.file, line: declaration.line },
        rank: 1,
        rationale: declarationRationale(declaration, name, viaHandler),
      },
    ],
    declaration,
    proof: DECLARATION_PROOF,
    reasons,
  };
}

/**
 * Why this declaration is the candidate.
 *
 * Says plainly that the numbering proof did not apply. These are Anchor's own
 * codes rather than the user enum's, so `proveSource` can say nothing about
 * them, and the field lookup is the whole of the evidence — weaker, and the
 * reader should not assume otherwise.
 */
function declarationRationale(
  declaration: AccountDeclaration,
  name: string,
  viaHandler: boolean,
): string {
  const expression =
    declaration.constraint === null
      ? `The field is declared as ${declaration.text}`
      : `The constraint that failed is \`${declaration.constraint}\``;

  const how = viaHandler
    ? `${declaration.struct}, read from the handler's Context<> parameter rather than from its name`
    : `${declaration.struct}, the only struct in the tree declaring this field`;

  return (
    `Anchor raised ${name} against the ${declaration.field} field of ${how}. ${expression}. ` +
    'This is located by the field name Anchor printed, not by the error numbering — these are ' +
    "Anchor's own codes rather than the program's, so the tree's #[error_code] ordering says " +
    'nothing about them. The source was supplied rather than built from the deployed binary, so ' +
    'this locates a candidate and does not prove the line that ran.'
  );
}

/**
 * The original path: find where the source raises this variant.
 *
 * Whatever the search concluded, it says when part of the tree was not read. A
 * file over the indexer's size caps is skipped rather than truncated, and "not
 * raised anywhere" over a partial tree is a weaker statement than it reads as.
 */
/** The variant search, with what it did not read kept apart from its verdict. */
function searchVariants(
  prepared: PreparedTree,
  counter: WorkCounter,
  finding: Finding,
  handlerName: string | null,
  name: string,
): { result: Narrowing; coverage: string[] } {
  const index = indexPrepared(prepared, counter);
  const result = variantsIn(prepared.files, index, finding, handlerName, name, counter);
  if (index.skipped.length === 0) return { result, coverage: [] };

  const listed = index.skipped
    .slice(0, 5)
    .map((entry) => `${entry.path} (${entry.reason})`)
    .join('; ');
  const more = index.skipped.length > 5 ? `, and ${String(index.skipped.length - 5)} more` : '';

  return {
    result,
    coverage: [
      `${String(index.skipped.length)} part(s) of the uploaded source were not searched: ` +
        `${listed}${more}. Anything said here about where ${name} is raised covers only what ` +
        'was read.',
    ],
  };
}

function variantsIn(
  files: readonly PreparedFile[],
  index: SourceIndex,
  finding: Finding,
  handlerName: string | null,
  name: string,
  counter: WorkCounter,
): Narrowing {
  const proof = proveSource(index, finding.error.code, name);

  if (proof.kind === 'contradicted') {
    return {
      candidates: [],
      declaration: null,
      proof,
      reasons: [
        `The uploaded source does not describe the program that ran: its ${proof.enumName} enum ` +
          `numbers ${String(finding.error.code)} as ${proof.declares}, while the failure was ` +
          `${name}. That is a different version of the program, so no line from this tree is ` +
          'reported — a line number from the wrong revision is worse than none.',
      ],
    };
  }

  const matching = index.sites.filter((site) => site.variant === name);
  if (matching.length === 0) {
    return {
      candidates: [],
      declaration: null,
      proof,
      reasons: [
        `${name} is not raised anywhere in the ${String(index.files)} uploaded source ` +
          'file(s). Either the tree is missing the file that raises it, or the error is returned ' +
          'by a dependency rather than by this program.',
      ],
    };
  }

  const handler = handlerName === null ? null : snakeCase(handlerName);
  const found =
    handler === null
      ? { scopes: [], notes: [] }
      : handlerScopes(files, handler, handlerName!, counter);
  const inside = scopeIndex(found.scopes);

  // Containment is decided once per site, and ranking is a stable partition
  // (contained first, source order within each) rather than a sort whose
  // comparator would repeat the lookup.
  const contained: ThrowSite[] = [];
  const outside: ThrowSite[] = [];
  for (const site of matching) (contains(inside, site) ? contained : outside).push(site);
  const ranked = [...contained, ...outside];
  const anyContained = contained.length > 0;
  const reasons: string[] = [...found.notes];

  if (proof.kind === 'unchecked') reasons.push(proof.reason);
  if (handler === null) {
    reasons.push(
      'No handler was identified for the failing instruction, so candidates could not be ranked ' +
        'by which one contains them and are reported in source order.',
    );
  } else if (!anyContained) {
    reasons.push(
      `${name} is raised in the uploaded source but never inside ${handler}, the handler that ` +
        'ran. The sites are reported unranked: they may sit in a helper this handler calls, ' +
        'which a lexical index cannot distinguish from an unrelated one.',
    );
  }

  // A stated cap is not a collapse of the set; a silent one would be.
  const shown = ranked.slice(0, MAX_CANDIDATES);
  if (shown.length < ranked.length) {
    reasons.push(
      `${String(ranked.length)} sites in the uploaded source raise ${name}; the ` +
        `${String(shown.length)} best-ranked are shown and the other ` +
        `${String(ranked.length - shown.length)} are not listed.`,
    );
  }

  return {
    candidates: shown.map((site, position) => ({
      // No column: the index locates the line that raises the error, and a
      // column would imply a precision a lexical scan does not have.
      location: { file: site.file, line: site.line },
      rank: position + 1,
      rationale: rationale(site, name, position < contained.length, handler, proof),
    })),
    declaration: null,
    proof,
    reasons,
  };
}

/** Most candidates reported; the count of those cut is stated in `reasons`. */
export const MAX_CANDIDATES = 50;

/**
 * Why this line is a candidate, in terms the reader can check.
 *
 * Required by `CandidateSite`, and the requirement is the point: a candidate the
 * tool cannot justify is a guess. Every rationale says the tree was supplied and
 * is not hash-proven against the deployed binary, because that is what caps the
 * whole answer at `narrowed`.
 */
function rationale(
  site: ThrowSite,
  name: string,
  contained: boolean,
  handler: string | null,
  proof: SourceProof,
): string {
  const placed =
    contained && handler !== null
      ? `inside ${handler}, the handler that ran`
      : handler === null
        ? 'in a tree whose failing handler could not be identified'
        : `outside ${handler}, so it is reachable only through a call this index cannot follow`;

  const proven =
    proof.kind === 'confirmed'
      ? `The tree's ${proof.enumName} enum numbers this error the same way the deployed program ` +
        'did, so it describes this program.'
      : 'The tree could not be checked against the deployed error numbering.';

  return (
    `A ${site.form} form raising ${name}, ${placed}: ${site.text}. ${proven} The source was ` +
    'supplied rather than built from the deployed binary, so this locates a candidate and does ' +
    'not prove the line that ran.'
  );
}

/** Line ranges of the handler's function body and its accounts struct. */
interface Scope {
  file: string;
  from: number;
  to: number;
}

/** Scopes per file as sorted, non-overlapping ranges, so a lookup is a bisection. */
function scopeIndex(scopes: readonly Scope[]): Map<string, [number, number][]> {
  const byFile = new Map<string, [number, number][]>();
  for (const scope of scopes) {
    const list = byFile.get(scope.file) ?? [];
    list.push([scope.from, scope.to]);
    byFile.set(scope.file, list);
  }
  for (const [file, list] of byFile) {
    list.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of list) {
      const last = merged.at(-1);
      if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    byFile.set(file, merged);
  }
  return byFile;
}

function contains(index: ReadonlyMap<string, [number, number][]>, site: ThrowSite): boolean {
  const ranges = index.get(site.file);
  if (ranges === undefined) return false;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = ranges[mid]!;
    if (site.line < from) high = mid - 1;
    else if (site.line > to) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Where the failing handler lives: its `pub fn` body and its accounts struct.
 *
 * Both matter. A `require!` sits in the function; an `#[account(... @ E::X)]`
 * constraint sits in the `#[derive(Accounts)]` struct, which Anchor conventionally
 * names in PascalCase after the handler — and that convention is used only to
 * *rank*, never to claim anything, which is why a miss costs nothing.
 */
function handlerScopes(
  files: readonly PreparedFile[],
  snake: string,
  pascal: string,
  counter: WorkCounter,
): { scopes: Scope[]; notes: string[] } {
  const scopes: Scope[] = [];
  // Built once, from names already admitted as identifiers and escaped anyway.
  const fn = new RegExp(`\\bfn\\s{1,16}${escapeRegExp(snake)}\\s{0,16}[<(]`, 'g');
  const struct = new RegExp(`\\bstruct\\s{1,16}${escapeRegExp(pascal)}\\b`, 'g');
  let unbounded = 0;
  let firstUnbounded: string | null = null;

  for (const file of files) {
    counter.work += file.text.length;
    for (const [regex, isStruct] of [
      [fn, false],
      [struct, true],
    ] as const) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.text)) !== null) {
        const i = lineOf(file, match.index);
        // The body is the brace pair after the declaration, from the file's
        // precomputed matching. No `{` in reach means no scope — never a scope
        // that runs to the end of the file.
        const body = bodyOpen(file.text, match.index, MAX_SCOPE_HEADER_CHARS, counter);
        if (body.kind === 'capped') {
          unbounded += 1;
          firstUnbounded ??= `${file.path}:${String(i + 1)}`;
          continue;
        }
        if (body.kind === 'none') continue;
        if (scopes.length >= MAX_SCOPES) {
          unbounded += 1;
          firstUnbounded ??= `${file.path}:${String(i + 1)}`;
          continue;
        }
        const close = file.closeOf.get(body.at);
        const end = close === undefined ? file.lines.length - 1 : lineOf(file, close);
        // A struct's constraints live in attributes above its fields, and Anchor
        // puts the `#[derive(Accounts)]` line above the struct, so back up far
        // enough to include it.
        scopes.push({
          file: file.path,
          from: isStruct ? Math.max(1, i - 1) : i + 1,
          to: end + 1,
        });
      }
    }
  }

  const notes =
    unbounded === 0
      ? []
      : [
          `${String(unbounded)} declaration(s) of ${snake} or ${pascal} had no body within ` +
            `${String(MAX_SCOPE_HEADER_CHARS)} characters, or came after the first ${String(MAX_SCOPES)} (first at ${firstUnbounded ?? ''}) ` +
            'and were not used for ranking, so candidates may be ranked without them.',
        ];
  return { scopes, notes };
}

/** Most scopes kept for ranking; later ones are counted and reported. */
export const MAX_SCOPES = 1_000;

/** Characters between a handler's name and its opening brace before it is not ranked. */
export const MAX_SCOPE_HEADER_CHARS = 2_000;

/**
 * `BuyExactQuoteIn` to `buy_exact_quote_in`.
 *
 * The same conversion `resolve/idl.ts` uses to derive discriminators from
 * pre-0.30 instruction names, and for the same reason: Anchor logs the handler
 * in PascalCase and declares it in snake_case.
 */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
