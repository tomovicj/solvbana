import type { Finding } from '../analyze/types.ts';
import type { CandidateSite } from '../diagnosis.ts';
import type { SourceTree } from '../rpc/source.ts';
import { indexSource, type SourceIndex, type ThrowSite } from './sites.ts';

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
      reasons: [
        'Source was uploaded but no error name was established, so there is nothing to look for ' +
          'in it. A line number needs a variant to search for; the program publishes no IDL and ' +
          'logged no error name, so the code stays a number.',
      ],
    };
  }

  const index = indexSource(tree);
  const proof = proveSource(index, finding.error.code, name);

  if (proof.kind === 'contradicted') {
    return {
      candidates: [],
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
      reasons: [
        `${name} is not raised anywhere in the ${String(index.files)} uploaded source ` +
          'file(s). Either the tree is missing the file that raises it, or the error is returned ' +
          'by a dependency rather than by this program.',
      ],
    };
  }

  const handler = handlerName === null ? null : snakeCase(handlerName);
  const scopes = handler === null ? [] : handlerScopes(tree, handler, handlerName!);
  const ranked = [...matching].sort(
    (a, b) => Number(contains(scopes, b)) - Number(contains(scopes, a)),
  );

  const anyContained = ranked.some((site) => contains(scopes, site));
  const reasons: string[] = [];

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

  return {
    candidates: ranked.map((site, position) => ({
      // No column: the index locates the line that raises the error, and a
      // column would imply a precision a lexical scan does not have.
      location: { file: site.file, line: site.line },
      rank: position + 1,
      rationale: rationale(site, name, contains(scopes, site), handler, proof),
    })),
    reasons,
  };
}

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

function contains(scopes: readonly Scope[], site: ThrowSite): boolean {
  return scopes.some(
    (scope) => scope.file === site.file && site.line >= scope.from && site.line <= scope.to,
  );
}

/**
 * Where the failing handler lives: its `pub fn` body and its accounts struct.
 *
 * Both matter. A `require!` sits in the function; an `#[account(... @ E::X)]`
 * constraint sits in the `#[derive(Accounts)]` struct, which Anchor conventionally
 * names in PascalCase after the handler — and that convention is used only to
 * *rank*, never to claim anything, which is why a miss costs nothing.
 */
function handlerScopes(tree: SourceTree, snake: string, pascal: string): Scope[] {
  const scopes: Scope[] = [];

  for (const file of tree.files) {
    const lines = file.contents.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const isFn = new RegExp(`\\bfn\\s+${snake}\\s*(?:<|\\()`).test(lines[i]!);
      const isStruct = new RegExp(`\\bstruct\\s+${pascal}\\b`).test(lines[i]!);
      if (!isFn && !isStruct) continue;

      const end = blockEnd(lines, i);
      // A struct's constraints live in attributes above its fields, and Anchor
      // puts the `#[derive(Accounts)]` line above the struct, so back up far
      // enough to include it.
      scopes.push({ file: file.path, from: isStruct ? Math.max(1, i - 1) : i + 1, to: end + 1 });
    }
  }

  return scopes;
}

/**
 * The line closing the block that opens at or after `start`.
 *
 * Brace counting, which is wrong inside a string or char literal containing an
 * unbalanced brace. That costs a scope that runs too long or too short, which
 * only affects ranking — never whether a site is reported — so the cheap version
 * is the right one here.
 */
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
