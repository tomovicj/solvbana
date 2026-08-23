import type { Finding } from '../analyze/types.ts';
import { walkInstructions } from '../ingest/instructions.ts';
import type { FailedTransaction, InstructionNode } from '../ingest/types.ts';
import { handlerForDiscriminator, type IdlHandler, type ResolvedIdl } from '../resolve/idl.ts';
import { decodeBase58 } from '../signature.ts';
import { accountTable, nameableCount } from './accounts.ts';
import { decodeArgs } from './args.ts';
import { computeBreakdown } from './compute.ts';
import { balanceDeltas } from './deltas.ts';
import type { AccountDeclaration } from '../narrow/accounts.ts';
import { readComparison } from './comparison.ts';
import { checkAssociatedToken, checkIdlPdas } from './derive.ts';
import { buildGuidance } from './guidance.ts';
import type { AccountRow, DecodedArg, DerivationCheck, Explanation } from './types.ts';

/**
 * The blamed account and the operand pair, which travel together.
 *
 * Both come off the same `anchor` failure variant, and the comparison can only
 * be oriented once the blamed name, the account table and the decoded arguments
 * are all in hand — which is why this runs late rather than beside `analyze`.
 */
function anchorEvidence(
  finding: Finding,
  accounts: readonly AccountRow[],
  args: readonly DecodedArg[],
) {
  if (finding.failure.kind !== 'anchor') return { blamed: null, comparison: null };
  const { account, comparison } = finding.failure;
  return {
    blamed: account,
    comparison: comparison === null ? null : readComparison(comparison, account, accounts, args),
  };
}

/**
 * The instruction the failing program ran, when the record identifies one
 * unambiguously.
 *
 * The failing program is often reached by CPI, and correlating a log frame to a
 * node in the instruction tree is Phase 3's problem. So rather than guess at the
 * correspondence, every node addressed to the failing program is collected and
 * the answer is used only when there is exactly one. Two calls into the same
 * program leave the question genuinely open, and it is left open — the same rule
 * `refineWithResolution` already applies to handler names.
 */
export function failingInstructionNode(
  transaction: FailedTransaction,
  programId: string,
): InstructionNode | null {
  const nodes = [...walkInstructions(transaction.instructions)].filter(
    (node) => node.programId === programId,
  );
  return nodes.length === 1 ? nodes[0]! : null;
}

/** The IDL handler whose discriminator the instruction data carries. */
function handlerFor(node: InstructionNode, idl: ResolvedIdl | null): IdlHandler | null {
  if (idl === null) return null;
  const data = decodeBase58(node.data);
  if (data === null || data.length < 8) return null;
  return handlerForDiscriminator(idl, data);
}

/**
 * Explain a failure from the transaction record and the program's published IDL.
 *
 * Async but free of I/O: address derivation goes through subtle crypto, which is
 * promise-returning. Nothing here reaches the network, and that is deliberate —
 * a failed transaction rolls back, so an account read now describes a different
 * world than the one that failed.
 *
 * Produces no confidence and no candidate sites. This tier explains what earlier
 * tiers established and locates nothing new, so it must not promote a diagnosis.
 */
