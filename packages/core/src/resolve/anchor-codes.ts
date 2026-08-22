import type { ResolvedIdl } from './idl.ts';

/**
 * Anchor's built-in `ErrorCode` variants — the codes the framework itself
 * returns, below the 6000 offset where a program's own declarations begin.
 *
 * **This table may only be consulted for a program with a resolved IDL**, which
 * is why the only exported reader takes one. Phase 1 deliberately refuses to
 * decode a bare `Custom(2012)` from the number alone: the reserved ranges are
 * Anchor's convention, the runtime enforces nothing, and any program at all may
 * return 2012 meaning something else entirely. Two Whirlpool fixtures in the
 * corpus do exactly that with no Anchor logging anywhere in the transaction.
 *
 * An IDL published at the Anchor-derived address is the missing evidence. Only an
 * Anchor program puts one there, so once it is fetched the convention demonstrably
 * applies and the table is a lookup rather than a guess. Making the IDL a required
 * argument keeps that condition impossible to forget.
 */
const ANCHOR_ERROR_CODES: Record<number, string> = {
  // Instruction errors.
  100: 'InstructionMissing',
  101: 'InstructionFallbackNotFound',
  102: 'InstructionDidNotDeserialize',
  103: 'InstructionDidNotSerialize',

  // IDL instruction errors.
  1000: 'IdlInstructionStub',
  1001: 'IdlInstructionInvalidProgram',
  1002: 'IdlAccountNotEmpty',

  // Event instruction errors.
  1500: 'EventInstructionStub',

  // Constraint errors.
  2000: 'ConstraintMut',
  2001: 'ConstraintHasOne',
  2002: 'ConstraintSigner',
  2003: 'ConstraintRaw',
  2004: 'ConstraintOwner',
  2005: 'ConstraintRentExempt',
  2006: 'ConstraintSeeds',
  2007: 'ConstraintExecutable',
  2008: 'ConstraintState',
  2009: 'ConstraintAssociated',
  2010: 'ConstraintAssociatedInit',
  2011: 'ConstraintClose',
  2012: 'ConstraintAddress',
  2013: 'ConstraintZero',
  2014: 'ConstraintTokenMint',
  2015: 'ConstraintTokenOwner',
  2016: 'ConstraintMintMintAuthority',
  2017: 'ConstraintMintFreezeAuthority',
  2018: 'ConstraintMintDecimals',
  2019: 'ConstraintSpace',
  2020: 'ConstraintAccountIsNone',
  2021: 'ConstraintTokenTokenProgram',
  2022: 'ConstraintMintTokenProgram',
  2023: 'ConstraintAssociatedTokenTokenProgram',
  2024: 'ConstraintMintGroupPointerExtension',
  2025: 'ConstraintMintGroupPointerExtensionAuthority',
  2026: 'ConstraintMintGroupPointerExtensionGroupAddress',
  2027: 'ConstraintMintGroupMemberPointerExtension',
  2028: 'ConstraintMintGroupMemberPointerExtensionAuthority',
  2029: 'ConstraintMintGroupMemberPointerExtensionMemberAddress',
  2030: 'ConstraintMintMetadataPointerExtension',
  2031: 'ConstraintMintMetadataPointerExtensionAuthority',
  2032: 'ConstraintMintMetadataPointerExtensionMetadataAddress',
  2033: 'ConstraintMintCloseAuthorityExtension',
  2034: 'ConstraintMintCloseAuthorityExtensionAuthority',
  2035: 'ConstraintMintPermanentDelegateExtension',
  2036: 'ConstraintMintPermanentDelegateExtensionDelegate',
  2037: 'ConstraintMintTransferHookExtension',
  2038: 'ConstraintMintTransferHookExtensionAuthority',
  2039: 'ConstraintMintTransferHookExtensionProgramId',

  // `require_*!` macro violations. These sit inside the constraint band but are
  // raised from a handler body rather than from an `#[account(...)]` attribute.
  2500: 'RequireViolated',
  2501: 'RequireEqViolated',
  2502: 'RequireKeysEqViolated',
  2503: 'RequireNeqViolated',
  2504: 'RequireKeysNeqViolated',
  2505: 'RequireGtViolated',
  2506: 'RequireGteViolated',

  // Account errors.
  3000: 'AccountDiscriminatorAlreadySet',
  3001: 'AccountDiscriminatorNotFound',
  3002: 'AccountDiscriminatorMismatch',
  3003: 'AccountDidNotDeserialize',
  3004: 'AccountDidNotSerialize',
  3005: 'AccountNotEnoughKeys',
  3006: 'AccountNotMutable',
  3007: 'AccountOwnedByWrongProgram',
  3008: 'InvalidProgramId',
  3009: 'InvalidProgramExecutable',
  3010: 'AccountNotSigner',
  3011: 'AccountNotSystemOwned',
  3012: 'AccountNotInitialized',
  3013: 'AccountNotProgramData',
  3014: 'AccountNotAssociatedTokenAccount',
  3015: 'AccountSysvarMismatch',
  3016: 'AccountReallocExceedsLimit',
  3017: 'AccountDuplicateReallocs',

  // Miscellaneous.
  4100: 'DeclaredProgramIdMismatch',
  4101: 'TryingToInitPayerAsProgramAccount',
  4102: 'InvalidNumericConversion',

  // Deprecated.
  5000: 'Deprecated',
};

