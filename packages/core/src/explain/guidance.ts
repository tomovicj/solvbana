import type { Finding } from '../analyze/types.ts';
import { passedSide, requiredSide } from './comparison.ts';
import type { AccountRow, DecodedArg, DerivationCheck, Guidance, ReadComparison } from './types.ts';

/**
 * Turn the evidence into what to do about it.
 *
 * Distinct from `Finding.explanation`, which says what an error variant means in
 * general. This says what *this* transaction showed — that the account held no
 * lamports, that the address is not the associated token account of anything the
 * instruction passed, that one frame burned the whole budget — and only names a
 * fix when the evidence is unambiguous enough to support one.
 */
export function buildGuidance(
  finding: Finding,
  accounts: readonly AccountRow[],
  derivations: readonly DerivationCheck[],
  comparison: ReadComparison | null = null,
  args: readonly DecodedArg[] = [],
): Guidance {
  const { failure } = finding;

  if (failure.kind === 'compute') return computeGuidance(failure);
  if (failure.kind === 'panic') return panicGuidance(failure);
  if (failure.kind === 'anchor' && failure.account !== null) {
    const account = anchorAccountGuidance(finding, failure.account, accounts, derivations);
    // The account branches answer from the record — a zero balance, a proven
    // associated-token derivation. Only where they found nothing to say does the
    // operand pair get its turn.
    if (account.causes.length > 0 || account.fix !== null) return account;
  }

  if (comparison !== null) {
    return comparisonGuidance(finding, comparison, derivations);
  }

  // A self-named error that printed no operands. The arguments are the last
  // thing the record holds about it, and they are the inputs the client chose.
  if (failure.kind === 'anchor') return argumentGuidance(finding, args);

  return {
    meaning: finding.explanation,
    causes: [],
    fix: null,
  };
}

/**
 * Guidance built from the two operands the program printed.
 *
 * `explainAnchor` already prints the pair and deliberately declines to say which
 * side is which, because Anchor's labels are a convention of its source and not
 * a fact about the failure. What this adds is the part the record can settle:
 * the gap between two numbers, and — where one operand is provably the address
 * the blamed account holds — which side the program required.
 *
 * That required address is *read* rather than derived, which is why it can be
 * reported for an account whose declared seeds this tier refused to resolve. It
 * is the same distinction that lets a panic's `file:line` stand without a
 * verified build while a computed line may not.
 *
 * Every branch opens with `finding.explanation`, which already states the
 * operands neutrally, and then adds only what the record settles on top of it.
 */
function comparisonGuidance(
  finding: Finding,
  comparison: ReadComparison,
  derivations: readonly DerivationCheck[],
): Guidance {
  if (comparison.numeric !== null) return numericGuidance(finding, comparison);

  const blamed = finding.failure.kind === 'anchor' ? finding.failure.account : null;
  const required = requiredSide(comparison);
  const passed = passedSide(comparison);

  if (required === null || passed === null) {
    // Both operands are already reported; only their roles are withheld.
    // Labelling them from Anchor's source ordering would be a claim the record
    // does not carry, and an unlabelled pair is still more than nothing.
    const why =
      blamed === null
        ? 'the failure named no account to compare them against'
        : `${blamed} could not be matched to a position in the instruction, and an account's ` +
          'owner is not part of the transaction record';
    return {
      meaning: `${finding.explanation} Which of the two the instruction supplied, and which the program required, is not established by the record.`,
      causes: [
        `One of these two values is what the instruction was given and the other is what the ` +
          `program required. Which is which is not determined here because ${why}, so they are ` +
          'reported unlabelled rather than guessed at.',
      ],
      fix: null,
    };
  }

  // The declared-seed check for this account, when there is one. Its refusal is
  // the reason the logged address is worth reporting separately at all.
  const declared = derivations.find(
    (check) => check.account === blamed && check.source === 'idl-pda',
  );

  const causes: string[] = [];
  if (declared?.status === 'unresolved') {
    causes.push(
      `${required} is read from the log the program printed, not recomputed here. The declared ` +
        `seeds for ${blamed ?? 'this account'} could not be resolved from the transaction record` +
        `${declared.blockedBy === null ? '' : `: ${declared.blockedBy}`}. The running program had ` +
        'that state and derived the address; this tier does not fetch it, so the address the ' +
        'program printed is the only sound source for it.',
    );
  }
  causes.push(
    'The client derived the address with a different seed set or a different seed order.',
    'A bump cached from an earlier derivation that is no longer the canonical one.',
  );

  return {
    meaning:
      `${finding.explanation} The program required ${required} and the instruction passed ` +
      `${passed}. Which side is which is established from the record rather than from Anchor's ` +
      `labels: ${passed} is the address ${blamed ?? 'the blamed account'} actually holds in this ` +
      'transaction, so the other operand is what the program computed and did not get.',
    causes,
    fix:
      `Derive the address on the client with findProgramAddress and pass ${required}, rather ` +
      'than reusing a stored address or a cached bump.',
  };
}

