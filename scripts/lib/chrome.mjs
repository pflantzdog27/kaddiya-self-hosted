// A minimal headless-Chrome driver over the DevTools protocol.
//
// No Puppeteer and no new dependency: the Chrome already on the machine, and
// Node 22's own WebSocket. Shared by scripts/demo-capture.mjs (screenshots)
// and scripts/doc-to-pdf.mjs (printing), which want the same four things —
// launch, connect, drive one page, print or capture.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch headless Chrome on an ephemeral port and return its debugger URL. */
export function launchChrome({ chrome: binary = DEFAULT_CHROME, width = 1440, height = 900 } = {}) {
  if (!fs.existsSync(binary)) throw new Error(`No Chrome at ${binary} — pass --chrome <path>`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kaddiya-chrome-'));
  const child = spawn(binary, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--disable-gpu', '--force-color-profile=srgb',
    `--window-size=${width},${height}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  return new Promise((resolve, reject) => {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    const poll = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(poll); child.kill(); reject(new Error('Chrome did not start')); return; }
      if (!fs.existsSync(portFile)) return;
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (!port) return;
      clearInterval(poll);
      try {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
        resolve({ child, profile, wsUrl: version.webSocketDebuggerUrl });
      } catch (err) { reject(err); }
    }, 120);
  });
}

/** A request/response + event client for one debugger socket. */
export function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const waiters = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(`${message.error.message} (${message.method || ''})`)) : resolve(message.result);
      return;
    }
    for (const waiter of [...waiters]) {
      if (waiter.method === message.method) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message.params);
      }
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    once(method, timeoutMs = 15_000) {
      return new Promise((resolve) => {
        const waiter = { method, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          if (waiters.includes(waiter)) { waiters.splice(waiters.indexOf(waiter), 1); resolve(null); }
        }, timeoutMs);
      });
    },
    close: () => socket.close(),
  };
}

/** Launch, attach to a fresh page, and hand back a `send` bound to it. */
export async function openPage(options = {}) {
  const { child, profile, wsUrl } = await launchChrome(options);
  const client = cdp(wsUrl);
  await client.ready;
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => client.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');

  return {
    client, send,
    once: (method, timeoutMs) => client.once(method, timeoutMs),
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed');
      return result.value;
    },
    async close() {
      client.close();
      child.kill();
      // Chrome flushes its profile on the way out; deleting under it races that.
      await new Promise((resolve) => child.once('exit', resolve));
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch { /* a temp profile left behind is not worth failing a run over */ }
    },
  };
}