/** Where a code sits in Anchor's reserved layout, which shapes how it is explained. */
export type AnchorCodeFamily =
  | 'instruction'
  | 'idl-instruction'
  | 'event-instruction'
  | 'constraint'
  | 'require'
  | 'account'
  | 'misc'
  | 'deprecated'
  | 'user';

export function anchorCodeFamily(code: number): AnchorCodeFamily | null {
  if (code >= 6000) return 'user';
  if (code >= 5000) return 'deprecated';
  if (code >= 4100 && code < 4200) return 'misc';
  if (code >= 3000 && code < 4000) return 'account';
  if (code >= 2500 && code < 2600) return 'require';
  if (code >= 2000 && code < 3000) return 'constraint';
  if (code >= 1500 && code < 1600) return 'event-instruction';
  if (code >= 1000 && code < 1100) return 'idl-instruction';
  if (code >= 100 && code < 200) return 'instruction';
  return null;
}

export interface AnchorBuiltin {
  name: string;
  family: AnchorCodeFamily;
}

/**
 * Name a built-in Anchor error code.
 *
 * Takes the resolved IDL it is licensed by rather than just the code, so the
 * proof that this program is Anchor cannot be left behind at a call site. The
 * IDL's contents are not consulted — its existence is the whole argument.
 *
 * Codes at or above 6000 are the program's own and are deliberately not answered
 * here; those come from the IDL's `errors[]`, and inventing a name for one the
 * IDL does not declare would be a guess again.
 */
export function anchorBuiltinFor(code: number, idl: ResolvedIdl): AnchorBuiltin | null {
  // A program is free to declare a code that collides with a built-in, and its
  // own declaration wins: the IDL came from this deployment, while the table is
  // generic to the framework. Yielding here keeps that true no matter which
  // order a caller consults the two in.
  // An uploaded document is not evidence the program is Anchor. The licence for
  // this table is that only an Anchor program publishes an IDL at its
  // Anchor-derived address, and that is a fact about chain state — anyone can
  // write JSON. A supplied IDL may still name codes it declares itself; it may
  // not lend Anchor's conventions to codes it does not.
  if (idl.provenance !== 'on-chain') return null;

  if (idl.errors.has(code)) return null;

  const name = ANCHOR_ERROR_CODES[code];
  const family = anchorCodeFamily(code);
  if (name === undefined || family === null || family === 'user') return null;
  return { name, family };
}

/** Whether a code falls in a band Anchor reserves, used only for explaining a miss. */
export function isAnchorReservedCode(code: number): boolean {
  const family = anchorCodeFamily(code);
  return family !== null && family !== 'user';
}
