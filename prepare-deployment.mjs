import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const dir = join(root, 'deployment-secrets');
mkdirSync(dir, {recursive:true, mode:0o700});
if (process.platform !== 'win32') chmodSync(dir, 0o700);
for (const name of ['operator-password.txt','worker-token.txt']) {
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', {flag:'wx', mode:0o644});
}
console.log('Deployment secrets are ready in deployment-secrets/. Existing values were preserved. Store them privately; do not commit or share them.');
