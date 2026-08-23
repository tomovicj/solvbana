import { Type, type Static } from '@sinclair/typebox';
import {
  CONFIDENCE_LEVELS,
  walkInstructions,
  type Deployment,
  type Diagnosis,
  type Explanation,
  type FailedTransaction,
  type Finding,
  type Resolution,
} from '@solvbana/core';

const ConfidenceSchema = Type.Union(CONFIDENCE_LEVELS.map((level) => Type.Literal(level)));

const SourceLocationSchema = Type.Object({
  file: Type.String(),
  line: Type.Integer(),
  column: Type.Optional(Type.Integer()),
});

const CandidateSiteSchema = Type.Object({
  location: SourceLocationSchema,
  rank: Type.Integer(),
  rationale: Type.String(),
});

const AccountKeySchema = Type.Object({
  index: Type.Integer(),
  address: Type.String(),
  source: Type.Union([
    Type.Literal('static'),
    Type.Literal('lookup-writable'),
    Type.Literal('lookup-readonly'),
  ]),
  signer: Type.Boolean(),
  writable: Type.Boolean(),
});

const AccountKeysSchema = Type.Object({
  keys: Type.Array(AccountKeySchema),
  unresolvedLookups: Type.Boolean(),
});

const InstructionErrorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('custom'), code: Type.Integer() }),
  Type.Object({ kind: Type.Literal('named'), name: Type.String() }),
  Type.Object({ kind: Type.Literal('borsh-io-error'), message: Type.String() }),
  Type.Object({ kind: Type.Literal('unrecognized'), raw: Type.Unknown() }),
]);

const TransactionErrorSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('instruction-error'),
    index: Type.Integer(),
    error: InstructionErrorSchema,
  }),
  Type.Object({ kind: Type.Literal('insufficient-funds-for-rent'), accountIndex: Type.Integer() }),
  Type.Object({
    kind: Type.Literal('program-execution-temporarily-restricted'),
    accountIndex: Type.Integer(),
  }),
  Type.Object({ kind: Type.Literal('duplicate-instruction'), index: Type.Integer() }),
  Type.Object({ kind: Type.Literal('simple'), name: Type.String() }),
  Type.Object({ kind: Type.Literal('unrecognized'), raw: Type.Unknown() }),
]);

/**
 * Instructions are flattened for the wire, in depth-first order.
 *
 * Core keeps the nested tree because Phase 3's reachability and CPI-progress
 * filters walk it, but a recursive JSON schema is awkward for both ajv and
 * `fast-json-stringify`. `stackHeight` carries the depth, so the tree is
 * reconstructible from this list without one.
 */
const InstructionSchema = Type.Object({
  outerIndex: Type.Integer(),
  stackHeight: Type.Integer(),
  programIdIndex: Type.Integer(),
  programId: Type.Union([Type.String(), Type.Null()]),
  accountIndexes: Type.Array(Type.Integer()),
  data: Type.String(),
  cpiDepthUnavailable: Type.Boolean(),
});

const LogEventSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('invoke'),
    programId: Type.String(),
    depth: Type.Integer(),
  }),
  Type.Object({ kind: Type.Literal('success'), programId: Type.String() }),
  Type.Object({
    kind: Type.Literal('failed'),
    programId: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('log'), message: Type.String() }),
  Type.Object({ kind: Type.Literal('data'), base64: Type.String() }),
  Type.Object({
    kind: Type.Literal('return'),
    programId: Type.String(),
    base64: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('consumed'),
    programId: Type.String(),
    units: Type.Integer(),
    budget: Type.Integer(),
  }),
  Type.Object({ kind: Type.Literal('truncated') }),
  Type.Object({ kind: Type.Literal('unparsed') }),
]);

const LogStreamSchema = Type.Object({
  truncated: Type.Boolean(),
  absent: Type.Boolean(),
  lines: Type.Array(
    Type.Object({
      index: Type.Integer(),
      raw: Type.String(),
      event: LogEventSchema,
      outerIndex: Type.Union([Type.Integer(), Type.Null()]),
    }),
  ),
});

/** Slot, blockTime, fee and compute units are `bigint` in core; JSON has no bigint. */
const LamportBalanceSchema = Type.Object({
  index: Type.Integer(),
  pre: Type.String(),
  post: Type.String(),
});

