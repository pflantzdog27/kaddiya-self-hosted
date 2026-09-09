// The CSP holds only because nothing in public/ is inline (ADR 0008 D8).
//
// `script-src 'self'` and `style-src 'self' https://fonts.googleapis.com` carry
// no 'unsafe-inline', so the moment someone adds an inline <script>, a <style>
// block, or a style="" attribute back into a page, that page silently stops
// working in the browser while still passing every other test. This gate makes
// that a build failure instead of a bug report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'public',
);
const SERVER_INDEX = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js',
);

const pages = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

test('every page in public/ exists to be checked', () => {
  assert.ok(pages.length >= 3, `expected the console pages, found ${pages.join(', ')}`);
});

for (const page of pages) {
  test(`${page} carries no inline script, style block, or style attribute`, () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');

    assert.doesNotMatch(
      html, /<script(?![^>]*\bsrc=)[^>]*>/i,
      'inline <script> is blocked by script-src \'self\' — move it to its own .js file',
    );
    assert.doesNotMatch(
      html, /<style[\s>]/i,
      'inline <style> is blocked by style-src \'self\' — move it to its own .css file',
    );
    assert.doesNotMatch(
      html, /\sstyle\s*=\s*["']/i,
      'inline style attributes are blocked by style-src \'self\' — use a class',
    );
    assert.doesNotMatch(
      html, /\son[a-z]+\s*=\s*["']/i,
      'inline event handlers are blocked — use addEventListener',
    );
  });
}

test('the CSP never grants unsafe-inline or unsafe-eval', () => {
  const source = fs.readFileSync(SERVER_INDEX, 'utf8');
  const csp = source.slice(source.indexOf("res.setHeader('Content-Security-Policy'"));
  assert.ok(csp, 'the CSP header is still set');
  const directives = csp.slice(0, csp.indexOf('].join'));
  assert.doesNotMatch(directives, /unsafe-inline/, "the CSP must not allow 'unsafe-inline'");
  assert.doesNotMatch(directives, /unsafe-eval/, "the CSP must not allow 'unsafe-eval'");
  assert.match(directives, /"frame-ancestors 'none'"/, 'clickjacking stays closed');
  assert.match(directives, /"default-src 'none'"/, 'the CSP stays default-deny');
});

// The sign-in form must navigate, never submit. /auth/login answers with a 302
// to the instance's own OAuth page, and Chrome applies `form-action 'self'`
// to the redirect that follows a form submission — so a real submit is
// blocked in the browser while every server-side test stays green (seen on
// kaddiya.com, 2026-09-06). The other OAuth entry points (start.js, admin.js)
// already navigate with location.assign after a fetch; this pins login.js to
// the same shape rather than loosening form-action to admit customer domains.
test('the sign-in form intercepts submit and navigates to /auth/login', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'login.js'), 'utf8');
  const handler = source.slice(source.indexOf("addEventListener('submit'"));
  assert.ok(handler.length > 0, 'login.js still handles the instance form');
  assert.match(handler, /preventDefault\(\)/, 'the submit must be prevented: form-action blocks the OAuth redirect');
  assert.match(handler, /location\.assign\('\/auth\/login\?instance='/, 'the sign-in is a navigation to /auth/login');
});
