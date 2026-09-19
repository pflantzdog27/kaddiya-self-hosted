// The work pane's rendering invariants (spec §8, acceptance 10–12).
//
// The pane is a new surface that shows text a model wrote and a ServiceNow
// field supplied. render.test.js already pins the chat renderer's closed tag
// set; this pins the document mode built on it, and the three viewers that do
// not go through it at all — code, JSON and CSV — where the guarantee is
// structural instead: they write with textContent, so there is no parse step
// for anything to escape from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend, FakeNode } from './helpers/frontend.js';

const app = loadFrontend();
const { renderMarkdown, parseDelimited, parseJsonSafely, viewerFor, OutputsApi,
  titleFromMarkdown, outputReferenceFrom, formatBytes } = app;

const mount = (metadata, content, extra = {}) => {
  const container = new FakeNode('div');
  viewerFor(metadata).mount(container, { ...metadata, content, ...extra });
  return container;
};

// Arrays built inside the vm carry that realm's prototype, so they are copied
// into this one before a strict deep comparison.
const plain = (rows) => Array.from(rows, (row) => Array.from(row));

/** Every `<…>` token in the output, as render.test.js reads them. */
const markupTokens = (html) => html.match(/<[^>]*>/g) || [];

// The complete set of markup the DOCUMENT mode may emit. Same closed set as
// the transcript's, plus the two headings a document is allowed to own.
const ALLOWED_DOCUMENT_MARKUP = [
  /^<\/?(?:p|ul|ol|li|h1|h2|h3|h4|h5|h6|code|strong|em|del|blockquote|table|thead|tbody|tr|th|td)>$/,
  /^<br>$/, /^<hr>$/, /^<pre class="code">$/, /^<\/pre>$/,
  /^<div class="codeblock">$/, /^<div class="codeblock-head">$/,
  /^<span class="codeblock-lang">$/, /^<\/span>$/,
  /^<button class="codeblock-copy" type="button">$/, /^<\/button>$/, /^<\/div>$/,
];

// ---- the document heading mode ----

test('a document owns its heading hierarchy; chat keeps its sub-heading one', () => {
  const src = '# Title\n\n## Section\n\n### Detail\n\n#### Aside\n';
  const doc = renderMarkdown(src, { headingBase: 1 });
  assert.match(doc, /<h1>Title<\/h1>/);
  assert.match(doc, /<h2>Section<\/h2>/);
  assert.match(doc, /<h3>Detail<\/h3>/);
  assert.match(doc, /<h4>Aside<\/h4>/);

  const inChat = renderMarkdown(src);
  assert.match(inChat, /<h3>Title<\/h3>/, 'unchanged in the transcript: a reply is not a document');
  assert.match(inChat, /<h6>Aside<\/h6>/);

  // Deeper than h6 is not a thing; the mode clamps rather than emitting <h7>.
  const deep = renderMarkdown('#### Deep\n', { headingBase: 4 });
  assert.match(deep, /<h6>Deep<\/h6>/);
  assert.doesNotMatch(renderMarkdown(src, { headingBase: 5 }), /<h[789]/);
});

test('the document renderer stays inside the same closed tag set', () => {
  const hostile = [
    '# <script>alert(1)</script>',
    '![beacon](https://evil.example/pixel.png)',
    '[click](javascript:alert(1))',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="https://evil.example">link</a>',
    '```html\n<script>alert(1)</script>\n```',
    '| a | <img src=x onerror=alert(1)> |\n| --- | --- |\n| 1 | 2 |',
  ].join('\n\n');
  const html = renderMarkdown(hostile, { headingBase: 1 });
  // An allow-list of emitted tokens, not a denylist of bad spellings: the
  // escaped text may legitimately contain the characters `onerror=`, and what
  // matters is that no *tag* carries them.
  for (const token of markupTokens(html)) {
    assert.ok(ALLOWED_DOCUMENT_MARKUP.some((re) => re.test(token)), `the document mode emitted ${token}`);
    assert.doesNotMatch(token, /\bsrc\s*=/i, `src attribute in ${token}`);
    assert.doesNotMatch(token, /\bhref\s*=/i, `href attribute in ${token}`);
    assert.doesNotMatch(token, /\bon[a-z]+\s*=/i, `event handler in ${token}`);
    assert.doesNotMatch(token, /javascript:|data:/i, `URL scheme in ${token}`);
  }
  // The hostile spellings survive as text, which is the point: a person can
  // read what the model wrote without the page acting on it.
  assert.match(html, /&lt;script&gt;/, 'the script tag is shown, not run');
});

