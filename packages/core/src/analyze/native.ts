/**
 * Error tables for programs whose address is pinned and whose error enum is
 * published.
 *
 * This is a lookup, not an inference. The failing program's address is read out
 * of the log stream, and these addresses are immutable and universally known, so
 * `Custom(3)` from `Tokenkeg…` is `InvalidMint` as a matter of that program's
 * published source. Contrast the Anchor error ranges, which are one framework's
 * convention: any program may return `Custom(2012)` meaning anything at all, so
 * no table is keyed on a code range anywhere in this tier.
 */

export interface NativeError {
  name: string;
  message: string;
}

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111';

/**
 * Programs with a static, published error table.
 *
 * Also consumed by `scripts/lib/classify.ts` when bucketing the fixture corpus,
 * so the two cannot drift apart.
 */
export const NATIVE_PROGRAM_IDS: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  STAKE_PROGRAM_ID,
  'Vote111111111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
]);

/** `spl_token::error::TokenError`, shared verbatim by Token-2022 for codes 0-18. */
const TOKEN_ERRORS: Record<number, NativeError> = {
  0: { name: 'NotRentExempt', message: 'Lamport balance below rent-exempt threshold.' },
  1: { name: 'InsufficientFunds', message: 'Insufficient funds for the operation.' },
  2: { name: 'InvalidMint', message: 'Invalid mint.' },
  3: { name: 'MintMismatch', message: 'Account not associated with this mint.' },
  4: { name: 'OwnerMismatch', message: 'Owner does not match.' },
  5: { name: 'FixedSupply', message: 'This token has a fixed supply.' },
  6: {
    name: 'AlreadyInUse',
    message: 'The account cannot be initialized because it is already in use.',
  },
  7: { name: 'InvalidNumberOfProvidedSigners', message: 'Invalid number of provided signers.' },
  8: { name: 'InvalidNumberOfRequiredSigners', message: 'Invalid number of required signers.' },
  9: { name: 'UninitializedState', message: 'State is not initialized.' },
  10: { name: 'NativeNotSupported', message: 'Instruction does not support native tokens.' },
  11: {
    name: 'NonNativeHasBalance',
    message: 'Non-native account can only be closed if its balance is zero.',
  },
  12: { name: 'InvalidInstruction', message: 'Invalid instruction.' },
  13: { name: 'InvalidState', message: 'State is invalid for the requested operation.' },
  14: { name: 'Overflow', message: 'Operation overflowed.' },
  15: {
    name: 'AuthorityTypeNotSupported',
    message: 'Account does not support specified authority type.',
  },
  16: { name: 'MintCannotFreeze', message: 'This token mint cannot freeze accounts.' },
  17: { name: 'AccountFrozen', message: 'Account is frozen; all account operations will fail.' },
  18: {
    name: 'MintDecimalsMismatch',
    message: 'Mint decimals mismatch between the client and mint.',
  },
  19: { name: 'NonNativeNotSupported', message: 'Instruction does not support non-native tokens.' },
};

/** `solana_program::system_instruction::SystemError`. */
const SYSTEM_ERRORS: Record<number, NativeError> = {
  0: { name: 'AccountAlreadyInUse', message: 'An account with the same address already exists.' },
  1: {
    name: 'ResultWithNegativeLamports',
    message: 'Account does not have enough lamports for the transfer.',
  },
  2: { name: 'InvalidProgramId', message: 'Cannot assign account to this program id.' },
  3: { name: 'InvalidAccountDataLength', message: 'Cannot allocate account data of this length.' },
  4: {
    name: 'MaxSeedLengthExceeded',
    message: 'Length of requested seed is longer than the 32-byte maximum.',
  },
  5: {
    name: 'AddressWithSeedMismatch',
    message: 'Provided address does not match the derived address.',
  },
  6: {
    name: 'NonceNoRecentBlockhashes',
    message: 'Advancing stored nonce requires a populated recent blockhash store.',
  },
  7: {
    name: 'NonceBlockhashNotExpired',
    message: 'Stored nonce is still in the recent blockhash store.',
  },
  8: {
    name: 'NonceUnexpectedBlockhashValue',
    message: 'Specified nonce does not match the stored nonce.',
  },
};