const TokenBalanceSchema = Type.Object({
  index: Type.Integer(),
  mint: Type.String(),
  owner: Type.Union([Type.String(), Type.Null()]),
  tokenProgram: Type.Union([Type.String(), Type.Null()]),
  decimals: Type.Integer(),
  pre: Type.Union([Type.String(), Type.Null()]),
  post: Type.Union([Type.String(), Type.Null()]),
});

const FailedTransactionSchema = Type.Object({
  signature: Type.String(),
  slot: Type.String(),
  blockTime: Type.Union([Type.String(), Type.Null()]),
  version: Type.Union([Type.Literal('legacy'), Type.Integer()]),
  fee: Type.String(),
  computeUnitsConsumed: Type.Union([Type.String(), Type.Null()]),
  accounts: AccountKeysSchema,
  error: TransactionErrorSchema,
  instructions: Type.Array(InstructionSchema),
  innerInstructionsRecorded: Type.Boolean(),
  lamports: Type.Array(LamportBalanceSchema),
  tokenBalances: Type.Array(TokenBalanceSchema),
  logs: LogStreamSchema,
  degradations: Type.Array(Type.String()),
});

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableInteger = Type.Union([Type.Integer(), Type.Null()]);

/**
 * `naming` is the provenance of `name` and `message`, and it ships on the wire
 * for the same reason it exists in core: a consumer has to be able to tell an
 * error the program published from one looked up in a built-in table.
 */
const DecodedErrorSchema = Type.Object({
  code: NullableInteger,
  name: NullableString,
  message: NullableString,
  naming: Type.Union([
    Type.Literal('logged'),
    Type.Literal('native-table'),
    Type.Literal('runtime-variant'),
    Type.Literal('idl'),
    Type.Literal('supplied-idl'),
    Type.Literal('anchor-builtin'),
    Type.Literal('none'),
  ]),
});

const ComparisonSchema = Type.Object({ left: Type.String(), right: Type.String() });

const FailureKindSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('anchor'),
    account: NullableString,
    site: Type.Union([SourceLocationSchema, Type.Null()]),
    comparison: Type.Union([ComparisonSchema, Type.Null()]),
  }),
  Type.Object({
    kind: Type.Literal('panic'),
    site: SourceLocationSchema,
    message: Type.String(),
    classification: Type.Union(
      [
        'arithmetic-overflow',
        'divide-by-zero',
        'index-out-of-bounds',
        'slice-out-of-range',
        'unwrap-none',
        'unwrap-err',
        'explicit-panic',
        'unclassified',
      ].map((value) => Type.Literal(value)),
    ),
  }),
  Type.Object({
    kind: Type.Literal('compute'),
    scope: Type.Union([
      Type.Literal('frame'),
      Type.Literal('transaction'),
      Type.Literal('stack-frame'),
    ]),
    consumed: NullableInteger,
    budget: NullableInteger,
    requestedLimit: NullableInteger,
    stackFrame: NullableInteger,
  }),
  Type.Object({ kind: Type.Literal('native'), programId: Type.String() }),
  Type.Object({ kind: Type.Literal('runtime'), variant: Type.String() }),
  Type.Object({ kind: Type.Literal('undecoded') }),
]);

/** Slot values are `bigint` in core and cross the wire as strings, as elsewhere. */
const DeploymentSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('live'),
    programData: Type.String(),
    lastDeploySlot: Type.String(),
    programDataSize: Type.Integer(),
    readAtSlot: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('immutable'), loader: Type.String() }),
  Type.Object({
    kind: Type.Literal('upgraded-since'),
    lastDeploySlot: Type.String(),
    failingSlot: Type.String(),
    programData: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('closed'), programData: Type.String() }),
  Type.Object({ kind: Type.Literal('unavailable'), reason: Type.String() }),
]);

const VerificationSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('verified'),
    build: Type.Object({
      repoUrl: Type.String(),
      commit: Type.String(),
      hash: Type.String(),
      lastVerifiedAt: NullableString,
    }),
  }),
  Type.Object({
    kind: Type.Literal('unverified'),
    reason: Type.String(),
    candidate: Type.Union([
      Type.Object({
        repoUrl: Type.String(),
        commit: Type.String(),
        hash: Type.String(),
        registryOnChainHash: NullableString,
        lastVerifiedAt: NullableString,
      }),
      Type.Null(),
    ]),
  }),
  Type.Object({ kind: Type.Literal('not-applicable'), reason: Type.String() }),
  Type.Object({ kind: Type.Literal('unavailable'), reason: Type.String() }),
]);

