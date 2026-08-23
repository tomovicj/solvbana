/**
 * Which `#[account(...)]` attribute raises which Anchor error.
 *
 * Anchor's constraint errors are *generated*, not thrown: nothing in a
 * developer's source says `require!(cond, ConstraintSeeds)`. The framework emits
 * the check from an attribute, so the way to find the failing declaration is to
 * map the error back to the keyword that produces it.
 *
 * Licensed the same way the native error tables are. The name comes from a line
 * the program printed about itself, or from a code decoded against an IDL
 * published at the Anchor-derived address — either way Anchor's identity is
 * established before this table is consulted, and the constraint-to-error
 * mapping is part of its published behaviour rather than a guess about one.
 *
 * The names are the same strings `resolve/anchor-codes.ts` already holds; this
 * keys off them rather than restating the code numbers, so the two cannot drift
 * into disagreeing about what 2006 is called.
 */
const ATTRIBUTE_FOR: Record<string, string> = {
  ConstraintMut: 'mut',
  ConstraintHasOne: 'has_one',
  ConstraintSigner: 'signer',
  ConstraintRaw: 'constraint',
  ConstraintOwner: 'owner',
  ConstraintRentExempt: 'rent_exempt',
  ConstraintSeeds: 'seeds',
  ConstraintExecutable: 'executable',
  ConstraintClose: 'close',
  ConstraintAddress: 'address',
  ConstraintZero: 'zero',
  ConstraintTokenMint: 'token::mint',
  ConstraintTokenOwner: 'token::authority',
  ConstraintTokenTokenProgram: 'token::token_program',
  ConstraintMintMintAuthority: 'mint::authority',
  ConstraintMintFreezeAuthority: 'mint::freeze_authority',
  ConstraintMintDecimals: 'mint::decimals',
  ConstraintMintTokenProgram: 'mint::token_program',
  ConstraintSpace: 'space',
  ConstraintAssociatedTokenTokenProgram: 'associated_token::token_program',
};

/**
 * The attribute keyword the named error comes from, or `null`.
 *
 * `null` covers the whole 3000 band — `AccountNotInitialized`,
 * `AccountOwnedByWrongProgram`, `AccountDiscriminatorMismatch` and the rest. No
 * attribute raises those: they come from the field's declared *type*, which
 * Anchor checks when it deserializes. The declaration is still worth reporting
 * for them, since it says what the program expected the account to be; there is
 * simply no single expression to point at within it.
 */
export function attributeFor(errorName: string): string | null {
  return ATTRIBUTE_FOR[errorName] ?? null;
}

/**
 * Whether this error is one Anchor generates from a declaration.
 *
 * Covers both bands, because both are attributable to a field rather than to a
 * line of handler body: the 2000s come from an attribute, the 3000s from the
 * declared type. A `bump` failure reports under `seeds`, since the two are one
 * declaration and Anchor raises `ConstraintSeeds` for both.
 */
export function isDeclarationError(errorName: string): boolean {
  return errorName.startsWith('Constraint') || errorName.startsWith('Account');
}
