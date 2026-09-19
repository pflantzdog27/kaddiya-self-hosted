// The browser side of the artifact workspace: the API client, the document
// resource (toolbar, versions, copy, download), the conversation's Files
// list, the chat file card, "Save as document", and the composer reference.
//
// Two rules run through all of it.
//
// URLs are built here from validated ids, never taken from model text or from
// an event payload: an `output_saved` event is an invalidation notice, and the
// browser answers it by asking the authenticated API what is true. A download
// is an ordinary same-origin link to that API, so it still works after a
// reload — it was never an in-memory Blob that a refresh throws away.
//
// A response that arrives late is dropped rather than rendered. Every fetch
// carries the conversation and resource it was issued for, and an abort
// controller that dispose() trips, so a slow answer for conversation A cannot
// paint into B.

const OutputsApi = (() => {
  const json = async (res) => {
    if (res.status === 401) { location.assign('/signin'); throw new Error('signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
    return data;
  };
  const uuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  return {
    isId: uuid,
    async list(conversationId, { cursor, signal } = {}) {
      if (!uuid(conversationId)) return { outputs: [], next_cursor: null };
      const url = new URL(`/api/conversations/${conversationId}/outputs`, location.origin);
      if (cursor) url.searchParams.set('cursor', cursor);
      return json(await fetch(url, { signal }));
    },
    async read(outputId, { revision = null, signal } = {}) {
      if (!uuid(outputId)) throw new Error('not found');
      const url = new URL(`/api/outputs/${outputId}`, location.origin);
      if (revision) url.searchParams.set('revision', String(revision));
      return json(await fetch(url, { signal }));
    },
    async revisions(outputId, { signal } = {}) {
      if (!uuid(outputId)) throw new Error('not found');
      return json(await fetch(`/api/outputs/${outputId}/revisions`, { signal }));
    },
    async save(conversationId, body) {
      return json(await fetch(`/api/conversations/${conversationId}/outputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
    },
    /** The only place a download URL is constructed. Both ids are validated. */
    downloadUrl(outputId, revision) {
      if (!uuid(outputId) || !Number.isInteger(revision) || revision < 1) return null;
      return `/api/outputs/${outputId}/download?revision=${revision}`;
    },
  };
})();

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FORMAT_LABELS = {
  markdown: 'Document', text: 'Text', code: 'Code', json: 'JSON', csv: 'Table (CSV)', tsv: 'Table (TSV)',
};

// ---- the document resource ----

const outputResource = {
  key: (r) => `output:${r.outputId}`,
  describe: (r) => ({ label: r.title || 'File' }),

  async mount(container, resource, api) {
    const controller = new AbortController();
    container._abort = controller;
    const conversationAtMount = activeConversationId();

    const head = document.createElement('header');
    head.className = 'doc-head';
    const title = document.createElement('h2');
    title.className = 'doc-title';
    title.tabIndex = -1;
    title.setAttribute('data-work-heading', '');
    title.textContent = resource.title || 'Loading…';
    const meta = document.createElement('p');
    meta.className = 'doc-meta';
    meta.textContent = 'Loading…';
    head.append(title, meta);

    const toolbar = document.createElement('div');
    toolbar.className = 'doc-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'File actions');

    const modes = document.createElement('div');
    modes.className = 'doc-modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'View mode');
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'doc-mode is-on';
    previewBtn.textContent = 'Preview';
    previewBtn.setAttribute('aria-pressed', 'true');
    const sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'doc-mode';
    sourceBtn.textContent = 'Source';
    sourceBtn.setAttribute('aria-pressed', 'false');
    modes.append(previewBtn, sourceBtn);

    const versionLabel = document.createElement('label');
    versionLabel.className = 'doc-version-label';
    versionLabel.textContent = 'Version';
    const versions = document.createElement('select');
    versions.className = 'doc-versions';
    versionLabel.appendChild(versions);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'doc-action';
    copy.textContent = 'Copy';

    const download = document.createElement('a');
    download.className = 'doc-action';
    download.textContent = 'Download';
    download.setAttribute('download', '');

    toolbar.append(modes, versionLabel, copy, download);

    const stale = document.createElement('div');
    stale.className = 'doc-stale';
    stale.hidden = true;

    const view = document.createElement('div');
    view.className = 'doc-view';

    container.append(head, toolbar, stale, view);

    let current = null;      // the revision being shown
    let mode = 'preview';

    const paint = () => {
      if (!current) return;
      view.replaceChildren();
      if (mode === 'source') {
        view.appendChild(sourceBlock(current.content, current.language || current.format));
        return;
      }
      try {
        viewerFor(current).mount(view, current);
      } catch (err) {
        const note = document.createElement('p');
        note.className = 'work-note';
        note.textContent = 'Preview unavailable. The file is saved — use Source or Download.';
        view.append(note, sourceBlock(current.content, current.language || current.format));
        console.error('viewer failed:', err);
      }
    };

    const setMode = (next) => {
      mode = next;
      previewBtn.classList.toggle('is-on', next === 'preview');
      sourceBtn.classList.toggle('is-on', next === 'source');
      previewBtn.setAttribute('aria-pressed', String(next === 'preview'));
      sourceBtn.setAttribute('aria-pressed', String(next === 'source'));
      paint();
    };
    previewBtn.addEventListener('click', () => setMode('preview'));
    sourceBtn.addEventListener('click', () => setMode('source'));

    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(current?.content || '');
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch {
        // A refused clipboard is a visible state, not a silent no-op.
        copy.textContent = 'Press ⌘C';
        setMode('source');
        const pre = view.querySelector('pre');
        if (pre) {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        setTimeout(() => { copy.textContent = 'Copy'; }, 2500);
      }
    });

    const show = async (revision) => {
      // A response for another conversation, or for a pane that has since
      // been disposed, is dropped rather than painted.
      const data = await OutputsApi.read(resource.outputId, { revision, signal: controller.signal });
      if (controller.signal.aborted || activeConversationId() !== conversationAtMount) return;
      current = data;
      resource.title = data.title;
      resource.revision = data.revision;
      title.textContent = data.title;
      api.setLabel(data.title);
      meta.textContent = `Saved · ${FORMAT_LABELS[data.format] || data.format} · ${data.filename} · ${formatBytes(data.byte_length)}`;
      download.href = OutputsApi.downloadUrl(resource.outputId, data.revision) || '#';
      download.setAttribute('download', data.filename);
      download.title = `Download version ${data.revision} of ${data.filename}`;
      const behind = data.revision < data.current_revision;
      stale.hidden = !behind;
      if (behind) {
        stale.replaceChildren();
        const text = document.createElement('span');
        text.textContent = `Viewing v${data.revision} · latest v${data.current_revision}`;
        const latest = document.createElement('button');
        latest.type = 'button';
        latest.className = 'doc-action';
        latest.textContent = 'Go to latest';
        latest.addEventListener('click', () => { versions.value = String(data.current_revision); show(data.current_revision); });
        stale.append(text, latest);
      }
      paint();
    };

    const loadVersions = async () => {
      try {
        const list = await OutputsApi.revisions(resource.outputId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        versions.replaceChildren();
        for (const r of list.revisions) {
          const option = document.createElement('option');
          option.value = String(r.revision);
          option.textContent = r.revision === list.current_revision ? `v${r.revision} · latest` : `v${r.revision}`;
          versions.appendChild(option);
        }
        versions.value = String(current?.revision ?? list.current_revision);
        versionLabel.hidden = list.revisions.length < 2;
      } catch { versionLabel.hidden = true; }
    };
    versions.addEventListener('change', () => show(Number(versions.value)));

    container._refresh = async ({ revision } = {}) => {
      await show(revision ?? null);
      await loadVersions();
    };

    try {
      await show(resource.revision ?? null);
      await loadVersions();
    } catch (err) {
      if (controller.signal.aborted) return;
      head.hidden = false;
      meta.textContent = '';
      view.replaceChildren();
      const note = document.createElement('p');
      note.className = 'work-note';
      note.textContent = /not found/i.test(err.message)
        ? 'This file is no longer available. It may have been removed with its conversation.'
        : `Could not open this file. ${err.message}`;
      title.textContent = resource.title || 'File unavailable';
      view.appendChild(note);
    }
  },

  dispose(container) {
    container._abort?.abort();
    container._abort = null;
    container._refresh = null;
  },
};

// ---- the conversation's Files list ----

const filesResource = {
  key: () => 'files',
  transient: false,
  describe: () => ({ label: 'Files' }),

  async mount(container, resource, api) {
    const controller = new AbortController();
    container._abort = controller;
    const conversationId = resource.conversationId;

    const head = document.createElement('header');
    head.className = 'doc-head';
    const title = document.createElement('h2');
    title.className = 'doc-title';
    title.tabIndex = -1;
    title.setAttribute('data-work-heading', '');
    title.textContent = 'Files';
    const meta = document.createElement('p');
    meta.className = 'doc-meta';
    meta.textContent = 'Everything saved in this conversation.';
    head.append(title, meta);
    const list = document.createElement('div');
    list.className = 'files-list';
    // A placeholder, not an empty box: if the answer is dropped as stale —
    // because the person switched conversations while it was in flight — the
    // pane must not sit there looking like an empty folder.
    const loading = document.createElement('p');
    loading.className = 'work-note';
    loading.textContent = 'Loading…';
    list.appendChild(loading);
    container.append(head, list);

    const render = (outputs) => {
      list.replaceChildren();
      if (!outputs.length) {
        const empty = document.createElement('p');
        empty.className = 'work-note';
        empty.textContent = 'No files yet. Ask for a document, a checklist or a script and it will appear here.';
        list.appendChild(empty);
        return;
      }
      for (const out of outputs) {
        const row = document.createElement('div');
        row.className = 'files-row';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'files-open';
        const name = document.createElement('span');
        name.className = 'files-name';
        name.textContent = out.title;
        const sub = document.createElement('span');
        sub.className = 'files-sub';
        sub.textContent = `${out.filename} · v${out.current_revision} · ${formatBytes(out.byte_length)}`;
        open.append(name, sub);
        open.addEventListener('click', () => WorkPane.open(
          { kind: 'output', outputId: out.output_id, title: out.title },
          { reason: 'user', opener: open },
        ));
        const grab = document.createElement('a');
        grab.className = 'doc-action';
        grab.textContent = 'Download';
        grab.href = OutputsApi.downloadUrl(out.output_id, out.current_revision) || '#';
        grab.setAttribute('download', out.filename);
        row.append(open, grab);
        list.appendChild(row);
      }
    };

    container._refreshOnActivate = true;
    container._refresh = async () => {
      try {
        const page = await OutputsApi.list(conversationId, { signal: controller.signal });
        if (controller.signal.aborted || activeConversationId() !== conversationId) return;
        render(page.outputs);
        setFilesCount(page.outputs.length);
      } catch (err) {
        list.replaceChildren();
        const note = document.createElement('p');
        note.className = 'work-note';
        note.textContent = `Could not list this conversation's files. ${err.message}`;
        list.appendChild(note);
      }
    };
    await container._refresh();
  },

  dispose(container) {
    container._abort?.abort();
    container._abort = null;
    container._refresh = null;
  },
};

// ---- the chat file card ----

function makeOutputCard(ref) {
  const card = document.createElement('div');
  card.className = 'nc-card output-card';
  card.setAttribute('data-output-id', ref.output_id);

  const head = document.createElement('div');
  head.className = 'output-card-head';
  const name = document.createElement('span');
  name.className = 'output-card-title';
  name.textContent = ref.title;
  const kind = document.createElement('span');
  kind.className = 'output-card-kind';
  kind.textContent = FORMAT_LABELS[ref.format] || ref.format;
  head.append(name, kind);

  const sub = document.createElement('div');
  sub.className = 'output-card-sub';
  sub.textContent = `${ref.filename} · v${ref.revision} · ${formatBytes(ref.byte_length)}`;

  const actions = document.createElement('div');
  actions.className = 'output-card-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn-ghost';
  open.textContent = 'Open';
  open.addEventListener('click', () => WorkPane.open(
    { kind: 'output', outputId: ref.output_id, revision: ref.revision, title: ref.title },
    { reason: 'user', opener: open },
  ));
  const grab = document.createElement('a');
  grab.className = 'btn-ghost';
  grab.textContent = 'Download';
  grab.href = OutputsApi.downloadUrl(ref.output_id, ref.revision) || '#';
  grab.setAttribute('download', ref.filename);
  const use = document.createElement('button');
  use.type = 'button';
  use.className = 'btn-ghost';
  use.textContent = 'Use as context';
  use.addEventListener('click', () => OutputContext.set(ref));
  actions.append(open, grab, use);

  card.append(head, sub, actions);
  return card;
}

/** The "Creating…" placeholder a tool card becomes while a save is in flight. */
function makeOutputPending(label) {
  const card = document.createElement('div');
  card.className = 'nc-card output-card is-pending';
  const head = document.createElement('div');
  head.className = 'output-card-head';
  const name = document.createElement('span');
  name.className = 'output-card-title';
  name.textContent = label || 'Creating file…';
  head.appendChild(name);
  card.appendChild(head);
  return card;
}

// ---- "Save as document" ----
//
// A reply a person can already read becomes a file they can keep, with no
// second model call. It is also the dependable fallback when a provider
// answers inline instead of calling the tool.

async function saveAsDocument(text, button) {
  const conversationId = activeConversationId();
  if (!conversationId || !String(text || '').trim()) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const title = titleFromMarkdown(text);
    const ref = await OutputsApi.save(conversationId, {
      title,
      filename: title,
      format: 'markdown',
      content: text,
      operation_id: crypto.randomUUID(),
    });
    button.textContent = 'Saved';
    const card = makeOutputCard(ref);
    button.closest('.bubble')?.appendChild(card);
    button.remove();
    await WorkPane.open({ kind: 'output', outputId: ref.output_id, revision: ref.revision, title: ref.title },
      { reason: 'user', opener: card.querySelector('button') });
    refreshFilesCount();
  } catch (err) {
    button.disabled = false;
    button.textContent = original;
    const note = document.createElement('div');
    note.className = 'work-note';
    note.textContent = `Could not save that as a file. ${err.message}`;
    button.parentElement?.appendChild(note);
  }
}

function titleFromMarkdown(text) {
  const heading = String(text).match(/^\s{0,3}#{1,3}\s+(.+)$/m);
  const line = heading ? heading[1] : String(text).split('\n').find((l) => l.trim());
  return (line || 'Document').replace(/[*_`#]/g, '').trim().slice(0, 80) || 'Document';
}

// ---- the composer reference ----
//
// Context is explicit or it is not context. A chip says which file and which
// version will travel with the next message; removing it removes that. Merely
// reading a file never sends it anywhere, and switching resources does not
// silently rewrite a request already typed — the chip is captured at submit.

const OutputContext = (() => {
  let current = null;
  function render() {
    const host = document.getElementById('output-context');
    if (!host) return;
    host.replaceChildren();
    host.hidden = !current;
    if (!current) return;
    const chip = document.createElement('span');
    chip.className = 'context-chip';
    const label = document.createElement('span');
    label.className = 'context-chip-label';
    label.textContent = `${current.title} · v${current.revision}`;
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'context-chip-remove';
    drop.setAttribute('aria-label', `Stop sending ${current.title} with the next message`);
    drop.textContent = '✕';
    drop.addEventListener('click', () => { current = null; render(); document.getElementById('input')?.focus(); });
    chip.append(label, drop);
    const hint = document.createElement('span');
    hint.className = 'context-chip-hint';
    hint.textContent = 'sent with your next message';
    host.append(chip, hint);
  }
  return {
    set(ref) {
      if (!ref?.output_id) return;
      current = { output_id: ref.output_id, revision: ref.revision, title: ref.title };
      render();
      document.getElementById('input')?.focus();
    },
    clear() { current = null; render(); },
    /** Captured at submit, so a later tab switch cannot change what was sent. */
    capture() { return current ? { ...current } : null; },
    peek: () => current,
    render,
  };
})();

// ---- the Files count in the thread header ----

function setFilesCount(n) {
  const button = document.getElementById('files-button');
  const count = document.getElementById('files-count');
  if (!button || !count) return;
  count.textContent = String(n);
  button.hidden = n === 0;
}

async function refreshFilesCount() {
  const conversationId = activeConversationId();
  if (!conversationId) return setFilesCount(0);
  try {
    const page = await OutputsApi.list(conversationId);
    if (activeConversationId() !== conversationId) return;
    setFilesCount(page.outputs.length);
  } catch { /* the header count is not worth an error state */ }
}

/** Repaint an open Files list and document after something committed. */
function refreshOpenOutputs({ outputId, revision } = {}) {
  for (const panel of document.querySelectorAll('.work-panel')) {
    if (!panel._refresh) continue;
    if (panel.id === 'work-panel-files') panel._refresh();
    else if (outputId && panel.id === `work-panel-output_${String(outputId).replace(/[^a-zA-Z0-9_-]/g, '_')}`) {
      panel._refresh({ revision });
    }
  }
}

if (typeof window !== 'undefined') {
  window.OutputsApi = OutputsApi;
  window.OutputContext = OutputContext;
  window.makeOutputCard = makeOutputCard;
  window.makeOutputPending = makeOutputPending;
  window.saveAsDocument = saveAsDocument;
  window.titleFromMarkdown = titleFromMarkdown;
  window.formatBytes = formatBytes;
  window.outputResource = outputResource;
  window.filesResource = filesResource;
}

if (typeof WorkResources !== 'undefined') {
  WorkResources.register('output', outputResource);
  WorkResources.register('files', filesResource);
}