const ResolutionSchema = Type.Object({
  programId: Type.String(),
  deployment: DeploymentSchema,
  idl: Type.Union([
    Type.Object({
      address: Type.String(),
      provenance: Type.Union([Type.Literal('on-chain'), Type.Literal('supplied')]),
      programName: Type.String(),
      spec: NullableString,
      declaredErrors: Type.Integer(),
      handlers: Type.Integer(),
    }),
    Type.Null(),
  ]),
  verification: Type.Union([VerificationSchema, Type.Null()]),
  notes: Type.Array(Type.String()),
});

const FindingSchema = Type.Object({
  program: NullableString,
  programSource: Type.Union([Type.Literal('logs'), Type.Literal('instruction-index'), Type.Null()]),
  handler: NullableString,
  handlerSource: Type.Union([Type.Literal('logged'), Type.Literal('discriminator'), Type.Null()]),
  error: DecodedErrorSchema,
  failure: FailureKindSchema,
  explanation: Type.String(),
  resolution: Type.Optional(ResolutionSchema),
});

const NullableBigIntString = Type.Union([Type.String(), Type.Null()]);

const TokenSummarySchema = Type.Object({
  mint: Type.String(),
  owner: Type.Union([Type.String(), Type.Null()]),
  tokenProgram: Type.Union([Type.String(), Type.Null()]),
  decimals: Type.Integer(),
  pre: NullableBigIntString,
  post: NullableBigIntString,
});

const AccountRowSchema = Type.Object({
  position: Type.Integer(),
  index: Type.Integer(),
  address: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()]),
  signer: Type.Boolean(),
  writable: Type.Boolean(),
  origin: Type.Union([
    Type.Literal('static'),
    Type.Literal('lookup-writable'),
    Type.Literal('lookup-readonly'),
    Type.Null(),
  ]),
  lamports: Type.Union([Type.Object({ pre: Type.String(), post: Type.String() }), Type.Null()]),
  existedBefore: Type.Union([Type.Boolean(), Type.Null()]),
  token: Type.Union([TokenSummarySchema, Type.Null()]),
});

const ResolvedSeedSchema = Type.Object({
  kind: Type.Union([Type.Literal('const'), Type.Literal('account'), Type.Literal('arg')]),
  source: Type.String(),
  bytes: Type.Union([Type.String(), Type.Null()]),
  text: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
});

const DerivationCheckSchema = Type.Object({
  account: Type.String(),
  position: Type.Union([Type.Integer(), Type.Null()]),
  actual: Type.Union([Type.String(), Type.Null()]),
  expected: Type.Union([Type.String(), Type.Null()]),
  bump: Type.Union([Type.Integer(), Type.Null()]),
  programId: Type.String(),
  seeds: Type.Array(ResolvedSeedSchema),
  status: Type.Union([
    Type.Literal('match'),
    Type.Literal('mismatch'),
    Type.Literal('unresolved'),
    Type.Literal('not-derivable'),
  ]),
  source: Type.Union([Type.Literal('idl-pda'), Type.Literal('associated-token')]),
  blockedBy: Type.Union([Type.String(), Type.Null()]),
  searched: Type.Union([Type.String(), Type.Null()]),
});

const DecodedArgSchema = Type.Object({
  name: Type.String(),
  type: Type.String(),
  value: Type.Union([Type.String(), Type.Null()]),
});

const ComputeBreakdownSchema = Type.Object({
  total: NullableBigIntString,
  requestedLimit: Type.Union([Type.Integer(), Type.Null()]),
  frames: Type.Array(
    Type.Object({
      programId: Type.String(),
      depth: Type.Integer(),
      consumed: Type.Union([Type.Integer(), Type.Null()]),
      budget: Type.Union([Type.Integer(), Type.Null()]),
      failing: Type.Boolean(),
    }),
  ),
});