test('malformed fences and nested lists degrade instead of breaking out', () => {
  const html = renderMarkdown('```js\nconst a = "<b>";\n\n# still inside\n', { headingBase: 1 });
  assert.doesNotMatch(html, /<b>/, 'an unterminated fence keeps escaping its contents');
  const nested = renderMarkdown('- one\n  - two\n- three\n\n1. a\n2. b\n', { headingBase: 1 });
  assert.match(nested, /<ul>/);
  assert.match(nested, /<ol>/);
  assert.equal((nested.match(/<ul>/g) || []).length, (nested.match(/<\/ul>/g) || []).length, 'lists close');
});

// ---- the viewers ----

test('the markdown viewer renders a document and nothing else', () => {
  const container = mount({ format: 'markdown' }, '# Escalation\n\nPage the *on-call*.\n');
  const article = container.querySelector('.doc-body');
  assert.ok(article, 'the document body is present');
  assert.match(article.innerHTML, /<h1>Escalation<\/h1>/);
  assert.match(article.innerHTML, /<em>on-call<\/em>/);
});

test('code and text are inert: written as text, never parsed as markup', () => {
  for (const format of ['code', 'text']) {
    const payload = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>';
    const container = mount({ format, language: 'html' }, payload);
    const pre = container.querySelector('PRE');
    assert.ok(pre, `${format} renders a pre`);
    assert.equal(pre.textContent, payload, 'the source is shown verbatim');
    assert.equal(container.htmlNodes.length, 0, `${format} never assigns innerHTML`);
    assert.ok(!container.tags.includes('SCRIPT') && !container.tags.includes('IMG'),
      'no element was created from the content');
  }
});

test('JSON is bounded, falls back on invalid syntax, and drops prototype keys', () => {
  const ok = mount({ format: 'json' }, JSON.stringify({ a: 1, b: ['x', null, true] }));
  assert.equal(ok.htmlNodes.length, 0, 'the JSON tree is built with DOM calls, not markup');
  assert.match(ok.textContent, /"x"/);

  const broken = mount({ format: 'json' }, '{ not json ');
  assert.match(broken.textContent, /not valid JSON/);
  assert.ok(broken.querySelector('PRE'), 'invalid JSON still shows its source');

  // Deep nesting is labelled rather than laid out forever.
  let deep = '1';
  for (let i = 0; i < 40; i++) deep = `[${deep}]`;
  const nested = mount({ format: 'json' }, deep);
  assert.match(nested.textContent, /nested too deep/);

  const polluted = parseJsonSafely('{"__proto__": {"polluted": true}, "safe": 1}');
  assert.equal(polluted.safe, 1);
  assert.equal(({}).polluted, undefined, 'nothing was written to Object.prototype');
  assert.equal(Object.prototype.polluted, undefined);
});

