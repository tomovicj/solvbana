import { diagnose, parseSignature, type TransactionSource } from '@solvbana/core';
import type { App } from '../app.ts';
import { DiagnoseBody, DiagnosisSchema, toDiagnosisWire } from '../schemas/diagnosis.ts';
import { ErrorResponse, errorBody } from '../schemas/error.ts';

export function registerDiagnoseRoutes(app: App, source: TransactionSource): void {
  app.post(
    '/diagnose',
    {
      schema: {
        body: DiagnoseBody,
        response: {
          200: DiagnosisSchema,
          400: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      // Reject malformed input before spending an RPC call on it.
      const parsed = parseSignature(request.body.signature);
      if (!parsed.ok) {
        return reply.code(400).send(errorBody(`invalid_signature.${parsed.code}`, parsed.message));
      }

      // Always returns a diagnosis, never throws for an undiagnosable input —
      // an opaque failure is reported as `unknown`, not as a server error.
      const diagnosis = await diagnose(parsed.signature, { source });
      return toDiagnosisWire(diagnosis);
    },
  );
}
