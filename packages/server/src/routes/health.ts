import { Type } from '@sinclair/typebox';
import type { App } from '../app.ts';
import { VERSION } from '../version.ts';

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  version: Type.String(),
  uptimeSeconds: Type.Number(),
});

export function registerHealthRoutes(app: App): void {
  app.get(
    '/health',
    {
      schema: { response: { 200: HealthResponse } },
      // Open to unauthenticated probes, and not rate limited.
      config: { rateLimit: false },
    },
    () => ({
      status: 'ok' as const,
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
    }),
  );
}
