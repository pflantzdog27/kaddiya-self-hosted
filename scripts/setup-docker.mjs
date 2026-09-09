import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, '.env');
const secret = () => randomBytes(32).toString('hex');

try {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (docker.status !== 0) throw new Error('This optional path needs Docker with Compose. Run npm run setup for local storage without Docker.');
  try {
    writeFileSync(envPath, [
      '# Local deployment secrets. Keep this file with your database backup; never commit it.',
      `KADDIYA_DB_PASSWORD=${secret()}`,
      `KADDIYA_MASTER_KEY=${secret()}`,
      `KADDIYA_SETUP_TOKEN=${secret()}`,
      'BASE_URL=http://localhost:3000',
      'KADDIYA_PORT=3000',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const config = readFileSync(envPath, 'utf8');
  const value = name => config.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim();
  for (const name of ['KADDIYA_DB_PASSWORD', 'KADDIYA_MASTER_KEY', 'KADDIYA_SETUP_TOKEN']) {
    if (!/^[a-f0-9]{64}$/i.test(value(name) || '')) throw new Error(`The existing root .env needs ${name} as 64 hex characters. It has been preserved; see README.md.`);
  }
  console.log('Starting your local Kaddiya workspace. The first build may take a few minutes.');
  const result = spawnSync('docker', ['compose', 'up', '--build', '-d', '--wait'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Startup did not finish. Check Docker is running and the port is available. Your configuration is saved; run npm run setup:docker again to retry.');
  console.log(`\nOpen ${value('BASE_URL') || 'http://localhost:3000'}\n\nSetup code (paste into the browser guide):\n${value('KADDIYA_SETUP_TOKEN')}\n\nThe guide connects ServiceNow and your models. After setup, use npm run start:docker and npm run stop.\n`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
