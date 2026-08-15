import { Type, type Static } from '@sinclair/typebox';
import { CONFIDENCE_LEVELS, type Diagnosis } from '@solvbana/core';

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

export const DiagnosisSchema = Type.Object({
  signature: Type.String(),
  confidence: ConfidenceSchema,
  summary: Type.String(),
  candidates: Type.Array(CandidateSiteSchema),
  reasons: Type.Array(Type.String()),
});

export const DiagnoseBody = Type.Object(
  {
    signature: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type DiagnoseBody = Static<typeof DiagnoseBody>;

export type DiagnosisWire = Static<typeof DiagnosisSchema>;

/**
 * Compile-time guard: the wire schema drives response serialization, so if it
 * drifts from the core type Fastify would silently strip fields. On drift the
 * annotation resolves to `never` and this assignment fails the build.
 */
export const DIAGNOSIS_SCHEMA_MATCHES_CORE: DiagnosisWire extends Diagnosis ? true : never = true;
