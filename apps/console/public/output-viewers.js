// The format viewers. Each one implements canView(metadata), mount(container,
// revision) and dispose(); cancellation, keyboard behaviour, the toolbar and
// the download fallback belong to the shell, so a viewer is only ever asked
// to turn text it was handed into readable DOM.
//
// The security posture is inherited, not re-invented: the server validated
// the format before anything reached here, Markdown goes through the app's
// existing escape-first renderer with its closed tag set, and every other
// viewer writes with textContent. Nothing in this file creates a <script>,
// an <img>, an <a href>, an iframe or a remote request, and no viewer
// evaluates the content it is showing.

// ---- CSV / TSV ----
//
// A real RFC 4180 state machine rather than a split on commas: a quoted field
// may contain the delimiter, a newline, or a doubled quote, and a "checklist"
// whose rows silently shear in half at the first quoted comma is worse than
// no preview at all. Bounded on the way in — a preview is a look, not a load.

function parseDelimited(text, delimiter, { maxRows = 200, maxCols = 30 } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let truncatedRows = false;
  let truncatedCols = false;
  let i = 0;

  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else truncatedCols = true;
    field = '';
  };
  const endRow = () => {
    endField();
    if (rows.length < maxRows) rows.push(row);
    else truncatedRows = true;
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i += 1; continue; }
    if (ch === delimiter) { endField(); i += 1; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i += 1; endRow(); i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; i += 1;
    if (truncatedRows) break;  // stop scanning once the preview is full
  }
  if (field !== '' || row.length || quoted) endRow();
  // A trailing newline produces one empty row; it is not data.
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return { rows, truncatedRows, truncatedCols };
}

// ---- JSON ----
//
// Parsed with a reviver that drops __proto__ outright: nothing here merges
// objects, but a key that can shadow a prototype has no business surviving a
// parse in the first place. Rendering is bounded by depth and by node count,
// so a 40-level structure degrades into a labelled "…" instead of a page that
// never finishes laying out.

const JSON_MAX_DEPTH = 12;
const JSON_MAX_NODES = 4000;

function parseJsonSafely(text) {
  return JSON.parse(text, function reviver(key, value) {
    if (key === '__proto__' || key === 'constructor') return undefined;
    return value;
  });
}