test('CSV parsing handles quoted fields, embedded delimiters and newlines', () => {
  const csv = 'name,note,count\n"Doe, Jane","She said ""go""",3\n"multi\nline",plain,4\n';
  const rows = plain(parseDelimited(csv, ',').rows);
  assert.deepEqual(rows[0], ['name', 'note', 'count']);
  assert.deepEqual(rows[1], ['Doe, Jane', 'She said "go"', '3'], 'a quoted comma is not a column break');
  assert.deepEqual(rows[2], ['multi\nline', 'plain', '4'], 'a quoted newline is not a row break');
  assert.equal(rows.length, 3, 'the trailing newline is not a row');

  assert.deepEqual(plain(parseDelimited('a,b\r\n1,2\r\n', ',').rows), [['a', 'b'], ['1', '2']], 'CRLF');
  assert.deepEqual(plain(parseDelimited('a\tb\n1\t2\n', '\t').rows), [['a', 'b'], ['1', '2']], 'TSV');
  assert.deepEqual(plain(parseDelimited('a,b\n1\n', ',').rows), [['a', 'b'], ['1']], 'a ragged row is kept as it is');

  const wide = parseDelimited(['h'.repeat(1)].concat(Array.from({ length: 60 }, (_, i) => `c${i}`)).join(','), ',');
  assert.ok(wide.truncatedCols, 'a very wide row is reported as trimmed');
  const tall = parseDelimited(Array.from({ length: 400 }, (_, i) => `r${i}`).join('\n'), ',');
  assert.ok(tall.truncatedRows);
  assert.equal(tall.rows.length, 200, 'the preview stops at 200 rows');
});

test('a table cell is text: no formula is evaluated and no markup is parsed', () => {
  const container = mount({ format: 'csv' }, 'formula,markup\n"=1+1","<img src=x onerror=alert(1)>"\n');
  assert.equal(container.htmlNodes.length, 0);
  const cells = Array.from(container.querySelectorAll('TD'), (c) => c.textContent);
  assert.deepEqual(cells, ['=1+1', '<img src=x onerror=alert(1)>']);
  assert.ok(!container.tags.includes('IMG'));
  assert.equal(container.querySelector('.work-note'), null, 'a small table needs no truncation note');
});

test('a large table says it is a preview, and the download is still everything', () => {
  const rows = ['a,b'].concat(Array.from({ length: 300 }, (_, i) => `${i},${i * 2}`)).join('\n');
  const container = mount({ format: 'csv' }, rows);
  assert.match(container.querySelector('.work-note').textContent, /Previewing the first 200 rows/);
  assert.match(container.querySelector('.work-note').textContent, /Download the file for everything/);
});

test('an unknown format falls back to source, never to a guessed renderer', () => {
  const container = mount({ format: 'something-new' }, '<b>raw</b>');
  assert.ok(container.querySelector('PRE'));
  assert.equal(container.htmlNodes.length, 0);
  assert.equal(container.querySelector('PRE').textContent, '<b>raw</b>');
});

// ---- URLs and references ----

test('a download URL is built from validated ids and never taken from input', () => {
  const id = '3f1c9a2e-5b6d-4c7e-8a9b-0c1d2e3f4a5b';
  assert.equal(OutputsApi.downloadUrl(id, 2), `/api/outputs/${id}/download?revision=2`);
  for (const bad of [null, undefined, '', 'not-a-uuid', '../../etc/passwd', 'https://evil.example/file']) {
    assert.equal(OutputsApi.downloadUrl(bad, 1), null, `${bad} must not produce a URL`);
  }
  for (const rev of [0, -1, 1.5, '2', null, NaN]) {
    assert.equal(OutputsApi.downloadUrl(id, rev), null, `revision ${rev} must not produce a URL`);
  }
});