export async function explainFailure(
  transaction: FailedTransaction,
  finding: Finding,
  idl: ResolvedIdl | null,
  /**
   * The source declaration narrowing located, when a tree was uploaded.
   *
   * Passed in rather than looked up, because this tier does no I/O and holds no
   * artifact store. Narrowing has already read the tree by the time this runs;
   * carrying its result here is what puts the constraint expression beside the
   * runtime values without this tier learning how to fetch anything.
   */
  declaration: AccountDeclaration | null = null,
): Promise<Explanation> {
  const notes: string[] = [];
  const deltas = balanceDeltas(transaction);
  const compute = computeBreakdown(transaction);
  if (compute === null) {
    notes.push('No log stream survived, so compute could not be attributed to individual frames.');
  }

  const programId = finding.program;
  const node = programId === null ? null : failingInstructionNode(transaction, programId);

  if (programId === null) {
    notes.push('No program was identified as the origin of the failure, so no accounts were read.');
  } else if (node === null) {
    notes.push(
      `The transaction calls ${programId} more than once, or not as a distinct instruction, so ` +
        'the failing instruction could not be identified without correlating log frames to the ' +
        'instruction tree. No account table was built.',
    );
  }

  if (idl === null && programId !== null) {
    notes.push(
      'No IDL was resolved for the failing program, so accounts are listed by position without ' +
        'names and no declared derivations could be checked.',
    );
  }

  if (node === null) {
    // No account table, so no row to orient the operands against — but the pair
    // itself is still worth reading, and a numeric comparison never needed one.
    const { comparison } = anchorEvidence(finding, [], []);
    return {
      accounts: [],
      args: null,
      derivations: [],
      compute,
      deltas,
      comparison,
      declaration,
      guidance: buildGuidance(finding, [], [], comparison, []),
      notes,
    };
  }

  const handler = handlerFor(node, idl);
  if (idl !== null && handler === null) {
    notes.push(
      `The instruction's discriminator matches no handler in ${idl.programName}'s published IDL. ` +
        'An IDL is published by the program authority and is not updated on upgrade, so it can ' +
        'describe a different version than the binary that ran.',
    );
  }

  const accounts = accountTable(transaction, node, handler);
  if (handler !== null) {
    notes.push(...namingNotes(handler, node));
  }

  const data = decodeBase58(node.data);
  let args: DecodedArg[] | null = null;
  let argSeeds = new Map<string, Uint8Array>();

  if (handler !== null && data !== null && handler.args.length > 0) {
    const decoded = decodeArgs(data, handler.args);
    args = decoded.decoded;
    argSeeds = decoded.seeds;
    const undecoded = args.filter((arg) => arg.value === null);
    if (undecoded.length > 0) {
      notes.push(
        `${String(undecoded.length)} of ${String(args.length)} arguments use types this tier does ` +
          'not decode yet, so they are listed without values. Decoding stops at the first ' +
          'unsupported type rather than reporting the rest from a shifted offset.',
      );
    }
  }

  const derivations: DerivationCheck[] = [];
  if (handler !== null && programId !== null) {
    derivations.push(...(await checkIdlPdas(handler, accounts, argSeeds, programId)));
  }

  // The associated-token search is run only for the account the error blamed.
  // Running it across every account would return true but useless negatives for
  // the ones that were never meant to be token accounts.
  const { blamed, comparison } = anchorEvidence(finding, accounts, args ?? []);
  if (blamed !== null && !derivations.some((check) => check.account === blamed)) {
    const row = accounts.find((entry) => entry.name === blamed);
    if (row !== undefined) {
      const check = await checkAssociatedToken(transaction, accounts, row);
      if (check !== null) derivations.push(check);
    }
  }

  return {
    accounts,
    args,
    derivations,
    compute,
    deltas,
    comparison,
    declaration,
    guidance: buildGuidance(finding, accounts, derivations, comparison, args ?? []),
    notes,
  };
}

/** Why some or all accounts went unnamed, when the IDL and the call disagree. */
function namingNotes(handler: IdlHandler, node: InstructionNode): string[] {
  const passed = node.accountIndexes.length;
  const named = nameableCount(handler, passed);
  const declared = handler.accounts.length;
  const notes: string[] = [];

  if (named === 0) {
    notes.push(
      `${handler.name} declares ${String(declared)} accounts but the transaction passed ` +
        `${String(passed)}. Naming accounts by position would misattribute them, so none are ` +
        'named. The published IDL and the deployed binary disagree about this instruction.',
    );
    return notes;
  }

  if (named < declared) {
    notes.push(
      `${handler.name} declares optional accounts from position ${String(named)} onward. An ` +
        'omitted optional account shifts every account after it and the record does not say ' +
        'which were supplied, so names stop there.',
    );
  }

  if (passed > declared) {
    const surplus = passed - declared;
    notes.push(
      `The transaction passed ${String(surplus)} account${surplus === 1 ? '' : 's'} beyond the ` +
        `${String(declared)} the IDL declares. Those are Anchor's remaining_accounts and carry ` +
        'no declared names.',
    );
  }

  return notes;
}