const BalanceDeltasSchema = Type.Object({
  lamports: Type.Array(
    Type.Object({
      index: Type.Integer(),
      address: Type.Union([Type.String(), Type.Null()]),
      pre: Type.String(),
      post: Type.String(),
      delta: Type.String(),
    }),
  ),
  tokens: Type.Array(
    Type.Object({
      index: Type.Integer(),
      address: Type.Union([Type.String(), Type.Null()]),
      mint: Type.String(),
      owner: Type.Union([Type.String(), Type.Null()]),
      decimals: Type.Integer(),
      pre: NullableBigIntString,
      post: NullableBigIntString,
      delta: NullableBigIntString,
    }),
  ),
  fee: Type.String(),
});

const GuidanceSchema = Type.Object({
  meaning: Type.String(),
  causes: Type.Array(Type.String()),
  fix: Type.Union([Type.String(), Type.Null()]),
});

/**
 * The operand pair, read against the record.
 *
 * `difference` crosses as a string for the same reason every other amount here
 * does: it is a `bigint` in core because Anchor prints `u64` values, and JSON has
 * no bigint. `relative` is a genuine fraction and stays a number.
 */
const ReadComparisonSchema = Type.Object({
  left: Type.String(),
  right: Type.String(),
  passed: Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Null()]),
  account: Type.Union([Type.String(), Type.Null()]),
  numeric: Type.Union([
    Type.Object({
      difference: Type.String(),
      equal: Type.Boolean(),
      relative: Type.Union([Type.Number(), Type.Null()]),
    }),
    Type.Null(),
  ]),
});

const ExplanationSchema = Type.Object({
  accounts: Type.Array(AccountRowSchema),
  args: Type.Union([Type.Array(DecodedArgSchema), Type.Null()]),
  derivations: Type.Array(DerivationCheckSchema),
  compute: Type.Union([ComputeBreakdownSchema, Type.Null()]),
  deltas: BalanceDeltasSchema,
  comparison: Type.Union([ReadComparisonSchema, Type.Null()]),
  guidance: GuidanceSchema,
  notes: Type.Array(Type.String()),
});

export const DiagnosisSchema = Type.Object({
  signature: Type.String(),
  confidence: ConfidenceSchema,
  summary: Type.String(),
  candidates: Type.Array(CandidateSiteSchema),
  reasons: Type.Array(Type.String()),
  transaction: Type.Optional(FailedTransactionSchema),
  finding: Type.Optional(FindingSchema),
  explanation: Type.Optional(ExplanationSchema),
});

