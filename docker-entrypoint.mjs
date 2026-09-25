import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';

export function deploymentOptions(env = process.env, read = readFileSync) {
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new Error('APP_ORIGIN must be an HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || env.SECURE_COOKIES !== 'true') {
    throw new Error('Use an HTTPS origin without credentials, paths, queries, or fragments and SECURE_COOKIES=true.');
  }
  const password = read('/run/secrets/operator_password', 'utf8').trim();
  const workerToken = read('/run/secrets/worker_token', 'utf8').trim();
  if (password.length < 12) throw new Error('Operator password must be at least 12 characters.');
  if (workerToken.length < 32) throw new Error('Worker token must be at least 32 characters.');
  return { password, workerToken, origin: origin.origin, secureCookies: true, dataDir: env.DATA_DIR || '/var/lib/publisher-exit' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApp(deploymentOptions());
  const port = Number(process.env.PORT || 4317);
  server.listen(port, '0.0.0.0', () => console.log(`Publisher Exit container listening on port ${port}; HTTPS is provided by the proxy.`));
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 15000).unref();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
