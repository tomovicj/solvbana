export {
  CONFIDENCE_LEVELS,
  capAt,
  isAtLeast,
  rank,
  weakest,
  type Confidence,
} from './confidence.ts';

export {
  unknownDiagnosis,
  type CandidateSite,
  type Diagnosis,
  type SourceLocation,
} from './diagnosis.ts';

export {
  decodeBase58,
  parseAddress,
  parseSignature,
  type AddressParseResult,
  type SignatureParseFailure,
  type SignatureParseResult,
} from './signature.ts';

export { diagnose, type DiagnoseDeps } from './diagnose.ts';

export { analyze, type Analysis } from './analyze/analyze.ts';

export {
  anchorErrorIn,
  comparisonIn,
  handlerIn,
  parseAnchorError,
  type AnchorError,
} from './analyze/anchor.ts';

export {
  computeFailureIn,
  explainCompute,
  requestedComputeLimit,
  COMPUTE_BUDGET_PROGRAM_ID,
  type ComputeFailure,
} from './analyze/compute.ts';

export { explainAnchor, hasAnchorExplanation } from './analyze/explain.ts';

export {
  attributedFrame,
  buildFrames,
  failingFrame,
  frameChain,
  unterminatedFrame,
  type Frame,
  type FrameOutcome,
} from './analyze/frames.ts';

export {
  explainRuntimeVariant,
  isNativeProgram,
  nativeError,
  NATIVE_PROGRAM_IDS,
  type NativeError,
} from './analyze/native.ts';

export { classifyPanic, explainPanic, panicIn, parsePanic, type Panic } from './analyze/panic.ts';

export type {
  Comparison,
  ComputeScope,
  DecodedError,
  ErrorNaming,
  FailureKind,
  Finding,
  HandlerSource,
  PanicClass,
  ProgramSource,
} from './analyze/types.ts';

export {
  anchorBuiltinFor,
  anchorCodeFamily,
  isAnchorReservedCode,
  type AnchorBuiltin,
  type AnchorCodeFamily,
} from './resolve/anchor-codes.ts';

export {
  currentDeployment,
  describeDeployment,
  isSlotAccurate,
  lastDeploySlotOf,
  programDataAddressOf,
  resolveDeployment,
  BPF_LOADER_UPGRADEABLE,
  PROGRAM_DATA_HEADER_SIZE,
  type CurrentDeployment,
  type Deployment,
} from './resolve/deployment.ts';

export {
  decodeIdlAccount,
  deriveDiscriminator,
  handlerForDiscriminator,
  idlAddressFor,
  parseIdlDocument,
  resolveIdl,
  type IdlAccountSpec,
  type IdlArg,
  type IdlErrorEntry,
  type IdlHandler,
  type IdlOutcome,
  type IdlProvenance,
  type IdlSeed,
  type ResolvedIdl,
} from './resolve/idl.ts';

export { elfHash } from './resolve/hash.ts';

export { describeSuppliedIdl, suppliedIdl, type SuppliedIdlOutcome } from './resolve/local.ts';

export { refineWithResolution } from './resolve/refine.ts';

export { explainFailure, failingInstructionNode } from './explain/explain.ts';
export { accountTable, nameableCount } from './explain/accounts.ts';
export { decodeArgs, describeType } from './explain/args.ts';
export { computeBreakdown } from './explain/compute.ts';
export { balanceDeltas } from './explain/deltas.ts';
export { passedSide, readComparison, requiredSide } from './explain/comparison.ts';
export {
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  associatedTokenAddress,
  checkAssociatedToken,
  checkIdlPdas,
} from './explain/derive.ts';
export { buildGuidance } from './explain/guidance.ts';
export type {
  AccountRow,
  BalanceDeltas,
  ComputeBreakdown,
  ComputeFrame,
  DecodedArg,
  DerivationCheck,
  DerivationSource,
  DerivationStatus,
  Explanation,
  Guidance,
  LamportDelta,
  ReadComparison,
  ResolvedSeed,
  TokenDelta,
  TokenSummary,
} from './explain/types.ts';

export {
  clearResolutionCache,
  forgetProgram,
  resolveProgram,
  type ResolveDeps,
  type ResolveOptions,
  type ResolutionResult,
} from './resolve/resolve.ts';

export type { IdlSummary, Resolution } from './resolve/types.ts';

export {
  programHash,
  resolveVerifiedBuild,
  selectTrustworthyEntry,
  DEFAULT_VERIFY_REGISTRY_URL,
  type BuildCandidate,
  type VerificationOutcome,
  type VerifiedBuild,
  type VerifyOptions,
} from './resolve/verified.ts';

export {
  accountKeysFrom,
  addressAt,
  flattenAccountKeys,
  type FlattenInput,
} from './ingest/accounts.ts';

export {
  describeInstructionError,
  describeTransactionError,
  failingInstructionIndex,
  parseInstructionError,
  parseTransactionError,
} from './ingest/error.ts';

export {
  buildInstructionTree,
  instructionTreeFrom,
  walkInstructions,
  type InstructionTree,
  type RawInstruction,
} from './ingest/instructions.ts';

export { classifyLogLine, linesForInstruction, parseLogs } from './ingest/logs.ts';

export { normalizeTransaction } from './ingest/normalize.ts';

export { reviveRawTransaction } from './ingest/raw.ts';

export type {
  AccountKey,
  AccountKeys,
  AccountOrigin,
  FailedTransaction,
  InstructionError,
  InstructionNode,
  LamportBalance,
  LogEvent,
  LogLine,
  LogStream,
  RawTransaction,
  TokenBalance,
  TransactionError,
} from './ingest/types.ts';

export {
  createAccountSource,
  createTransactionSource,
  explainNotFound,
  type TransactionSourceConfig,
} from './rpc/client.ts';

export type {
  AccountSnapshot,
  AccountSource,
  ArtifactStore,
  Endpoint,
  FetchOutcome,
  NotFoundReason,
  TransactionSource,
} from './rpc/source.ts';