function jsonNode(value, depth, budget) {
  if (budget.count++ > JSON_MAX_NODES) {
    const more = document.createElement('span');
    more.className = 'json-more';
    more.textContent = '… (too large to show in full — use Source or Download)';
    return more;
  }
  if (value === null || typeof value !== 'object') {
    const leaf = document.createElement('span');
    leaf.className = `json-${value === null ? 'null' : typeof value}`;
    leaf.textContent = typeof value === 'string' ? JSON.stringify(value) : String(value);
    return leaf;
  }
  if (depth >= JSON_MAX_DEPTH) {
    const deep = document.createElement('span');
    deep.className = 'json-more';
    deep.textContent = Array.isArray(value) ? `[…] (${value.length} items, nested too deep to show)` : '{…} (nested too deep to show)';
    return deep;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const details = document.createElement('details');
  details.className = 'json-branch';
  if (depth < 2) details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = Array.isArray(value)
    ? `[ ] ${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `{ } ${entries.length} key${entries.length === 1 ? '' : 's'}`;
  details.appendChild(summary);
  const list = document.createElement('div');
  list.className = 'json-children';
  for (const [key, child] of entries) {
    const row = document.createElement('div');
    row.className = 'json-row';
    const name = document.createElement('span');
    name.className = 'json-key';
    name.textContent = Array.isArray(value) ? `${key}:` : `${JSON.stringify(key)}:`;
    row.append(name, jsonNode(child, depth + 1, budget));
    list.appendChild(row);
    if (budget.count > JSON_MAX_NODES) break;
  }
  details.appendChild(list);
  return details;
}

// ---- the viewers ----

function sourceBlock(text, language) {
  const wrap = document.createElement('div');
  wrap.className = 'doc-source';
  const pre = document.createElement('pre');
  pre.className = 'doc-pre';
  if (language) pre.setAttribute('data-language', language);
  const code = document.createElement('code');
  code.textContent = text;          // inert by construction: never innerHTML
  pre.appendChild(code);
  wrap.appendChild(pre);
  return wrap;
}

const markdownViewer = {
  id: 'markdown',
  label: 'Document',
  canView: (meta) => meta.format === 'markdown',
  mount(container, revision) {
    const doc = document.createElement('article');
    doc.className = 'doc-body';
    // The app's own renderer: escape first, then a closed set of tags. The
    // document heading mode starts at h1 — a document's own hierarchy, not
    // chat's h3-and-below.
    doc.innerHTML = renderMarkdown(revision.content, { headingBase: 1 });
    container.appendChild(doc);
  },
};

const codeViewer = {
  id: 'code',
  label: 'Source',
  canView: (meta) => meta.format === 'code' || meta.format === 'text',
  mount(container, revision) {
    container.appendChild(sourceBlock(revision.content, revision.language || null));
  },
};

const jsonViewer = {
  id: 'json',
  label: 'Structure',
  canView: (meta) => meta.format === 'json',
  mount(container, revision) {
    let parsed;
    try { parsed = parseJsonSafely(revision.content); }
    catch (err) {
      const note = document.createElement('p');
      note.className = 'work-note';
      note.textContent = `This file is not valid JSON (${err.message}). Showing the source.`;
      container.append(note, sourceBlock(revision.content, 'json'));
      return;
    }
    const tree = document.createElement('div');
    tree.className = 'json-tree';
    tree.appendChild(jsonNode(parsed, 0, { count: 0 }));
    container.appendChild(tree);
  },
};

const tableViewer = {
  id: 'table',
  label: 'Table',
  canView: (meta) => meta.format === 'csv' || meta.format === 'tsv',
  mount(container, revision) {
    const delimiter = revision.format === 'tsv' ? '\t' : ',';
    const { rows, truncatedRows, truncatedCols } = parseDelimited(revision.content, delimiter);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'work-note';
      empty.textContent = 'This file has no rows to preview.';
      container.appendChild(empty);
      return;
    }
    if (truncatedRows || truncatedCols) {
      const note = document.createElement('p');
      note.className = 'work-note';
      note.textContent = `Previewing the first ${rows.length} row${rows.length === 1 ? '' : 's'}`
        + (truncatedCols ? ' and 30 columns' : '')
        + '. Download the file for everything.';
      container.appendChild(note);
    }
    const scroll = document.createElement('div');
    scroll.className = 'doc-table-scroll';
    const table = document.createElement('table');
    table.className = 'doc-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const cell of rows[0]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = cell;   // a cell is text: no formula is ever evaluated
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    for (const row of rows.slice(1)) {
      const tr = document.createElement('tr');
      for (let i = 0; i < rows[0].length; i++) {
        const td = document.createElement('td');
        td.textContent = row[i] ?? '';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.append(head, body);
    scroll.appendChild(table);
    container.appendChild(scroll);
  },
};

// The last resort: metadata and source where it is safe, and always the
// download. A renderer is never guessed from a filename.
const fallbackViewer = {
  id: 'source',
  label: 'Source',
  canView: () => true,
  mount(container, revision) {
    container.appendChild(sourceBlock(revision.content, revision.language || null));
  },
};

const OUTPUT_VIEWERS = [markdownViewer, jsonViewer, tableViewer, codeViewer, fallbackViewer];

function viewerFor(metadata) {
  return OUTPUT_VIEWERS.find((v) => v.canView(metadata)) || fallbackViewer;
}

if (typeof window !== 'undefined') {
  window.OUTPUT_VIEWERS = OUTPUT_VIEWERS;
  window.viewerFor = viewerFor;
  window.parseDelimited = parseDelimited;
  window.parseJsonSafely = parseJsonSafely;
  window.sourceBlock = sourceBlock;
}
