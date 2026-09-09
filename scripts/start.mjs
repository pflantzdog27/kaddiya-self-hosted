import { fork, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = path.join(root, 'apps', 'console');
const envFile = path.join(app, '.env');
const requireApp = createRequire(path.join(app, 'package.json'));

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [url], { stdio: 'ignore', detached: true });
  browser.on('error', () => console.log('Open the address above in your browser.'));
  browser.unref();
}

export async function startWorkspace({ initialize = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Kaddiya needs Node.js 22 or newer.');
  let dotenv;
  try { dotenv = requireApp('dotenv'); requireApp.resolve('@electric-sql/pglite'); }
  catch { throw new Error('Run npm run setup first to install Kaddiya.'); }
  if (!existsSync(envFile)) {
    if (!initialize) throw new Error('Run npm run setup first to create this workspace.');
    if (existsSync(path.join(root, '.env'))) throw new Error('An earlier Docker configuration exists at the repository root. Use npm run setup:docker to resume it. For a separate local workspace, clone into a new folder; existing Docker data is not moved automatically.');
    const dataDir = path.join(app, 'data');
    if (existsSync(dataDir) && readdirSync(dataDir).length) throw new Error('Workspace data exists but apps/console/.env is missing. Restore its configuration backup before starting; setup will not replace your encryption key.');
    if (process.env.DATABASE_URL || process.env.KADDIYA_STORAGE || process.env.KADDIYA_DATA_DIR || process.env.KADDIYA_MASTER_KEY || process.env.KADDIYA_MASTER_KEY_FILE) throw new Error('Existing storage or key settings were found in the environment. Configure apps/console/.env explicitly before starting so setup does not replace them.');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(envFile, [
      '# Local Kaddiya secrets. Back up this file together with data/. Never commit it.',
      'KADDIYA_STORAGE=local',
      'KADDIYA_EDITION=self-hosted',
      'BASE_URL=http://localhost:3000',
      'PORT=3000',
      `KADDIYA_MASTER_KEY=${randomBytes(32).toString('hex')}`,
      `KADDIYA_SETUP_TOKEN=${randomBytes(32).toString('hex')}`,
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
  }
  const env = { ...dotenv.parse(readFileSync(envFile)), ...process.env };
  if (!/^[a-f0-9]{64}$/i.test(env.KADDIYA_MASTER_KEY || '') && !env.KADDIYA_MASTER_KEY_FILE) throw new Error('apps/console/.env needs a valid KADDIYA_MASTER_KEY. Restore your saved key; setup has preserved the file.');
  if (!env.KADDIYA_SETUP_TOKEN) throw new Error('Set KADDIYA_SETUP_TOKEN in apps/console/.env. The existing file has been preserved.');
  const url = new URL(env.BASE_URL || 'http://localhost:3000');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('BASE_URL must be the HTTP(S) origin where the workspace is served.');
  const local = env.KADDIYA_STORAGE === 'local' || (!env.KADDIYA_STORAGE && !env.DATABASE_URL);
  if (local && (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || Number(url.port || 80) !== port)) throw new Error('For local storage, use BASE_URL=http://localhost:<PORT> with the same PORT value. Shared HTTPS deployments use PostgreSQL.');

  console.log('Opening your workspace…');
  // Readiness arrives over our child process channel, never by trusting
  // whichever HTTP server happens to be listening on the chosen port.
  const child = fork(path.join(app, 'server', 'index.js'), [], { cwd: app, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  let ready = false;
  const timeout = setTimeout(() => {
    console.error('Startup is taking longer than expected. Review the messages above and retry.');
    child.send?.('shutdown');
  }, 120_000);
  const stop = () => { if (child.connected) child.send('shutdown'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('message', message => { if (message === 'shutdown') stop(); });
  child.on('message', message => {
    if (message?.type !== 'ready' || ready) return;
    ready = true;
    clearTimeout(timeout);
    console.log(`\nYour workspace is ready: ${url.origin}\nKeep this window open. Press Ctrl+C to stop; npm start resumes your saved workspace.`);
    if (message.setupRequired) console.log(`\nSetup code (if the guide asks):\n${env.KADDIYA_SETUP_TOKEN}\n`);
    process.send?.({ type: 'ready', baseUrl: url.origin, setupRequired: message.setupRequired });
    if (env.KADDIYA_OPEN_BROWSER !== '0') {
      // A fragment is never sent in HTTP requests or referrers. The guide
      // reads and immediately removes it, then submits through normal CSRF checks.
      const target = local && message.setupRequired ? `${url.origin}/start#setup=${encodeURIComponent(env.KADDIYA_SETUP_TOKEN)}` : url.origin;
      openBrowser(target);
    }
  });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (code !== 0 && signal !== 'SIGINT') reject(new Error('Kaddiya stopped before completing normally. Your saved workspace has been kept.'));
      else resolve();
    });
  });
  if (process.connected) process.disconnect();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await startWorkspace(); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
