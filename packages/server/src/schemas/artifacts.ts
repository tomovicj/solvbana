import { Type, type Static } from '@sinclair/typebox';

/**
 * An artifact upload.
 *
 * Both fields are optional so a developer can send whichever they have — an IDL
 * alone names error codes, a binary alone answers "is my build the one that is
 * deployed" — but a request carrying neither is refused rather than accepted as
 * a no-op.
 *
 * The binary is base64 inside JSON rather than multipart. That keeps one content
 * type across the API and avoids a multipart dependency, at the cost of a third
 * again in size on a file that reaches about 1.5MB; `SOLVBANA_MAX_BODY_BYTES`
 * is sized for it.
 */
export const ArtifactsBody = Type.Object(
  {
    /**
     * The program these artifacts belong to.
     *
     * Optional because every Anchor 0.30+ IDL carries a top-level `address`
     * naming its own program, and every pre-0.30 IDL omits it — the same layout
     * split source resolution already handles. Required for the older layout,
     * and for a binary uploaded on its own.
     */
    programId: Type.Optional(Type.String({ minLength: 1 })),
    /** The IDL document itself, as JSON. */
    idl: Type.Optional(Type.Unknown()),
    /** The compiled program, base64-encoded, exactly as `target/deploy/*.so` holds it. */
    binary: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type ArtifactsBody = Static<typeof ArtifactsBody>;

/**
 * What the upload established.
 *
 * `binary` is where "is my build the one that is deployed" gets answered, and
 * answering it here is deliberate: it is a question about current state with no
 * transaction involved, so settling it once at upload keeps a ten-megabyte
 * ProgramData read off the path of every later diagnosis.
 */
export const ArtifactsResponse = Type.Object({
  programId: Type.String(),
  idl: Type.Union([
    Type.Object({
      stored: Type.Literal(true),
      programName: Type.String(),
      declaredErrors: Type.Integer(),
      handlers: Type.Integer(),
    }),
    Type.Null(),
  ]),
  binary: Type.Union([
    Type.Object({
      stored: Type.Literal(true),
      /** The hash the binary was filed under — sha256 of its ELF, trailing zeros trimmed. */
      hash: Type.String(),
      bytes: Type.Integer(),
      /** Whether it is the binary currently deployed for this program. */
      deployed: Type.Union([
        Type.Object({ kind: Type.Literal('match') }),
        Type.Object({ kind: Type.Literal('mismatch'), deployedHash: Type.String() }),
        Type.Object({ kind: Type.Literal('unknown'), reason: Type.String() }),
      ]),
    }),
    Type.Null(),
  ]),
  notes: Type.Array(Type.String()),
});

export type ArtifactsResponse = Static<typeof ArtifactsResponse>;