const TABLES: Record<string, Record<number, NativeError>> = {
  [TOKEN_PROGRAM_ID]: TOKEN_ERRORS,
  [TOKEN_2022_PROGRAM_ID]: TOKEN_ERRORS,
  [SYSTEM_PROGRAM_ID]: SYSTEM_ERRORS,
};

/** Whether this address is one of the pinned programs a table may be keyed on. */
export function isNativeProgram(programId: string | null): boolean {
  return programId !== null && NATIVE_PROGRAM_IDS.has(programId);
}

/** Look up a `Custom(code)` in the pinned program's published error enum. */
export function nativeError(programId: string | null, code: number): NativeError | null {
  if (programId === null) return null;
  return TABLES[programId]?.[code] ?? null;
}

/**
 * Plain-English account of the runtime's own `InstructionError` variants.
 *
 * These arrive already named in `meta.err` — the tier adds what the name means
 * and what to look at, which is the part a reader cannot get from an explorer.
 */
const RUNTIME_VARIANTS: Record<string, string> = {
  InvalidAccountData:
    'A program was handed an account whose contents are not what it expected — wrong ' +
    'discriminator, wrong owner program, or an account that has not been initialized. Check that ' +
    'the client is passing the accounts in the order the instruction declares them; a swapped ' +
    'pair produces exactly this.',
  InvalidAccountOwner: 'An account was owned by a different program than the instruction required.',
  InvalidInstructionData:
    'The program could not deserialize the instruction data it was given. Either the client ' +
    'encoded a different instruction than the program expects, or the two were built against ' +
    'different versions of the interface.',
  InvalidArgument:
    'The runtime rejected an argument before the program ran — commonly a malformed account ' +
    'reference or an instruction that names more accounts than the transaction supplies.',
  MissingRequiredSignature:
    'An account the instruction requires to sign did not sign. Either the client omitted a ' +
    'signer, or the program expected a PDA signature and the seeds passed to invoke_signed did ' +
    'not derive the account in question.',
  InsufficientFunds:
    'An account did not have the lamports the instruction required. For a transfer this is the ' +
    'source balance; for an account being created it is usually the rent-exempt minimum, which ' +
    'the payer must cover on top of the amount being moved.',
  AccountDataTooSmall:
    'An account was smaller than the data the program tried to write into it. The space ' +
    'requested at creation does not match the current layout of the type being serialized.',
  NotEnoughAccountKeys:
    'The instruction referenced more accounts than the transaction provided. The client is ' +
    'building the account list from a different version of the instruction definition.',
  IllegalOwner:
    'An account was owned by a program that is not permitted to own it for this operation. For ' +
    'associated token accounts this usually means the owner passed is itself a PDA of another ' +
    'program, which requires the idempotent creation path.',
  AccountBorrowFailed:
    'A program tried to borrow an account that was already mutably borrowed — usually the same ' +
    'account passed twice to one instruction, or a CPI made while a borrow is still live.',
  ProgramFailedToComplete:
    'The program stopped without returning a result. This is what the runtime reports for a ' +
    'panic, a compute exhaustion, or a memory violation; the log lines above say which.',
  ComputationalBudgetExceeded: 'The transaction ran out of compute units before finishing.',
  ExecutableAccountNotRentExempt:
    'A program account fell below the rent-exempt minimum and can no longer execute.',
  IncorrectProgramId:
    'An account the instruction requires to be owned by a particular program is owned by another ' +
    'one, or the instruction addressed the wrong program entirely. With the two token programs ' +
    'this is usually a mint created under Token-2022 being passed to the original SPL Token ' +
    'program, or the reverse — the client hard-codes one program id for both.',
  UnsupportedProgramId: 'The address invoked is not an executable program.',
  CallDepthExceeded: 'CPI nesting exceeded the runtime maximum of four levels.',
  MaxAccountsDataAllocationsExceeded:
    'The transaction allocated more account data than a single transaction is permitted to.',
  PrivilegeEscalation:
    'A CPI tried to pass more privilege than its caller held — marking an account as signer or ' +
    'writable when the outer instruction did not.',
  ReentrancyNotAllowed:
    'A program invoked itself, directly or through a cycle of CPIs. The runtime permits ' +
    'self-recursion only as the immediate callee.',
};

export function explainRuntimeVariant(variant: string): string | null {
  return RUNTIME_VARIANTS[variant] ?? null;
}
