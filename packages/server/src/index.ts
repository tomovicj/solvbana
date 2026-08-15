import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const result = loadConfig();
if (!result.ok) {
  process.stderr.write(
    `Invalid configuration:\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n` +
      'See .env.example for the expected variables.\n',
  );
  process.exit(1);
}

const { config } = result;
const app = buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
