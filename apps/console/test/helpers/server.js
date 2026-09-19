// Boot the real console over real HTTP, for the tests that must exercise
// headers, status codes and the session cookie rather than a service call.
//
// The embedded database allows one process at a time, so the shape is: seed
// here, close the pool, hand the data directory to a child running
// server/index.js, and talk to it over the port. That is also what makes this
// an honest test of the routes — nothing in the child is stubbed, and the
// only credential it accepts is a cookie that a real session row backs.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start server/index.js with this test's disposable storage and wait for the
 * ready message it already sends its supervisor. Returns a client bound to
 * one session cookie, plus `stop()` and the collected stderr.
 */
export async function startConsole({ port, env = {}, sid } = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: CONSOLE_DIR,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: `http://127.0.0.1:${port}`,
      KADDIYA_DOCS_SYNC: '0',
      ...env,
    },
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { stdout += d.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`console did not start in 30s.\n${stderr}${stdout}`)), 30_000);
    child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`console exited with ${code}.\n${stderr}${stdout}`)); });
  });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, urlPath, { body, cookie = sid, headers = {} } = {}) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        ...(cookie ? { cookie: `sid=${cookie}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { origin: base }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    return res;
  };

  return {
    base,
    child,
    get stderr() { return stderr; },
    get: (p, o) => call('GET', p, o),
    post: (p, body, o) => call('POST', p, { body, ...o }),
    del: (p, o) => call('DELETE', p, o),
    json: async (res) => { try { return await res.json(); } catch { return null; } },
    async stop() {
      if (child.exitCode != null) return;
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.send('shutdown');
        setTimeout(() => child.kill('SIGKILL'), 8_000).unref();
      });
    },
  };
}
