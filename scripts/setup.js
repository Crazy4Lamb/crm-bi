'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
if (!fs.existsSync(envFile)) {
  const secret = () => crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(envFile, `DB_MODE=pg\nPORT=8787\nAPP_TZ=Asia/Shanghai\nPGHOST=127.0.0.1\nPGPORT=5433\nPGDATABASE=crm_bi\nPGUSER=crm_app\nPGPASSWORD=${secret()}\nPGADMIN_USER=crm_owner\nPGADMIN_PASSWORD=${secret()}\nJWT_SECRET=${secret()}\nBACKFILL_DAYS=120\n`, { mode: 0o600 });
  console.log('Created .env with random local credentials (excluded from Git).');
}
function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '180']);
if (!process.argv.includes('--db-only')) run(process.execPath, ['server/db/init.js']);

