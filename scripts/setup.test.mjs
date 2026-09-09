import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('fresh clone installs without Docker, opens setup, preserves configuration and resumes its data', { timeout: 180_000 }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Kaddiya Windows setup '));
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.send('shutdown');
    const timeout = setTimeout(() => child.kill(), 15_000);
    await exited;
    clearTimeout(timeout);
  }
  t.after(async () => { await stop(); fs.rmSync(fixture, { recursive: true, force: true }); });
  for (const name of ['scripts', 'package.json', 'setup.cmd', 'start.cmd']) fs.cpSync(path.join(root, name), path.join(fixture, name), { recursive: true });
  const app = path.join(fixture, 'apps', 'console');
  fs.mkdirSync(app, { recursive: true });
  for (const name of ['server', 'public', 'package.json', 'package-lock.json']) fs.cpSync(path.join(root, 'apps', 'console', name), path.join(app, name), { recursive: true });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://localhost:${port}`;
  const env = { ...process.env };
  // Match double-clicking setup.cmd: no npm parent process supplies its CLI.
  delete env.npm_execpath;
  for (const key of Object.keys(env)) if (/^(KADDIYA_|SN_|ANTHROPIC_|DATABASE_URL$|BASE_URL$|PORT$|HOST$)/.test(key)) delete env[key];
  Object.assign(env, { BASE_URL: base, PORT: String(port), KADDIYA_OPEN_BROWSER: '0', KADDIYA_DOCS_SYNC: '0' });
  let logs = '';
  async function boot(script) {
    logs = '';
    child = fork(path.join(fixture, 'scripts', script), [], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Launcher readiness timed out.')), 100_000);
      child.once('error', err => { clearTimeout(timeout); reject(err); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Launcher exited early (${code}): ${logs.replace(/[a-f0-9]{64}/gi, '[secret]')}`)); });
      child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timeout); resolve(); } });
    });
  }
  await boot('setup.mjs');
  const envFile = path.join(app, '.env');
  const config = fs.readFileSync(envFile, 'utf8');
  assert.match(config, /KADDIYA_STORAGE=local/);
  assert.doesNotMatch(config, /DATABASE_URL/);
  const token = config.match(/^KADDIYA_SETUP_TOKEN=(.+)$/m)[1];
  const key = config.match(/^KADDIYA_MASTER_KEY=(.+)$/m)[1];
  assert.notEqual(token, key);
  assert.match(token, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/start');
  assert.equal((await fetch(base + '/start')).status, 200);
  const publicConfig = await (await fetch(base + '/api/config')).text();
  assert.ok(!publicConfig.includes(token) && !publicConfig.includes(key));
  // A second launcher must refuse to touch an open data directory and exit,
  // without opening a browser or disrupting the original process.
  const duplicate = fork(path.join(fixture, 'scripts', 'start.mjs'), [], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let duplicateOutput = '';
  duplicate.stdout.on('data', data => { duplicateOutput += data; });
  duplicate.stderr.on('data', data => { duplicateOutput += data; });
  const duplicateTimer = setTimeout(() => duplicate.kill(), 10_000);
  const [duplicateCode] = await once(duplicate, 'exit');
  clearTimeout(duplicateTimer);
  assert.equal(duplicateCode, 1);
  assert.match(duplicateOutput, /already open/);
  assert.equal((await fetch(base + '/api/config')).status, 200);
  const post = (route, body, cookie) => fetch(base + route, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/org', { name: 'Example', setup_token: 'wrong' })).status, 403);
  const response = await post('/api/org', { name: 'Local Windows workspace', setup_token: token });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const original = await response.json();
  await stop();
  await boot('start.mjs');
  assert.equal(fs.readFileSync(envFile, 'utf8'), config);
  const draft = await (await fetch(base + '/api/org/draft', { headers: { Cookie: cookie } })).json();
  assert.equal(draft.org.id, original.org.id);
  await stop();
  // Repeated setup is also the update path and must not reset secrets/data.
  await boot('setup.mjs');
  assert.equal(fs.readFileSync(envFile, 'utf8'), config);
  assert.equal((await (await fetch(base + '/api/org/draft', { headers: { Cookie: cookie } })).json()).org.id, original.org.id);
  await stop();
});