/**
 * Guidance for a comparison between two numbers.
 *
 * Orientation is neither needed nor claimed: an absolute difference and a
 * relative gap read the same whichever side is which, and they are what turns
 * "a comparison failed" into a quantity the reader can act on.
 */
function numericGuidance(finding: Finding, comparison: ReadComparison): Guidance {
  const numeric = comparison.numeric!;
  const argument = comparison.argument;
  // The parameter the client controls, when exactly one carried an operand.
  // This is the difference between "a comparison failed" and "the number you
  // passed for this argument is the one to change".
  const named = argument === null ? '' : ` The value came from the ${argument.name} argument.`;

  if (numeric.equal) {
    return {
      meaning:
        `${finding.explanation} The two sides were equal, so the comparison failed on equality ` +
        `rather than on magnitude.${named}`,
      causes: [
        'A strict comparison — require_gt! or require_neq! — given two equal values. The ' +
          'non-strict forms are require_gte! and require_eq!.',
        argument === null
          ? 'A value expected to have been set before this instruction ran that was still at its ' +
            'initial value.'
          : `${argument.name} was sent as ${comparison.left}, which the check requires it to be ` +
            'strictly beyond rather than equal to. A client that leaves this at its default ' +
            'sends exactly this.',
      ],
      fix:
        argument === null
          ? 'Decide whether equality should pass here. If it should, use the non-strict form of ' +
            'the comparison; if it should not, the value the client sent is the thing to fix.'
          : `Send a ${argument.name} the check can pass, or — if equality should be allowed — ` +
            'use the non-strict form of the comparison in the program.',
    };
  }

  const percent = numeric.relative === null ? null : (numeric.relative * 100).toFixed(2);
  const supplied = passedSide(comparison);
  const computed = requiredSide(comparison);

  // With an orientation, this stops being a gap between two anonymous numbers
  // and becomes a statement about one input and one outcome.
  const sides =
    supplied === null || computed === null
      ? ''
      : ` The instruction supplied ${supplied}${argument === null ? '' : ` as ${argument.name}`} ` +
        `and the program computed ${computed}.`;

  return {
    meaning:
      `${finding.explanation} The two sides differ by ${numeric.difference.toString()}` +
      `${percent === null ? '' : `, which is ${percent}% of the larger`}.${sides}`,
    causes: [
      'A bound the client computed from a quote that no longer held — pool state moves between ' +
        'quoting and landing, and the gap above is how far it moved.',
      'A units mismatch: an amount in whole tokens compared against one in fractional units, ' +
        'which shows up as a difference near a power of ten.',
    ],
    fix:
      percent === null
        ? 'Compare the two values above against what the client intended to send.'
        : `Re-quote closer to send time, or ${argument === null ? 'widen the tolerance' : `relax ${argument.name}`} ` +
          `past ${percent}% if that gap is acceptable for this trade.`,
  };
}

/**
 * Guidance for a self-named error that printed no operands.
 *
 * The largest group in this class by distinct program: the error names itself,
 * its `#[msg]` text says what it means, and nothing states the values that
 * failed the check. What the record still holds is the arguments the client
 * encoded, which are the inputs under their control — and the absence itself is
 * worth naming, because the program chose a bare `require!` where the comparing
 * forms would have logged both sides.
 */
function argumentGuidance(finding: Finding, args: readonly DecodedArg[]): Guidance {
  const listed = args
    .filter((arg) => arg.value !== null)
    .map((arg) => `${arg.name} = ${arg.value!}`);

  if (listed.length === 0) return { meaning: finding.explanation, causes: [], fix: null };

  return {
    meaning:
      `${finding.explanation} The program did not print the values it compared, so what this ` +
      `instruction supplied is what can be shown: ${listed.join(', ')}.`,
    causes: [
      'One of the arguments above did not satisfy a check the program made against state it ' +
        'read at the failing slot. The record holds the arguments but not that state, so which ' +
        'check failed is not determined here.',
    ],
    fix:
      'Compare the arguments above against what the client intended to send. To make the next ' +
      'failure self-explaining, raise this with require_eq! or require_gt! rather than a bare ' +
      'require! — those log both operands, and this diagnosis would then name the values too.',
  };
}

function computeGuidance(failure: Extract<Finding['failure'], { kind: 'compute' }>): Guidance {
  if (failure.scope === 'stack-frame') {
    return {
      meaning:
        'The program exceeded a 4KB stack frame. This is not a compute budget problem and ' +
        'raising the unit limit will not help.',
      causes: [
        'A large struct or array held by value in a function rather than behind a Box or a reference.',
        'Deep inlining that merged several frames worth of locals into one.',
      ],
      fix: 'Box the large local, or split the function so the big value lives in its own frame.',
    };
  }

  const consumed = failure.consumed;
  const budget = failure.budget;
  const measured =
    consumed !== null && budget !== null
      ? ` It used ${String(consumed)} of ${String(budget)} units.`
      : '';

  if (failure.scope === 'transaction') {
    return {
      meaning: `The transaction ran out of its compute budget.${measured}`,
      causes: [
        'No SetComputeUnitLimit instruction, so the transaction took the default rather than what it needed.',
        'More instructions batched together than the shared budget covers.',
      ],
      fix:
        failure.requestedLimit === null
          ? 'Add a ComputeBudget SetComputeUnitLimit instruction sized from a simulation of this transaction.'
          : `The transaction requested ${String(failure.requestedLimit)} units. Simulate it and raise the limit to what it actually needs.`,
    };
  }

  return {
    meaning: `The invoked program exhausted the compute units available to its own frame.${measured}`,
    causes: [
      'A loop whose iteration count grows with account data — tick arrays, order books, or holder lists.',
      'Heavy logging in the hot path; every msg! costs units and pushes the important lines toward the 10KB truncation cap.',
    ],
    fix: 'Raise the limit with SetComputeUnitLimit if the work is legitimate, or bound the loop if it is not.',
  };
}

