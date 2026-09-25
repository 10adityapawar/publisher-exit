import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentOptions } from './docker-entrypoint.mjs';

const env = { APP_ORIGIN: 'https://pilot.example.org', SECURE_COOKIES: 'true', DATA_DIR: '/private/data' };
const read = p => p.endsWith('operator_password') ? 'private-password-123\n' : 'w'.repeat(64) + '\n';
test('container startup reads mounted secrets and preserves HTTPS origin and persistent path', () => {
  const o = deploymentOptions(env, read);
  assert.equal(o.origin, env.APP_ORIGIN);
  assert.equal(o.secureCookies, true);
  assert.equal(o.dataDir, env.DATA_DIR);
  assert.equal(o.password, 'private-password-123');
  assert.equal(o.workerToken.length, 64);
});
test('container rejects insecure or malformed origins and weak/missing secrets', () => {
  for (const APP_ORIGIN of [undefined, 'http://pilot.example.org', 'https://user:pass@pilot.example.org', 'https://pilot.example.org/path', 'https://pilot.example.org/?x=1', 'https://pilot.example.org/#test']) {
    assert.throws(() => deploymentOptions({...env, APP_ORIGIN}, read));
  }
  assert.throws(() => deploymentOptions({...env, SECURE_COOKIES:'false'}, read));
  assert.throws(() => deploymentOptions(env, () => 'short'));
  assert.throws(() => deploymentOptions(env, p => p.endsWith('worker_token') ? 'short' : read(p)));
  assert.throws(() => deploymentOptions(env, () => { throw new Error('missing secret'); }));
});
