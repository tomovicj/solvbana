import { Type, type Static } from '@sinclair/typebox';
import {
  CONFIDENCE_LEVELS,
  walkInstructions,
  type Diagnosis,
  type FailedTransaction,
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
  logs: LogStreamSchema,
  degradations: Type.Array(Type.String()),
});

export const DiagnosisSchema = Type.Object({
  signature: Type.String(),
  confidence: ConfidenceSchema,
  summary: Type.String(),
  candidates: Type.Array(CandidateSiteSchema),
  reasons: Type.Array(Type.String()),
  transaction: Type.Optional(FailedTransactionSchema),
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
    logs: transaction.logs,
    degradations: transaction.degradations,
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
  };
}
