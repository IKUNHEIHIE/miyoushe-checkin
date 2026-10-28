import { buildApp } from './app.js';
import { configFromEnv } from './core.js';

async function main() {
  const config = configFromEnv(), { app } = await buildApp(config);
  const address = await app.listen({ host: config.host, port: config.port });
  console.log(`Miyoushe backend listening at ${address}; contract 0.1.0`);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0), () => process.exit(1)); });
}
main().catch(() => { console.error('Backend startup failed. Check runtime, configuration, database access and encryption key.'); process.exitCode = 1; });
