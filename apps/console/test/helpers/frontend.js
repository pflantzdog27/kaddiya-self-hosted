// Load the browser scripts the way app.html does — same files, same order,
// one shared global scope — into a vm context with the DOM stub.
//
// Order is the point: work-pane.js defines WorkResources, outputs.js
// registers the document and Files resources with it, and app.js registers
// record and profile. Loading app.js alone would pass a test that the browser
// would fail, so the loader mirrors the page instead of the other way round.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeDocument, FakeNode } from './dom.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

/** The scripts app.html loads, in app.html's order. */
export const FRONTEND_SCRIPTS = ['work-pane.js', 'output-viewers.js', 'outputs.js', 'app.js'];

export function loadFrontend({ scripts = FRONTEND_SCRIPTS, document: doc = makeDocument(), extra = {} } = {}) {
  const sandbox = {
    document: doc,
    location: { assign() {}, origin: 'http://localhost:3000', search: '' },
    history: { replaceState() {} },
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.get(k) ?? null; },
      setItem(k, v) { this.store.set(k, String(v)); },
      removeItem(k) { this.store.delete(k); },
    },
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('no clipboard in tests')) } },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    fetch: () => Promise.reject(new Error('no network in tests')),
    URL, URLSearchParams, Buffer, console, TextEncoder, TextDecoder, CSS: { escape: (v) => String(v) },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    ...extra,
  };
  // `window` is the same object the scripts see as their global, so the
  // `window.X = X` exports at the foot of each file land where a test can
  // read them — exactly as they do in the page.
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

export { makeDocument, FakeNode };