export const DiagnoseBody = Type.Object(
  {
    signature: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type DiagnoseBody = Static<typeof DiagnoseBody>;

export type DiagnosisWire = Static<typeof DiagnosisSchema>;
export type FailedTransactionWire = Static<typeof FailedTransactionSchema>;
export type FindingWire = Static<typeof FindingSchema>;
export type ExplanationWire = Static<typeof ExplanationSchema>;

/**
 * Compile-time guard: the wire schema drives response serialization, so if core
 * grows a field the schema does not declare, Fastify would silently strip it.
 * On drift the annotation resolves to `never` and this assignment fails the build.
 *
 * Only key parity is checked here, not value types — the wire deliberately
 * narrows `bigint` to `string`. {@link toDiagnosisWire} covers the other
 * direction: it cannot compile without producing every field the schema declares.
 */
export const DIAGNOSIS_SCHEMA_COVERS_CORE: keyof Diagnosis extends keyof DiagnosisWire
  ? true
  : never = true;

export const TRANSACTION_SCHEMA_COVERS_CORE: keyof FailedTransaction extends keyof FailedTransactionWire
  ? true
  : never = true;

/**
 * The finding is the part Phase 4 renders from, so a field lost to schema drift
 * would silently remove an explanation rather than break anything visible here.
 * Unlike the two above, this checks the union members too: `FailureKind` gains a
 * member per failure category, and a category missing from the schema would be
 * stripped down to whatever keys the other members happen to share.
 */
export const FINDING_SCHEMA_COVERS_CORE: keyof Finding extends keyof FindingWire ? true : never =
  true;

export const FAILURE_KIND_SCHEMA_COVERS_CORE: Finding['failure']['kind'] extends FindingWire['failure']['kind']
  ? true
  : never = true;

/**
 * The error-naming provenance is the field a consumer uses to decide how much an
 * error name is worth, so a value missing from the schema would be serialized
 * away and read as `none` — a stronger claim silently downgraded, or an
 * unrecognized one passed through. Checked as its own guard because it grows
 * every time a new way of naming an error is added.
 */
export const ERROR_NAMING_SCHEMA_COVERS_CORE: Finding['error']['naming'] extends FindingWire['error']['naming']
  ? true
  : never = true;

export const RESOLUTION_SCHEMA_COVERS_CORE: keyof Resolution extends keyof NonNullable<
  FindingWire['resolution']
>
  ? true
  : never = true;

export const DEPLOYMENT_SCHEMA_COVERS_CORE: Deployment['kind'] extends NonNullable<
  FindingWire['resolution']
>['deployment']['kind']
  ? true
  : never = true;

/**
 * The explanation is the largest structure on the wire and the one a consumer
 * renders directly, so a member lost to drift would silently remove a whole
 * section — an unnamed account, a derivation that never appears — without
 * breaking anything visible here. The derivation status is checked separately
 * because it grows every time a new kind of check is added, and a missing member
 * would serialize away into a status the reader cannot distinguish from "not
 * checked".
 */
export const EXPLANATION_SCHEMA_COVERS_CORE: keyof Explanation extends keyof ExplanationWire
  ? true
  : never = true;

export const DERIVATION_STATUS_SCHEMA_COVERS_CORE: Explanation['derivations'][number]['status'] extends ExplanationWire['derivations'][number]['status']
  ? true
  : never = true;

type VerificationWire = Static<typeof VerificationSchema>;
type VerificationCore = NonNullable<Resolution['verification']>;

/**
 * Key parity per union member, because `keyof` on a union sees only the keys its
 * members share — so a field added to one variant slips past a whole-type guard
 * and is silently stripped on the wire. `unverified` grew a `candidate` exactly
 * that way.
 */
export const VERIFICATION_VERIFIED_SCHEMA_COVERS_CORE: keyof Extract<
  VerificationCore,
  { kind: 'verified' }
> extends keyof Extract<VerificationWire, { kind: 'verified' }>
  ? true
  : never = true;

export const VERIFICATION_UNVERIFIED_SCHEMA_COVERS_CORE: keyof Extract<
  VerificationCore,
  { kind: 'unverified' }
> extends keyof Extract<VerificationWire, { kind: 'unverified' }>
  ? true
  : never = true;

function toTransactionWire(transaction: FailedTransaction): FailedTransactionWire {
  return {
    signature: transaction.signature,
    slot: String(transaction.slot),
    blockTime: transaction.blockTime === null ? null : String(transaction.blockTime),
    version: transaction.version,
    fee: String(transaction.fee),
    computeUnitsConsumed:
      transaction.computeUnitsConsumed === null ? null : String(transaction.computeUnitsConsumed),
    accounts: transaction.accounts,
    error: transaction.error,
    instructions: [...walkInstructions(transaction.instructions)].map((node) => ({
      outerIndex: node.outerIndex,
      stackHeight: node.stackHeight,
      programIdIndex: node.programIdIndex,
      programId: node.programId,
      accountIndexes: node.accountIndexes,
      data: node.data,
      cpiDepthUnavailable: node.cpiDepthUnavailable,
    })),
    innerInstructionsRecorded: transaction.innerInstructionsRecorded,
    lamports: transaction.lamports.map((row) => ({
      index: row.index,
      pre: String(row.pre),
      post: String(row.post),
    })),
    tokenBalances: transaction.tokenBalances.map((row) => ({
      index: row.index,
      mint: row.mint,
      owner: row.owner,
      tokenProgram: row.tokenProgram,
      decimals: row.decimals,
      pre: row.pre === null ? null : String(row.pre),
      post: row.post === null ? null : String(row.post),
    })),
    logs: transaction.logs,
    degradations: transaction.degradations,
  };
}

/**
 * Convert an explanation into its wire representation.
 *
 * Every `bigint` narrows to a decimal string, as everywhere else here, because
 * JSON has no bigint and a lamport or token amount can exceed `Number`.
 */
function toExplanationWire(explanation: Explanation): ExplanationWire {
  const optional = (value: bigint | null): string | null => (value === null ? null : String(value));

  return {
    accounts: explanation.accounts.map((row) => ({
      position: row.position,
      index: row.index,
      address: row.address,
      name: row.name,
      signer: row.signer,
      writable: row.writable,
      origin: row.origin,
      lamports:
        row.lamports === null
          ? null
          : { pre: String(row.lamports.pre), post: String(row.lamports.post) },
      existedBefore: row.existedBefore,
      token:
        row.token === null
          ? null
          : {
              mint: row.token.mint,
              owner: row.token.owner,
              tokenProgram: row.token.tokenProgram,
              decimals: row.token.decimals,
              pre: optional(row.token.pre),
              post: optional(row.token.post),
            },
    })),
    args: explanation.args,
    derivations: explanation.derivations,
    compute:
      explanation.compute === null
        ? null
        : {
            total: optional(explanation.compute.total),
            requestedLimit: explanation.compute.requestedLimit,
            frames: explanation.compute.frames,
          },
    deltas: {
      lamports: explanation.deltas.lamports.map((row) => ({
        index: row.index,
        address: row.address,
        pre: String(row.pre),
        post: String(row.post),
        delta: String(row.delta),
      })),
      tokens: explanation.deltas.tokens.map((row) => ({
        index: row.index,
        address: row.address,
        mint: row.mint,
        owner: row.owner,
        decimals: row.decimals,
        pre: optional(row.pre),
        post: optional(row.post),
        delta: optional(row.delta),
      })),
      fee: String(explanation.deltas.fee),
    },
    comparison:
      explanation.comparison === null
        ? null
        : {
            ...explanation.comparison,
            numeric:
              explanation.comparison.numeric === null
                ? null
                : {
                    ...explanation.comparison.numeric,
                    difference: String(explanation.comparison.numeric.difference),
                  },
          },
    guidance: explanation.guidance,
    notes: explanation.notes,
  };
}

/** Convert a core diagnosis into its wire representation. */
export function toDiagnosisWire(diagnosis: Diagnosis): DiagnosisWire {
  return {
    signature: diagnosis.signature,
    confidence: diagnosis.confidence,
    summary: diagnosis.summary,
    candidates: diagnosis.candidates,
    reasons: diagnosis.reasons,
    ...(diagnosis.transaction === undefined
      ? {}
      : { transaction: toTransactionWire(diagnosis.transaction) }),
    ...(diagnosis.finding === undefined ? {} : { finding: toFindingWire(diagnosis.finding) }),
    ...(diagnosis.explanation === undefined
      ? {}
      : { explanation: toExplanationWire(diagnosis.explanation) }),
  };
}

type ResolutionWire = NonNullable<FindingWire['resolution']>;

/** Deployment slots are `bigint` in core; JSON has none, so they cross as strings. */
function toDeploymentWire(deployment: Deployment): ResolutionWire['deployment'] {
  switch (deployment.kind) {
    case 'live':
      return {
        kind: 'live',
        programData: deployment.programData,
        lastDeploySlot: String(deployment.lastDeploySlot),
        programDataSize: deployment.programDataSize,
        readAtSlot: String(deployment.readAtSlot),
      };
    case 'immutable':
      return { kind: 'immutable', loader: deployment.loader };
    case 'upgraded-since':
      return {
        kind: 'upgraded-since',
        lastDeploySlot: String(deployment.lastDeploySlot),
        failingSlot: String(deployment.failingSlot),
        programData: deployment.programData,
      };
    case 'closed':
      return { kind: 'closed', programData: deployment.programData };
    case 'unavailable':
      return { kind: 'unavailable', reason: deployment.reason };
  }
}

function toResolutionWire(resolution: Resolution): ResolutionWire {
  return {
    programId: resolution.programId,
    deployment: toDeploymentWire(resolution.deployment),
    idl: resolution.idl,
    verification: resolution.verification,
    notes: resolution.notes,
  };
}

function toFindingWire(finding: Finding): FindingWire {
  return {
    program: finding.program,
    programSource: finding.programSource,
    handler: finding.handler,
    handlerSource: finding.handlerSource,
    error: finding.error,
    failure: finding.failure,
    explanation: finding.explanation,
    ...(finding.resolution === undefined
      ? {}
      : { resolution: toResolutionWire(finding.resolution) }),
  };
}