test('a file card is rebuilt only from a committed, well-formed tool result', () => {
  const id = '3f1c9a2e-5b6d-4c7e-8a9b-0c1d2e3f4a5b';
  const good = { content: JSON.stringify({ status: 'saved', output_id: id, revision: 2, title: 'T', filename: 't.md', format: 'markdown', byte_length: 9 }) };
  assert.equal(outputReferenceFrom('workspace_create_output', good).output_id, id);
  assert.equal(outputReferenceFrom('workspace_update_output', good).revision, 2);

  assert.equal(outputReferenceFrom('sn_query', good), null, 'another tool is not a file');
  assert.equal(outputReferenceFrom('workspace_create_output', { ...good, is_error: true }), null);
  assert.equal(outputReferenceFrom('workspace_create_output', { content: '{"status":"saved","output_i' }), null,
    'a truncated result is not a file card');
  assert.equal(outputReferenceFrom('workspace_create_output', { content: JSON.stringify({ status: 'saved', output_id: 'https://evil.example', revision: 1 }) }), null);
  assert.equal(outputReferenceFrom('workspace_create_output', { content: JSON.stringify({ status: 'pending', output_id: id, revision: 1 }) }), null);
  assert.equal(outputReferenceFrom('workspace_create_output', null), null);
});

test('small helpers: titles and sizes read the way a person would say them', () => {
  assert.equal(titleFromMarkdown('# Incident escalation process\n\nBody'), 'Incident escalation process');
  assert.equal(titleFromMarkdown('No heading here, just a first line.\nSecond'), 'No heading here, just a first line.');
  assert.equal(titleFromMarkdown('## **Bold** heading'), 'Bold heading');
  assert.equal(titleFromMarkdown(''), 'Document');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(6432), '6.3 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});

test('the transcript never reprints a saved document (spec §6: no duplicate bodies)', () => {
  const { toolLabel, machineLine } = app;
  const secret = '# Payroll incident 4471\n\nThe caller is Jane Doe.\n' + 'x'.repeat(5000);

  for (const [name, input] of [
    ['workspace_create_output', { title: 'Payroll incident 4471', filename: 'payroll', format: 'markdown', content: secret }],
    ['workspace_update_output', { output_id: '3f1c9a2e-5b6d-4c7e-8a9b-0c1d2e3f4a5b', expected_revision: 2, content: secret }],
  ]) {
    const line = machineLine(name, input);
    assert.doesNotMatch(line, /Jane Doe|xxxx/, `${name} printed the document into the transcript`);
    assert.ok(line.length < 120, `${name} tool line is a line, not a document (${line.length} chars)`);
    // What it does say is the shape of the write: enough to review, nothing to leak.
    assert.match(line, /KB|B$/, `${name} reports how much was written`);
    assert.match(toolLabel(name, input), /^FILE/, `${name} is labelled as a file operation`);
  }

  assert.match(machineLine('workspace_update_output', { output_id: 'abcdef12-0000-4000-8000-000000000000', expected_revision: 3, content: 'x' }), /from v3/,
    'the version being revised is visible, because that is the conflict story');
  assert.equal(machineLine('workspace_list_outputs', {}), 'files in this conversation');

  // The instance tools are untouched: their line is the encoded query, which
  // is exactly what this console exists to show.
  assert.equal(machineLine('sn_query', { table: 'incident', query: 'active=true^priority=1' }), 'active=true^priority=1');
});

// The splitter's sizing rules (spec §3), and one bug they had.
//
// `layout()` used to measure the rail it was deciding whether to collapse.
// Collapsing sets its width to zero, which failed the "is there a rail?"
// test, which un-collapsed it — so the result depended on which pass ran
// last. In a real browser at 900px that produced a visible 220px rail beside
// a 180px chat column, with the pane sized as though the rail were gone.
// The fix remembers the rail's natural width; the test that matters is that
// laying out twice says the same thing.
test('the rail collapses before either pane is squeezed, and the decision is stable', () => {
  const pane = layoutHarness();

  const at = (viewport) => {
    pane.setViewport(viewport);
    pane.layout();
    const first = pane.read();
    pane.layout();                 // a second pass must not change its mind
    const second = pane.read();
    assert.deepEqual(second, first, `layout at ${viewport}px oscillates: ${JSON.stringify(first)} then ${JSON.stringify(second)}`);
    return first;
  };

  // Roomy: the rail stays, and the pane takes its share.
  const wide = at(1440);
  assert.equal(wide.railCollapsed, false);
  assert.equal(wide.narrow, false);
  assert.ok(wide.paneWidth >= 420, `pane ${wide.paneWidth}`);
  assert.ok(1440 - wide.railWidth - wide.paneWidth >= 340, 'the chat keeps its minimum');

  // The spec's tightest two-pane case: both minimums are met with the rail up.
  const tight = at(1024);
  assert.equal(tight.railCollapsed, false, 'at 1024 the rail still fits');
  assert.ok(tight.paneWidth >= 420 && 1024 - tight.railWidth - tight.paneWidth >= 340);

  // Below that, the rail goes before either main pane is squeezed. This is
  // the width that used to land the rail visible beside a 180px chat column.
  const squeezed = at(900);
  assert.equal(squeezed.railCollapsed, true, 'the rail collapses rather than squeezing the chat');
  assert.equal(squeezed.narrow, false, 'and two panes still fit once it is gone');
  assert.ok(squeezed.paneWidth >= 420, `pane ${squeezed.paneWidth}`);
  assert.ok(900 - squeezed.paneWidth >= 340, `chat ${900 - squeezed.paneWidth} below its minimum`);

  // Narrower than two minimums plus the rail: one work area at a time.
  const narrow = at(700);
  assert.equal(narrow.narrow, true, 'a single work area, with Back to chat');
  assert.equal(narrow.paneVarSet, false, 'the pane is not given a split width in that mode');

  // And back up again, in the other direction, with the same answers.
  assert.deepEqual(at(900), squeezed, 'widening and narrowing agree');
  assert.deepEqual(at(1440), wide);
});

/**
 * A stand-in for the parts of the page `layout()` touches. The rail reports
 * zero width while collapsed, exactly as `display: none` does in the browser
 * — which is the feedback loop the bug above lived in.
 */
function layoutHarness() {
  const { WorkPane } = app;
  const state = WorkPane._state;
  const el = { };
  let viewport = 1280;
  const workspace = new FakeNode('div');
  const rail = new FakeNode('nav');
  // The browser's two facts about the rail: it has no box while collapsed,
  // but its computed width still reports its media-query bracket.
  const naturalWidth = () => (viewport <= 980 ? 220 : 250);
  rail.offsetWidth = () => (workspace.classList.has('rail-collapsed') ? 0 : naturalWidth());
  app.getComputedStyle = (node) => ({ width: node === rail ? `${naturalWidth()}px` : '0px' });

  const vars = new Map();
  app.document.documentElement.style = {
    setProperty: (k, v) => vars.set(k, v),
    removeProperty: (k) => vars.delete(k),
  };
  Object.defineProperty(app.document.documentElement, 'clientWidth', { get: () => viewport, configurable: true });

  // Point the controller's cached element map at this harness.
  state.tabs = [{ key: 'x', kind: 'output', el: new FakeNode('div'), panel: new FakeNode('section'), labelEl: new FakeNode('button'), markEl: new FakeNode('span') }];
  state.expanded = false;
  state.ratio = 0.55;
  state.railWidth = 0;
  el.workspace = workspace;
  el.rail = rail;
  el.pane = new FakeNode('aside');
  el.resize = new FakeNode('div');
  el.back = new FakeNode('button');
  el.tabs = new FakeNode('div');
  el.overflow = new FakeNode('button');
  el.overflowList = new FakeNode('div');
  WorkPane._useElements(el);

  return {
    setViewport: (w) => { viewport = w; },
    layout: () => WorkPane.layout(),
    read: () => ({
      railCollapsed: workspace.classList.has('rail-collapsed'),
      narrow: workspace.classList.has('work-narrow'),
      railWidth: workspace.classList.has('rail-collapsed') ? 0 : naturalWidth(),
      paneVarSet: vars.has('--work-pane-width'),
      paneWidth: Number(String(vars.get('--work-pane-width') || '0').replace('px', '')),
    }),
  };
}
