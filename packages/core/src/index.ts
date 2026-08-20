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
  parseSignature,
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
} from './analyze/types.ts';

export {
  anchorBuiltinFor,
  anchorCodeFamily,
  isAnchorReservedCode,
  type AnchorBuiltin,
  type AnchorCodeFamily,
} from './resolve/anchor-codes.ts';

export {
  describeDeployment,
  isSlotAccurate,
  lastDeploySlotOf,
  programDataAddressOf,
  resolveDeployment,
  BPF_LOADER_UPGRADEABLE,
  PROGRAM_DATA_HEADER_SIZE,
  type Deployment,
} from './resolve/deployment.ts';

export {
  decodeIdlAccount,
  deriveDiscriminator,
  handlerForDiscriminator,
  idlAddressFor,
  parseIdlDocument,
  resolveIdl,
  type IdlErrorEntry,
  type IdlHandler,
  type IdlOutcome,
  type ResolvedIdl,
} from './resolve/idl.ts';

export { refineWithResolution } from './resolve/refine.ts';

export {
  clearResolutionCache,
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
  LogEvent,
  LogLine,
  LogStream,
  RawTransaction,
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
  Endpoint,
  FetchOutcome,
  NotFoundReason,
  TransactionSource,
} from './rpc/source.ts';