function panicGuidance(failure: Extract<Finding['failure'], { kind: 'panic' }>): Guidance {
  const at = `${failure.site.file}:${String(failure.site.line)}`;

  if (failure.classification === 'arithmetic-overflow') {
    return {
      meaning: `An arithmetic operation overflowed at ${at}.`,
      causes: [
        'A token amount scaled by decimals exceeding the width of its type.',
        'A subtraction that went below zero on an unsigned type.',
      ],
      // Panicking on overflow means overflow-checks was on, which is the good case.
      fix: 'Use checked_add / checked_sub / checked_mul and return a named error instead of panicking. The panic itself is the build behaving correctly — overflow-checks is enabled, so the bug surfaced rather than wrapping silently.',
    };
  }

  if (failure.classification === 'unwrap-none') {
    return {
      meaning: `An Option was unwrapped while empty at ${at}.`,
      causes: [
        'An account or map lookup that found nothing where the code assumed a value.',
        'An optional account left unsupplied by the client.',
      ],
      fix: 'Replace the unwrap with ok_or(ErrorCode::Something)? so the failure carries a name instead of a panic.',
    };
  }

  return {
    meaning: `The program panicked at ${at}: ${failure.message}`,
    causes: [],
    fix: 'Convert the panic into a named error so the failure reports a variant rather than aborting the frame.',
  };
}

/**
 * Guidance for an Anchor error that named an account.
 *
 * The strongest evidence available here is a zero pre-balance: an account with
 * no lamports has been deallocated, so the record states outright that it did not
 * exist. That turns a generic "not initialized" into a fact about this account.
 */
function anchorAccountGuidance(
  finding: Finding,
  account: string,
  accounts: readonly AccountRow[],
  derivations: readonly DerivationCheck[],
): Guidance {
  const row = accounts.find((entry) => entry.name === account);
  const check = derivations.find((entry) => entry.account === account);

  if (row?.existedBefore === false) {
    const meaning =
      `${account} held no lamports when the instruction ran, so the account did not exist. ` +
      'An account with a zero balance has been deallocated, which is why Anchor reports it as ' +
      'uninitialized rather than as malformed.';

    if (check?.source === 'associated-token' && check.status === 'match') {
      const owner = check.seeds[0]?.address ?? 'its owner';
      const mint = check.seeds[2]?.address ?? 'that mint';
      const tokenProgram = check.seeds[1]?.address ?? 'the token program';
      return {
        meaning,
        causes: [
          `The address is the associated token account for mint ${mint} owned by ${owner}, and it has not been created yet.`,
          'The client assumed the account already existed rather than creating it idempotently.',
        ],
        fix:
          `Create it before this instruction — the idempotent form is safe to send every time — ` +
          `deriving with mint ${mint}, owner ${owner} and token program ${tokenProgram}. ` +
          'If creation belongs to this handler instead, declare the field init_if_needed.',
      };
    }

    if (check?.source === 'associated-token' && check.status === 'not-derivable') {
      return {
        meaning,
        causes: [
          `The address is not the associated token account of any account this instruction passed, searched over ${check.searched ?? 'the instruction inputs'}. It was most likely derived from the wrong inputs.`,
          'A cached or hard-coded address that belongs to a different wallet or mint.',
        ],
        fix: 'Re-derive the address from the mint, the owner and the token program this instruction actually uses, rather than reusing a stored value.',
      };
    }

    return {
      meaning,
      causes: [
        'The account was never created, or was closed by an earlier instruction.',
        'The address passed is not the one the program derives for this field.',
      ],
      fix: 'Create the account before this instruction, or use init_if_needed if creating it belongs here.',
    };
  }

  if (check?.status === 'mismatch' && check.expected !== null) {
    return {
      meaning:
        `${account} is not the address its declared seeds derive. The program expected ` +
        `${check.expected} and was given ${check.actual ?? 'a different account'}.`,
      causes: [
        'The client derived the address with a different seed order or a different seed set.',
        'A cached bump that is no longer the canonical one.',
      ],
      fix: 'Re-derive on the client with findProgramAddress using the seeds shown above, in that order, rather than storing the bump.',
    };
  }

  return { meaning: finding.explanation, causes: [], fix: null };
}
