import type { AnchorError } from './anchor.ts';
import type { Comparison } from './types.ts';

/**
 * What each Anchor error means and what usually causes it.
 *
 * Keyed on the variant name Anchor *logged*, never on a code range. A program
 * that reports `Error Code: ConstraintSeeds` has told us which check failed; a
 * program that merely returned 2006 has not.
 *
 * These read as advice rather than as definitions because the definition is
 * already in the `#[msg]` text the program logged alongside the name, and
 * repeating it adds nothing the reader does not have.
 */
const ANCHOR_EXPLANATIONS: Record<string, string> = {
  ConstraintSeeds:
    'The account passed for this field is not the PDA the seeds in its #[account(seeds = ...)] ' +
    'attribute derive. Either the client derived the address with a different seed set or a ' +
    'different order, or it cached a bump that is no longer canonical. Re-derive on the client ' +
    'with findProgramAddress rather than storing the bump.',
  ConstraintHasOne:
    'A has_one constraint failed: the field it names on the loaded account does not hold the key ' +
    'of the account passed for it. This usually means an account from a different position, ' +
    'market, or vault was supplied — the two accounts are individually valid but do not belong ' +
    'to each other.',
  ConstraintOwner:
    'The account is owned by a different program than the constraint requires. An account that ' +
    'has never been initialized is still owned by the System Program, so this frequently means ' +
    '"not created yet" rather than "created by the wrong program".',
  ConstraintRaw:
    'A raw constraint expression in #[account(constraint = ...)] evaluated to false. The ' +
    'expression itself is not in the logs; it is in the accounts struct for this handler, on the ' +
    'field named above.',
  ConstraintMut:
    'The account needs to be writable and was not marked so in the transaction. The client is ' +
    'building this account reference as readonly.',
  ConstraintSigner:
    'The account was required to sign and did not. Either the client omitted the signer, or the ' +
    'program expected a PDA signature that invoke_signed did not supply.',
  ConstraintAddress:
    'The account does not match the fixed address its #[account(address = ...)] constraint pins ' +
    'it to. Commonly a wrong program, mint, or sysvar for the cluster in use.',
  ConstraintTokenMint:
    'The token account passed is for a different mint than the constraint requires.',
  ConstraintTokenOwner: 'The token account passed is owned by a different authority than required.',
  ConstraintAssociated:
    'The account is not the associated token account for the wallet and mint given. Derive it ' +
    'with getAssociatedTokenAddress rather than passing an arbitrary token account.',
  ConstraintSpace:
    'The space declared for an account being initialized does not match what the type needs. ' +
    'Recompute it as 8 (the discriminator) plus the serialized size of the struct.',
  AccountNotInitialized:
    'The program expected this account to exist and hold data, and it does not. Either it was ' +
    'never created, or it was closed, or the address passed is not the one the program derives. ' +
    'Create it before this instruction, or use init_if_needed if creation belongs here.',
  AccountDiscriminatorMismatch:
    'The first 8 bytes of the account do not match the type the handler declares. The account ' +
    'exists and belongs to this program, but it is a different account type than expected — ' +
    'usually two similar accounts passed in the wrong positions.',
  AccountDiscriminatorNotFound:
    'The account has no discriminator: it is either empty or shorter than 8 bytes, so it was ' +
    'never initialized as an Anchor account.',
  AccountOwnedByWrongProgram:
    'The account exists but a different program owns it, so this program cannot deserialize it. ' +
    'Check for a token account passed where a program state account was expected, or an address ' +
    'derived under the wrong program id.',
  AccountNotSystemOwned:
    'The account being initialized is already owned by a program, so it cannot be allocated ' +
    'again. It has been initialized once already.',
  AccountDidNotSerialize:
    'The account data could not be written back. Almost always the account is too small for the ' +
    'current struct: a field was added without raising the space in the init constraint, and ' +
    'existing accounts were never migrated.',
  AccountDidNotDeserialize:
    'The account data could not be read into the declared type. The on-chain layout and the ' +
    'struct in the source have diverged — typically an account written by an older version of ' +
    'the program.',
  AccountNotEnoughKeys:
    'The instruction expects more accounts than the transaction supplied. The client is building ' +
    'the account list from a different version of the IDL.',
  RequireViolated:
    'A require! expression in the handler body was false. The condition is at the source location ' +
    'reported above, when Anchor supplied one.',
  RequireEqViolated: 'A require_eq! comparison failed; the two operands are shown above.',
  RequireNeqViolated:
    'A require_neq! comparison failed: the two values were equal when they had to differ.',
  RequireKeysEqViolated:
    'A require_keys_eq! comparison failed. The two pubkeys above are what the program computed ' +
    'and what it was given; a mismatch here is usually a derivation done with different inputs ' +
    'on the client.',
  RequireKeysNeqViolated:
    'A require_keys_neq! comparison failed: the two pubkeys were the same account.',
  RequireGtViolated:
    'A require_gt! comparison failed; the left operand was not greater than the right.',
  RequireGteViolated:
    'A require_gte! comparison failed; the left operand was below the right. In swap and lending ' +
    'programs this is the usual shape of a slippage check.',
  InstructionDidNotDeserialize:
    'The instruction data did not decode into the handler arguments. The client and the program ' +
    'were built against different versions of the interface.',
  InstructionFallbackNotFound:
    'No handler matched the 8-byte discriminator in the instruction data, and the program has no ' +
    'fallback. The client is calling an instruction this deployment does not have.',
  DeclaredProgramIdMismatch:
    'The address the program is deployed at differs from the one in its declare_id!. The binary ' +
    'was built for a different program id than it is running under.',
};

/**
 * A note on what the operand pair means, given the failed check.
 *
 * `Left` and `Right` are Anchor's own labels and say nothing about which is
 * expected and which is actual, so the wording stays neutral rather than
 * inventing a direction the logs do not establish.
 */
function describeComparison(comparison: Comparison): string {
  return (
    `The comparison that failed had left = ${comparison.left} and right = ${comparison.right}. ` +
    'Anchor logs the operands in the order they appear in the source expression.'
  );
}

export function explainAnchor(error: AnchorError, comparison: Comparison | null): string {
  const parts: string[] = [];

  const known = ANCHOR_EXPLANATIONS[error.name];
  if (known !== undefined) {
    parts.push(known);
  } else if (error.number >= 6000) {
    parts.push(
      `${error.name} is an error the program declares itself, and the message above is the ` +
        'text its author wrote for it. What it means is specific to this program; the condition ' +
        'that raised it is at the source location reported above, when Anchor supplied one.',
    );
  } else {
    parts.push(
      `${error.name} is a built-in Anchor error. The message above is Anchor's own description ` +
        'of the check that failed.',
    );
  }

  if (error.account !== null) {
    parts.push(
      `Anchor attributed the failure to the \`${error.account}\` field of the handler's accounts ` +
        'struct, so the check that failed is one of the attributes on that field.',
    );
  }

  if (comparison !== null) parts.push(describeComparison(comparison));

  return parts.join(' ');
}

/** Whether a name is one this tier has advice for, used to keep the corpus honest about coverage. */
export function hasAnchorExplanation(name: string): boolean {
  return name in ANCHOR_EXPLANATIONS;
}
