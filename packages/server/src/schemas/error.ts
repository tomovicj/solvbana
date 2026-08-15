import { Type, type Static } from '@sinclair/typebox';

/** One shape for every error the API returns, whatever produced it. */
export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Array(Type.String())),
  }),
});

export type ErrorResponse = Static<typeof ErrorResponse>;

export function errorBody(code: string, message: string, details?: string[]): ErrorResponse {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
