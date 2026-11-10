import Fastify, { type FastifyError } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  createAccountSource,
  createTransactionSource,
  type AccountSource,
  type TransactionSource,
} from '@solvbana/core';
import rateLimit from '@fastify/rate-limit';
import type { WritableArtifactStore } from './artifacts/store.ts';
import { createTenantStores } from './artifacts/tenants.ts';
import { ANONYMOUS_TENANT, authenticate } from './auth.ts';
import { authenticationProblem, parseApiKeys, type AppConfig } from './config.ts';
import { errorBody } from './schemas/error.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerArtifactRoutes } from './routes/artifacts.ts';
import { registerDiagnoseRoutes } from './routes/diagnose.ts';

export interface BuildAppOptions {
  /**
   * Override the RPC source. Tests pass a recorded fixture so the suite runs
   * offline and deterministically; production leaves this unset.
   */
  source?: TransactionSource;
  /**
   * Override the account source used for source resolution.
   *
   * Left unset in a test, resolution simply does not run and the diagnosis is
   * whatever the logs alone established — which is the behaviour every test
   * written before Phase 2 already expects.
   */
  accounts?: AccountSource;
  /**
   * Override the artifact store: one store used for every tenant, or a function
   * choosing the store for a tenant.
   *
   * Tests pass an in-memory or temporary-directory store so the suite neither
   * touches a configured path nor leaves anything behind. Left unset with no
   * `SOLVBANA_ARTIFACT_DIR` configured, there is no store and uploads are
   * refused rather than silently discarded.
   */
  artifacts?: WritableArtifactStore | ((tenant: string) => WritableArtifactStore | undefined);
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
      // A request's headers can reach the log; the key must never.
      redact: ['req.headers.authorization', 'headers.authorization'],
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
    },
    bodyLimit: config.SOLVBANA_MAX_BODY_BYTES,
    // Off unless the operator says a proxy in front overwrites X-Forwarded-For.
    trustProxy: config.SOLVBANA_TRUST_PROXY,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);

  const parsedKeys = parseApiKeys(config.SOLVBANA_API_KEYS);
  if (!parsedKeys.ok) throw new Error(`Invalid SOLVBANA_API_KEYS: ${parsedKeys.errors.join('; ')}`);
  const keys = parsedKeys.keys;
  const open = keys.length === 0;
  const problem = authenticationProblem(keys.length, config.SOLVBANA_ALLOW_UNAUTHENTICATED);
  if (problem !== null) throw new Error(problem);
  if (open) {
    app.log.warn(
      `SOLVBANA_ALLOW_UNAUTHENTICATED is set and no API keys are configured: running WITHOUT authentication as the single tenant "${ANONYMOUS_TENANT}".`,
    );
  }

  // Empty means unauthenticated; no valid tenant name is empty.
  app.decorateRequest('tenant', '');

  // Identify first, reject later. The rate limiter runs as a route-level
  // onRequest hook, after this one, and keys on the tenant (or the client IP
  // when there is none) — so a failed guess is counted against its sender
  // instead of bypassing the limiter by being rejected too early. The 401 is
  // sent in preParsing, which is still before any body is read.
  app.addHook('onRequest', (request, _reply, done) => {
    request.tenant = open
      ? ANONYMOUS_TENANT
      : (authenticate(request.headers.authorization, keys) ?? '');
    done();
  });

  app.addHook('preParsing', (request, reply, _payload, done) => {
    if (request.tenant === '' && request.routeOptions.url !== '/health') {
      void reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send(
          errorBody('unauthorized', 'A valid API key is required: Authorization: Bearer <key>.'),
        );
      return;
    }
    done();
  });

  // Each /diagnose spends paid RPC calls, so this is a cost control as much as
  // an abuse control.
  void app.register(rateLimit, {
    max: config.SOLVBANA_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (request) => (request.tenant === '' ? request.ip : `tenant:${request.tenant}`),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Rate limit exceeded: ${String(context.max)} requests per minute. Retry in ${context.after}.`,
    }),
  });

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

  const accounts =
    options.accounts ??
    (options.source === undefined
      ? createAccountSource({ rpcUrl: config.SOLANA_RPC_URL })
      : undefined);

  const override = options.artifacts;
  const storeFor: (tenant: string) => WritableArtifactStore | undefined =
    typeof override === 'function'
      ? override
      : override !== undefined
        ? () => override
        : config.SOLVBANA_ARTIFACT_DIR === undefined
          ? () => undefined
          : createTenantStores(config.SOLVBANA_ARTIFACT_DIR, (message) => app.log.warn(message));

  // Registered once the rate limiter has loaded: it attaches to routes as they
  // are added, so a route added earlier would be silently unlimited.
  app.after(() => {
    registerHealthRoutes(app);
    registerArtifactRoutes(app, storeFor, accounts);
    registerDiagnoseRoutes(app, source, accounts, storeFor, {
      registryUrl: config.SOLVBANA_VERIFY_REGISTRY_URL,
      verifySource: true,
    });
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
  interface FastifyRequest {
    /** The authenticated tenant; empty only on routes that skip authentication. */
    tenant: string;
  }
}
