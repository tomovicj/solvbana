import Fastify, { type FastifyError } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createTransactionSource, type TransactionSource } from '@solvbana/core';
import type { AppConfig } from './config.ts';
import { errorBody } from './schemas/error.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerDiagnoseRoutes } from './routes/diagnose.ts';

export interface BuildAppOptions {
  /**
   * Override the RPC source. Tests pass a recorded fixture so the suite runs
   * offline and deterministically; production leaves this unset.
   */
  source?: TransactionSource;
}

/**
 * Build a fully configured server without binding a port.
 *
 * Tests drive this through `app.inject()`, so they neither listen nor race on
 * ports. `listen` lives in `index.ts` and nowhere else.
 */
export function buildApp(config: AppConfig, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    // Schema validation failures are the client's problem and safe to echo;
    // anything 500 gets logged in full and reported opaquely.
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      void reply.code(status).send(errorBody('internal_error', 'Internal server error.'));
      return;
    }

    const details = error.validation?.map(
      (issue) => `${issue.instancePath || '(body)'} ${issue.message ?? 'is invalid'}`,
    );
    void reply.code(status).send(errorBody(error.code ?? 'bad_request', error.message, details));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorBody('not_found', `Route ${request.method} ${request.url} not found.`));
  });

  const source =
    options.source ??
    createTransactionSource({
      rpcUrl: config.SOLANA_RPC_URL,
      archiveRpcUrl: config.SOLANA_ARCHIVE_RPC_URL,
    });

  registerHealthRoutes(app);
  registerDiagnoseRoutes(app, source);

  return app;
}

export type App = ReturnType<typeof buildApp>;

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}
