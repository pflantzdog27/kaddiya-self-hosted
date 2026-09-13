const chat = document.getElementById('chat');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const welcome = document.getElementById('welcome');
const nextHint = document.getElementById('next-hint');
const DEFAULT_PLACEHOLDER = input.placeholder;

let busy = false;
let sessionCost = 0;
let sessionTurns = 0;
let currentConv = null;
let me = null; // { user, instance_host, model_id, ... } from /api/me
let currentRun = null;                 // the run object of the open conversation, if it is a run
let runBusy = false;                   // a stage is streaming
let runStopRequested = false;
let runRequestController = null;
const proposalCards = new Map();       // proposal_id → card (ADR 0011: plan-committed cards flip in place)
const pendingFiles = [];               // attachments queued for the next message
let nextStep = null;                   // the last reply's suggested next step; the composer's placeholder, Tab accepts it

if (!document.body.hasAttribute('data-preview')) init();

async function init() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) return location.assign('/signin');
    const data = await res.json();
    if (res.status === 403) return location.assign('/pending');
    me = {
      name: data.user?.name || data.user?.user_name || 'Signed in',
      user_name: data.user?.user_name || '',
      instance_host: new URL(data.instance).host,
      model_id: data.model_id || data.model,
      effort: data.effort || '',
      provider: data.model_provider || 'env',
      provider_label: data.model_provider_label || 'your key',
      admin: !!data.admin,
      org: data.org || null,
      plan: data.plan || null,
      usage: data.usage || null,
      gate: data.gate || null,
      autonomous_available: data.autonomous_available === true,
      instance_non_production: data.instance_non_production === true,
      models: Array.isArray(data.models) ? data.models : [],
      default_model: data.default_model || data.model_id || data.model,
    };
    document.getElementById('who-name').innerHTML =
      `<span class="who-line1">${escapeHtml(me.name)}</span><span class="who-line2">${escapeHtml(me.instance_host)}</span>`;
    document.getElementById('who-avatar').textContent = initialsOf(me.name);
    renderModelBadge();
    renderModelSelect();
    if (me.admin) document.getElementById('admin-link').hidden = false;
  } catch { /* header stays generic */ }

  document.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => { input.value = chip.textContent.trim(); form.requestSubmit(); }));

  document.getElementById('panel-close').addEventListener('click', () => {
    document.getElementById('panel').hidden = true;
  });

  document.getElementById('new-chat').addEventListener('click', () => startNewChat());
  initWorkMode();
  initAttachments();
  // Copy buttons on code blocks: delegated, because the blocks are rendered
  // from markdown and the CSP forbids inline handlers.
  chat.addEventListener('click', async (e) => {
    const btn = e.target.closest('.codeblock-copy');
    if (!btn) return;
    const pre = btn.closest('.codeblock')?.querySelector('pre');
    try {
      await navigator.clipboard.writeText(pre?.textContent || '');
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    } catch { btn.textContent = 'Select and copy'; }
  });
  document.getElementById('who').addEventListener('click', showProfile);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); startNewChat(); }
  });

  await refreshConversations();

  input.addEventListener('keydown', composerKeys);
  input.addEventListener('input', () => { autoGrow(); renderNextHint(); });

  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
}

// The badge says whose credential this turn runs on (ADR 0008 D9): the
// trial allowance and what is left of it, the org's own key, or the .env key.
function renderModelBadge() {
  if (!me) return;
  const badge = document.getElementById('model-badge');
  const connection = me.models?.find(m => m.id === selectedModel());
  const provider = connection?.provider || me.provider;
  let text = connection?.model_id || connection?.label || me.model_id;
  if (provider === 'trial') {
    const left = Math.max(0, (me.plan?.trial_budget_usd || 5) - (me.usage?.trial_spend_usd || 0));
    text += ` · preview · $${left.toFixed(2)} left`;
  } else text += me.plan?.id === 'free' ? ' · not available on the preview' : ' · your API · no Kaddiya cap';
  badge.textContent = text;
  badge.title = 'Choose a tested model connection. Your provider’s charges and rate limits still apply.';
}

// The plan gate answered before the model was called: the meter is the
// contract, so this card is the whole response to that turn.
function makePaywallCard(data) {
  const card = document.createElement('div');
  card.className = 'nc-card pending paywall';
  card.innerHTML = `
    <div class="nc-head">
      <span class="dot amber"></span>
      <span class="nc-title">${escapeHtml(data.plan?.label || 'Free')} plan</span>
      <span class="nc-head-right amber">${escapeHtml(String(data.reason || 'limit').replace(/_/g, ' '))}</span>
    </div>
    <div class="nc-body"></div>
    <div class="nc-foot">
      <span class="nc-caption"></span>
    </div>`;
  card.querySelector('.nc-body').textContent = data.message || 'This turn was not run.';
  const foot = card.querySelector('.nc-foot');
  const caption = card.querySelector('.nc-caption');
  if (data.admin) {
    caption.textContent = 'You are an org admin.';
    const a = document.createElement('a');
    a.className = 'btn-primary as-link';
    a.href = '/admin';
    a.textContent = 'Open admin';
    foot.appendChild(a);
  } else {
    caption.textContent = 'Ask an org admin: they can add a model key under Admin → Model.';
  }
  return card;
}

// Enter sends; Tab takes the suggested next step; Escape declines it.
function composerKeys(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  else if (e.key === 'Tab' && !e.shiftKey && nextStep && !input.value) { e.preventDefault(); acceptNextStep(); }
  else if (e.key === 'Escape' && nextStep && !input.value) setNextStep(null);
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

// The suggested next step rides in the composer as its placeholder, so it
// reads as a draft rather than a message. It is text to send or ignore;
// nothing runs from it, and the model's next turn still needs a send.
function setNextStep(text) {
  nextStep = text ? String(text).trim().slice(0, 160) : null;
  input.placeholder = nextStep || DEFAULT_PLACEHOLDER;
  renderNextHint();
}

function renderNextHint() {
  nextHint.hidden = !(nextStep && !input.value);
}

function acceptNextStep() {
  if (!nextStep) return;
  input.value = nextStep;
  input.setSelectionRange(input.value.length, input.value.length);
  autoGrow();
  renderNextHint();
}

async function send() {
  const text = input.value.trim();
  if (!text || busy || runBusy || currentRun?.status === 'active') return;
  if (document.getElementById('work-mode')?.value !== 'review') return startStagedTask(text);
  busy = true;
  sendBtn.disabled = true;
  input.value = '';
  autoGrow();
  setNextStep(null);
  document.querySelector('.welcome')?.remove();
  if (!currentConv) setThreadTitle(text.length > 64 ? text.slice(0, 64) + '…' : text);

  const attachments = pendingFiles.splice(0, pendingFiles.length);
  renderAttachmentChips();
  addBubble('user', text, attachments.map((a) => a.name));
  const assistant = addBubble('assistant', '');
  const textEl = assistant.querySelector('.md');
  let raw = '';
  const toolCards = new Map();
  let suggested = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversation_id: currentConv, model: selectedModel() || undefined, attachments }),
    });
    if (res.status === 401) return location.assign('/signin');
    if (!res.ok || !res.body) throw new Error(`Server error (${res.status})`);

    for await (const { event, data } of sseEvents(res.body)) {
      if (handleSharedEvent(event, data, assistant, textEl, toolCards)) continue;
      if (event === 'conversation') {
        currentConv = data.id;
      } else if (event === 'text') {
        raw += data.delta;
        textEl.innerHTML = renderMarkdown(raw);
      } else if (event === 'tool_start') {
        const card = makeToolCard(data);
        toolCards.set(data.id, card);
        assistant.insertBefore(card, textEl);
      } else if (event === 'tool_end') {
        finishToolCard(toolCards.get(data.id), data);
      } else if (event === 'paywall') {
        assistant.insertBefore(makePaywallCard(data), textEl);
      } else if (event === 'suggest') {
        suggested = data.text;
      } else if (event === 'done') {
        assistant.appendChild(makeUsageLine(data));
        recordSpend(data.cost);
        if (me && (me.models?.find(m => m.id === selectedModel())?.provider || me.provider) === 'trial' && me.usage) {
          me.usage.trial_spend_usd = (me.usage.trial_spend_usd || 0) + (data.cost || 0);
          renderModelBadge();
        }
      } else if (event === 'error') {
        raw += `\n\n**Error:** ${data.message}`;
        textEl.innerHTML = renderMarkdown(raw);
      }
      scrollDown();
    }
  } catch (err) {
    textEl.innerHTML = renderMarkdown(raw + `\n\n**Connection error:** ${err.message}`);
  } finally {
    for (const card of toolCards.values()) stopToolTimer(card);
    busy = false;
    sendBtn.disabled = false;
    setNextStep(suggested);
    input.focus();
    scrollDown();
    refreshConversations(); // picks up the auto-derived title
  }
}

function addBubble(role, text, attachmentNames) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  const md = document.createElement('div');
  md.className = 'md';
  // A stored user message carries its attachments inline (see /api/chat);
  // show the file names as chips rather than the contents.
  let names = attachmentNames || [];
  if (role === 'user' && !attachmentNames) {
    const parts = String(text).split(/\n\n---\nAttached file: /);
    if (parts.length > 1) {
      text = parts[0];
      names = parts.slice(1).map((p) => p.split(' (')[0]);
    }
  }
  md.innerHTML = renderMarkdown(text);
  if (names.length) {
    const chips = document.createElement('div');
    chips.className = 'attachments in-bubble';
    for (const n of names) {
      const c = document.createElement('span');
      c.className = 'attachment';
      c.textContent = n;
      chips.appendChild(c);
    }
    md.appendChild(chips);
  }
  el.appendChild(md);
  chat.appendChild(el);
  scrollDown();
  return el;
}

// ---- tool cards ----
// Header: status dot · mono label · timing/rows · expand affordance.
// Body: the real encoded query. Expanded: a preview of the rows that came back.

function makeToolCard({ name, input: toolInput }) {
  const card = document.createElement('div');
  card.className = 'tool-card running';
  card.innerHTML = `
    <div class="tool-head">
      <span class="dot amber pulse-run"></span>
      <span class="tool-label">${escapeHtml(toolLabel(name, toolInput))}</span>
      <span class="tool-meta">running · 0.0 s</span>
      <span class="tool-chev" hidden>+</span>
    </div>
    <div class="tool-query">${escapeHtml(machineLine(name, toolInput))}</div>`;

  // While running, the amber dot pulses and the timing counts up.
  const started = Date.now();
  const meta = card.querySelector('.tool-meta');
  card._timer = setInterval(() => {
    meta.textContent = `running · ${((Date.now() - started) / 1000).toFixed(1)} s`;
  }, 100);
  return card;
}

function stopToolTimer(card) {
  if (card?._timer) { clearInterval(card._timer); card._timer = null; }
}

function finishToolCard(card, { ms, summary, error, preview }) {
  if (!card) return;
  stopToolTimer(card);
  card.classList.remove('running');
  card.classList.add(error ? 'failed' : 'done');
  const dot = card.querySelector('.dot');
  dot.classList.remove('pulse-run');
  dot.classList.toggle('green', !error);
  dot.classList.toggle('amber', !!error);

  const timing = ms != null ? `${(ms / 1000).toFixed(2)} s · ` : '';
  card.querySelector('.tool-meta').textContent = error ? `${timing}failed` : `${timing}${summary}`;

  if (error) {
    const pre = document.createElement('div');
    pre.className = 'tool-error';
    pre.textContent = error;
    card.appendChild(pre);
    return;
  }

  if (Array.isArray(preview) && preview.length) {
    const results = document.createElement('div');
    results.className = 'tool-results';
    results.hidden = true;
    const cols = Object.keys(preview[0]);
    results.innerHTML =
      `<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>` +
      `<tbody>${preview.map((row) =>
        `<tr>${cols.map((c) => `<td>${escapeHtml(valueOf(row[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    card.appendChild(results);

    const chev = card.querySelector('.tool-chev');
    chev.hidden = false;
    card.classList.add('expandable');
    card.querySelector('.tool-head').addEventListener('click', () => {
      results.hidden = !results.hidden;
      chev.textContent = results.hidden ? '+' : '–';
    });
  }
}

function toolLabel(name, input) {
  switch (name) {
    case 'sn_query': return `QUERY · ${input.table}`;
    case 'sn_aggregate': return `AGGREGATE · ${input.table}`;
    case 'sn_schema': return `SCHEMA · ${input.table}`;
    case 'sn_list_tables': return 'TABLES · sys_db_object';
    case 'sn_my_work': return `QUERY · ${input.table || 'task'}`;
    case 'sn_record': return `RECORD · ${input.table}`;
    case 'sn_similar': return `SIMILAR · ${input.table || 'incident'}`;
    case 'sn_update_set': return 'UPDATE SET · current';
    case 'sn_propose_update_set': return 'PROPOSAL · update set';
    case 'sn_update_set_contents': return 'UPDATE SET · contents';
    case 'sn_propose_reply': return `DRAFT · ${input.table}`;
    case 'sn_propose_artifact': return `PROPOSAL · ${input.table}`;
    case 'sn_propose_record_update': return `PROPOSAL · ${input.table}`;
    case 'sn_propose_approval': return 'PROPOSAL · approval';
    case 'sn_propose_artifact_update': return `PROPOSAL · ${input.table}`;
    case 'sn_propose_catalog_order': return 'PROPOSAL · catalog order';
    case 'sn_propose_change': return `PROPOSAL · change · ${input.type}`;
    case 'sn_docs_search': return `DOCS · search${input.publication ? ` · ${input.publication}` : ''}`;
    case 'sn_docs_get': return 'DOCS · topic';
    case 'sn_note_save': return 'NOTEBOOK · proposed note';
    default: return name.replace(/^sn_/, '').replace(/_/g, ' ');
  }
}

// The machine-measured line on each card: the real query where there is one,
// the closest honest equivalent where the server composes it dynamically.
function machineLine(name, input) {
  switch (name) {
    case 'sn_query': {
      let q = input.query || '';
      if (input.order_by) q += `^ORDERBYDESC${input.order_by}`;
      return q || `${input.table} · first ${input.limit || 15} rows`;
    }
    case 'sn_aggregate':
      return `${input.query || 'sysparm_count=true'}${input.group_by ? `^GROUPBY${input.group_by}` : ''}`;
    case 'sn_schema':
      return `sys_dictionary: name=${input.table}^elementISNOTEMPTY`;
    case 'sn_list_tables':
      return `nameLIKE${input.search}^ORlabelLIKE${input.search}`;
    case 'sn_my_work':
      return `active=true^(assigned_to=me^ORassignment_groupINmy groups)^ORDERBYpriority`;
    case 'sn_record':
      return input.sys_id ? `sys_id=${input.sys_id}` : `number=${input.number}`;
    case 'sn_similar':
      return `123TEXTQUERY321=${input.text}^stateIN6,7^ORclose_notesISNOTEMPTY`;
    case 'sn_update_set':
      return 'sys_user_preference: name=sys_update_set';
    case 'sn_propose_update_set':
      return `sys_update_set: name=${input.name}`;
    case 'sn_update_set_contents':
      return `sys_update_xml: update_set=${input.sys_id || 'current'}^ORDERBYDESCsys_created_on`;
    case 'sn_propose_reply':
      return `${input.table}.${input.field} · ${input.sys_id}`;
    case 'sn_propose_artifact':
      return `${input.table} · ${input.fields?.name || ''}`;
    case 'sn_docs_search':
      return input.query;
    case 'sn_docs_get':
      return input.path;
    case 'sn_note_save':
      return `${input.context ? `[${input.context}] ` : ''}${truncate(input.text, 140)}`;
    default:
      return Object.entries(input).map(([k, v]) => `${k}=${v}`).join('^') || name;
  }
}

// ---- conversation sidebar ----

async function refreshConversations() {
  try {
    const res = await fetch('/api/conversations');
    if (!res.ok) return;
    const { conversations } = await res.json();
    renderConversations(conversations);
  } catch { /* sidebar is non-critical */ }
}

function bucketOf(iso) {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return 'Older';
}

function renderConversations(list) {
  const el = document.getElementById('conv-list');
  el.innerHTML = '';

  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned);

  if (pinned.length) {
    el.appendChild(sectionHeader('Pinned'));
    pinned.forEach((c) => el.appendChild(conversationRow(c)));
  }

  let lastBucket = null;
  for (const c of rest) {
    const bucket = bucketOf(c.updated);
    if (bucket !== lastBucket) {
      el.appendChild(sectionHeader(bucket));
      lastBucket = bucket;
    }
    el.appendChild(conversationRow(c));
  }

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = 'No conversations yet.';
    el.appendChild(empty);
  }

  const active = list.find((c) => c.id === currentConv);
  if (active) setThreadTitle(active.title);
}

function sectionHeader(text) {
  const h = document.createElement('div');
  h.className = 'conv-section mono-label';
  h.textContent = text;
  return h;
}

function conversationRow(c) {
  const row = document.createElement('div');
  row.className = 'conv-row' + (c.id === currentConv ? ' active' : '');
  row.innerHTML = `
    <button class="conv-open" type="button" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</button>
    <button class="conv-act pin${c.pinned ? ' pinned' : ''}" type="button" title="${c.pinned ? 'Unpin' : 'Pin'}">${c.pinned ? '★' : '☆'}</button>
    <button class="conv-act del" type="button" title="Delete">✕</button>`;

  row.querySelector('.conv-open').addEventListener('click', () => openConversation(c.id));

  row.querySelector('.pin').addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch(`/api/conversations/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !c.pinned }),
    });
    refreshConversations();
  });

  row.querySelector('.del').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete “${c.title}”? This cannot be undone.`)) return;
    await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
    if (c.id === currentConv) startNewChat();
    refreshConversations();
  });

  return row;
}

function setThreadTitle(text) {
  document.getElementById('conv-title').textContent = text;
}

function startNewChat() {
  if (busy || runBusy) return;
  runStopRequested = true;
  if (document.getElementById('work-mode')) { document.getElementById('work-mode').value = 'review'; syncWorkMode(); }
  currentConv = null;
  currentRun = null;
  proposalCards.clear();
  removeRunRail();
  chat.innerHTML = '';
  chat.appendChild(welcomeBlock());
  document.getElementById('panel').hidden = true;
  setThreadTitle('New chat');
  sessionCost = 0;
  sessionTurns = 0;
  const spend = document.getElementById('spend');
  spend.hidden = true;
  setNextStep(null);
  refreshConversations();
  input.focus();
}

function welcomeBlock() {
  const el = document.createElement('div');
  el.className = 'welcome';
  el.innerHTML = `<h2>What do you want to work on?</h2><div class="suggestions"></div>`;
  const sugg = el.querySelector('.suggestions');
  for (const text of [
    "What's on my docket today — start with the highest priority case assigned to me or my group.",
    'How many open incidents are there, by priority?',
    'Show me the schema of the incident table',
    'What does an update set actually capture? Check the docs for our release.',
  ]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = text;
    chip.addEventListener('click', () => { input.value = text; form.requestSubmit(); });
    sugg.appendChild(chip);
  }
  return el;
}

/** Replay a stored conversation into the transcript. */
async function openConversation(id) {
  if (busy || runBusy) return;
  runStopRequested = true;
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) return;
  const conv = await res.json();
  currentConv = conv.id;
  currentRun = conv.run || null;
  proposalCards.clear();
  setNextStep(null);
  chat.innerHTML = '';
  removeRunRail();
  document.getElementById('panel').hidden = true;
  setThreadTitle(conv.title || 'Conversation');
  if (currentRun) renderRunRail(currentRun);

  // Tool results are keyed by tool_use id so a replayed card can show its outcome.
  const resultsById = new Map();
  for (const m of conv.messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') resultsById.set(b.tool_use_id, b);
      }
    }
  }

  for (const m of conv.messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      const stage = m.content.match(/^RUN · ([A-Z+ ]+) STAGE( \(revision\))?\./);
      if (stage) chat.appendChild(stageMarker(stage[1].toLowerCase() + (stage[2] ? ' · revision' : '')));
      else addBubble('user', m.content);
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const bubble = addBubble('assistant', text);
      const textEl = bubble.querySelector('.md');
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        const card = makeToolCard({ name: b.name, input: b.input });
        const result = resultsById.get(b.id);
        const replay = replayOutcome(result);
        finishToolCard(card, { ms: null, ...replay });
        bubble.insertBefore(card, textEl);
      }
    }
  }
  refreshConversations();
  scrollDown();
}

/** Reconstruct summary + preview rows for a replayed tool card from its stored result. */
function replayOutcome(result) {
  if (!result) return { summary: 'done' };
  if (result.is_error) return { error: String(result.content).slice(0, 400) };
  try {
    const parsed = JSON.parse(result.content);
    const rows = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.records) ? parsed.records
      : Array.isArray(parsed?.fields) ? parsed.fields
      : Array.isArray(parsed?.entries) ? parsed.entries
      : Array.isArray(parsed?.results) ? parsed.results
      : null;
    if (rows) {
      return {
        summary: `${rows.length} record${rows.length === 1 ? '' : 's'}`,
        preview: previewRows(rows),
      };
    }
  } catch { /* truncated or non-JSON result — fall through */ }
  return { summary: 'done' };
}

const PREVIEW_KEYS = [
  'number', 'short_description', 'title', 'state', 'priority', 'name', 'label',
  'publication', 'element', 'column_label', 'internal_type', 'type', 'target_name', 'action',
];

function previewRows(rows) {
  if (!rows.length) return undefined;
  const keys = Object.keys(rows[0]).filter((k) => k !== 'sys_id');
  const preferred = PREVIEW_KEYS.filter((k) => keys.includes(k)).slice(0, 4);
  const cols = preferred.length ? preferred : keys.slice(0, 4);
  return rows.slice(0, 5).map((r) =>
    Object.fromEntries(cols.map((k) => [k, truncate(valueOf(r[k]), 80)])));
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---- profile (screen 05) ----

function initialsOf(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

async function showProfile() {
  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  document.getElementById('panel-number').textContent = 'PROFILE';
  document.getElementById('panel-title').textContent = '';
  body.innerHTML = '<div class="conv-empty">Loading…</div>';
  panel.hidden = false;

  let data;
  try {
    const res = await fetch('/api/profile');
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    body.innerHTML = `<div class="conv-empty">Could not load profile: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const u = data.user || {};
  const name = valueOf(u.name) || valueOf(u.user_name) || 'Unknown';
  const host = new URL(data.instance).host;
  body.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'profile-head';
  head.innerHTML =
    `<span class="avatar lg">${escapeHtml(initialsOf(name))}</span>` +
    `<div><div class="profile-name">${escapeHtml(name)}</div>` +
    `<div class="profile-sub">${escapeHtml(valueOf(u.user_name))} · ${escapeHtml(host)}</div></div>`;
  body.appendChild(head);

  const note = document.createElement('div');
  note.className = 'profile-note';
  note.textContent =
    "This is what decides what Kaddiya can see. It signs in as you; ServiceNow's own access controls do the rest. We wrote no authorization logic.";
  body.appendChild(note);

  if (data.org) {
    const org = document.createElement('div');
    org.className = 'profile-section';
    org.innerHTML = `<div class="mono-label">ORG</div>`;
    const line = document.createElement('div');
    line.className = 'group-rows';
    const row = document.createElement('div');
    row.className = 'group-row';
    row.innerHTML = `<span></span><span class="group-type"></span>`;
    row.firstChild.textContent = data.org.name;
    row.lastChild.textContent = data.member?.role || 'member';
    line.appendChild(row);
    if (data.admin) {
      const a = document.createElement('a');
      a.className = 'admin-link';
      a.href = '/admin';
      a.textContent = 'Open the admin page →';
      line.appendChild(a);
    }
    org.appendChild(line);
    body.appendChild(org);
  }

  appendChipSection(body, 'ROLES · from sys_user_has_role', data.roles?.direct, 'No roles assigned directly.');
  if (data.roles?.inherited?.length) {
    appendChipSection(body, `INHERITED · ${data.roles.inherited.length} via role containment`, data.roles.inherited);
  }

  const groups = document.createElement('div');
  groups.className = 'profile-section';
  groups.innerHTML = `<div class="mono-label">GROUPS · from sys_user_grmember</div>`;
  const rows = document.createElement('div');
  rows.className = 'group-rows';
  if (data.groups?.length) {
    for (const g of data.groups) {
      const row = document.createElement('div');
      row.className = 'group-row';
      row.innerHTML = `<span>${escapeHtml(g)}</span>`;
      rows.appendChild(row);
    }
  } else {
    rows.innerHTML = '<span class="conv-empty">Not a member of any group.</span>';
  }
  groups.appendChild(rows);
  body.appendChild(groups);

  const foot = document.createElement('div');
  foot.className = 'profile-foot';
  // The session ceiling, not the access-token expiry: the token refreshes
  // silently underneath, so its countdown would tell the user nothing true.
  const mins = data.session?.expires_at
    ? Math.max(0, Math.round((data.session.expires_at - Date.now()) / 60000))
    : null;
  const life = mins == null ? '' : mins >= 60
    ? ` · ends in ${Math.floor(mins / 60)}h ${mins % 60}m`
    : ` · ends in ${mins} min`;
  foot.innerHTML =
    `<span class="session-line">session · OAuth${life}</span>` +
    `<button class="signout switch" type="button" title="Sign out, then sign in to the same instance as someone else">Switch user</button>` +
    `<button class="signout" type="button">Sign out</button>`;
  foot.querySelector('.signout:not(.switch)').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.assign('/');
  });
  // Trying the console as another person on the same instance: one click to
  // the instance's own login page, where they authenticate as themselves.
  // Nothing here impersonates anyone; the new session is theirs.
  foot.querySelector('.switch').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.assign(`/auth/login?instance=${encodeURIComponent(me?.instance_host || '')}`);
  });
  body.appendChild(foot);
}

function appendChipSection(body, label, items, emptyText) {
  const section = document.createElement('div');
  section.className = 'profile-section';
  section.innerHTML = `<div class="mono-label">${escapeHtml(label)}</div>`;
  const wrap = document.createElement('div');
  wrap.className = 'chip-wrap';
  if (!items || !items.length) {
    wrap.innerHTML = `<span class="conv-empty">${escapeHtml(emptyText || 'None.')}</span>`;
  } else {
    for (const it of items) {
      const c = document.createElement('span');
      c.className = 'tag';
      c.textContent = it;
      wrap.appendChild(c);
    }
  }
  section.appendChild(wrap);
  body.appendChild(section);
}

// ---- record detail panel (right rail) ----

const PANEL_FIELDS = [
  ['state', 'State'],
  ['priority', 'Priority'],
  ['assigned_to', 'Assigned to'],
  ['assignment_group', 'Group'],
  ['caller_id', 'Caller'],
  ['opened_by', 'Opened by'],
  ['sys_class_name', 'Type'],
  ['opened_at', 'Opened', 'mono'],
  ['sys_updated_on', 'Updated', 'mono'],
  ['cmdb_ci', 'CI', 'mono'],
];

function stateIsSettled(state) {
  return /resolved|closed|complete|cancel/i.test(state);
}

function showRecord({ record, journal }) {
  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  document.getElementById('panel-number').textContent = valueOf(record.number) || record.sys_id;
  document.getElementById('panel-title').textContent = valueOf(record.short_description);
  body.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'field-grid';
  for (const [key, label, mono] of PANEL_FIELDS) {
    const val = valueOf(record[key]);
    if (!val) continue;
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = `value${mono ? ' mono' : ''}`;
    if (key === 'state') {
      v.classList.add('state');
      v.innerHTML = `<span class="dot ${stateIsSettled(val) ? 'green' : 'amber'}"></span>${escapeHtml(val)}`;
    } else {
      v.textContent = val;
    }
    grid.appendChild(l);
    grid.appendChild(v);
  }
  body.appendChild(grid);

  const desc = valueOf(record.description);
  if (desc) {
    const d = document.createElement('div');
    d.className = 'panel-section';
    d.innerHTML = `<div class="mono-label">Description</div>`;
    const t = document.createElement('div');
    t.className = 'panel-desc';
    t.textContent = desc;
    d.appendChild(t);
    body.appendChild(d);
  }

  if (journal?.length) {
    const section = document.createElement('div');
    section.className = 'panel-section';
    section.innerHTML = `<div class="mono-label">Activity</div>`;
    const list = document.createElement('div');
    list.className = 'activity';
    for (const j of journal) {
      const isComment = valueOf(j.element) === 'comments';
      const item = document.createElement('div');
      item.className = `journal ${isComment ? 'is-comment' : 'is-note'}`;
      item.innerHTML =
        `<div class="journal-head">` +
        `<span class="journal-tag">${isComment ? 'CUSTOMER VISIBLE' : 'WORK NOTE'}</span>` +
        `<span class="journal-meta">${escapeHtml(valueOf(j.sys_created_on))} · ${escapeHtml(valueOf(j.sys_created_by))}</span>` +
        `</div>` +
        `<div class="journal-body">${escapeHtml(valueOf(j.value))}</div>`;
      list.appendChild(item);
    }
    section.appendChild(list);
    body.appendChild(section);
  }
  panel.hidden = false;
}

function valueOf(f) {
  if (f == null) return '';
  if (typeof f === 'object') return f.display_value || f.value || '';
  return String(f);
}

// ---- draft-reply card (screen 03: pending / sent / discarded) ----
// The agent only ever renders this; the write happens on the human's click,
// on the human's credentials.

function makeDraftCard({ table, sys_id, field, text }) {
  const customerVisible = field === 'comments';
  const card = document.createElement('div');
  let draftText = text;

  function renderPending() {
    card.className = 'nc-card pending';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">Draft reply</span>
        <span class="nc-badge${customerVisible ? '' : ' internal'}">${customerVisible ? 'CUSTOMER VISIBLE' : 'WORK NOTE'}</span>
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      <div class="nc-body" contenteditable="true"></div>
      <div class="nc-foot">
        <div class="nc-caption">Nothing is written to ServiceNow until you press Send. Sends as <span class="hl">${escapeHtml(me?.name || 'you')}</span>.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">Send</button>
      </div>`;
    const bodyEl = card.querySelector('.nc-body');
    bodyEl.textContent = draftText;

    card.querySelector('.btn-ghost').addEventListener('click', () => {
      draftText = bodyEl.innerText;
      renderDiscarded();
    });

    const sendBtn = card.querySelector('.btn-primary');
    sendBtn.addEventListener('click', async () => {
      draftText = bodyEl.innerText;
      sendBtn.disabled = true;
      try {
        const res = await fetch('/api/record/comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table, sys_id, field, text: draftText }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        renderSent(out.record?.number || sys_id);
      } catch (err) {
        sendBtn.disabled = false;
        showCardError(card, err);
      }
    });
  }

  function renderSent(number) {
    card.className = 'nc-card done';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">${customerVisible ? 'Reply sent' : 'Work note added'}</span>
        <span class="nc-badge${customerVisible ? '' : ' internal'}">${customerVisible ? 'CUSTOMER VISIBLE' : 'WORK NOTE'}</span>
        <span class="nc-head-right green">sent by ${escapeHtml(me?.name || 'you')} · ${clock()}</span>
      </div>
      <div class="nc-body"></div>
      <div class="nc-audit">${escapeHtml(field)} · ${escapeHtml(number)} · ${stamp()} · ${escapeHtml(me?.user_name || '')}</div>`;
    card.querySelector('.nc-body').textContent = draftText;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = `
      <div class="nc-discard-text">Draft discarded. Nothing was written to ServiceNow.</div>
      <button class="nc-restore" type="button">restore draft</button>`;
    card.querySelector('.nc-restore').addEventListener('click', renderPending);
  }

  renderPending();
  card.markCommitted = (out) => renderSent(out?.record?.number || sys_id);
  return card;
}

// ---- proposed-change card (screen 04: pending / created / discarded) ----

const ARTIFACT_KINDS = {
  sys_script: 'Business Rule',
  sys_script_include: 'Script Include',
  sys_script_client: 'Client Script',
  sys_ui_policy: 'UI Policy',
  sp_widget: 'Service Portal Widget',
  sp_page: 'Service Portal Page',
  sp_container: 'Service Portal Container',
  sp_row: 'Service Portal Row',
  sp_column: 'Service Portal Column',
  sp_instance: 'Service Portal Widget Instance',
};

// Fields that are code, shown as blocks under the field rows (a widget has
// four of them). `script` stays first so the existing cards look the same.
const ARTIFACT_CODE_FIELDS = [
  ['script', 'Server script'], ['client_script', 'Client script'], ['link', 'Link function'],
  ['template', 'HTML template'], ['css', 'CSS'], ['option_schema', 'Option schema'],
];

function artifactCodeBlocks(fields, table) {
  const present = ARTIFACT_CODE_FIELDS.filter(([k]) => typeof fields[k] === 'string' && fields[k].trim());
  if (!present.length) return '';
  // One block, no label, for the four original kinds — unchanged look.
  if (present.length === 1 && present[0][0] === 'script' && !String(table).startsWith('sp_')) {
    return `<div class="nc-script">${escapeHtml(fields.script)}</div>`;
  }
  return present.map(([k, label]) =>
    `<div class="nc-script-label">${escapeHtml(label)}</div><div class="nc-script">${escapeHtml(fields[k])}</div>`).join('');
}

function artifactFieldRows(fields) {
  const rows = [];
  const used = new Set(ARTIFACT_CODE_FIELDS.map(([k]) => k));
  const take = (key) => { used.add(key); return fields[key]; };

  if (fields.name != null) rows.push(['Name', String(take('name')), 'name']);
  const tableVal = fields.collection ?? fields.table;
  if (tableVal != null) { used.add('collection'); used.add('table'); rows.push(['Table', String(tableVal)]); }
  if (fields.when != null || fields.order != null) {
    const parts = [fields.when, fields.order != null ? `order ${fields.order}` : null].filter(Boolean);
    used.add('when'); used.add('order');
    rows.push(['When', parts.join(' · ')]);
  }
  if (fields.condition != null) rows.push(['Condition', String(take('condition'))]);
  for (const [k, v] of Object.entries(fields)) {
    if (used.has(k) || v == null || v === '') continue;
    const label = k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    rows.push([label, String(v)]);
  }
  return rows;
}

function makeArtifactCard({ table, rationale, fields, update_set }) {
  const kind = (ARTIFACT_KINDS[table] || table).toUpperCase();
  const card = document.createElement('div');

  function renderPending() {
    card.className = 'nc-card pending';
    const rows = artifactFieldRows(fields);
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">Proposed change</span>
        <span class="nc-badge">${escapeHtml(kind)}</span>
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      ${rationale ? `<div class="nc-prose">${escapeHtml(rationale)}</div>` : ''}
      <div class="nc-fields">${rows.map(([label, value, cls]) =>
        `<div class="label">${escapeHtml(label)}</div><div class="val${cls ? ` ${cls}` : ''}">${escapeHtml(value)}</div>`).join('')}</div>
      ${artifactCodeBlocks(fields, table)}
      <div class="nc-updset">
        <span class="set-label">UPDATE SET</span>
        <span class="set-name">${escapeHtml(update_set || 'Default')}</span>
        <span class="set-state">${update_set ? 'in progress' : 'none selected'}</span>
      </div>
      <div class="nc-foot">
        <div class="nc-caption">Nothing is created until you press Create. Runs as <span class="hl">${escapeHtml(me?.name || 'you')}</span>.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">Create</button>
      </div>`;

    card.querySelector('.btn-ghost').addEventListener('click', renderDiscarded);

    const createBtn = card.querySelector('.btn-primary');
    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      try {
        const res = await fetch('/api/artifact/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table, fields }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        renderCreated(out);
      } catch (err) {
        createBtn.disabled = false;
        showCardError(card, err);
      }
    });
  }

  function renderCreated(out) {
    card.className = 'nc-card done';
    const setName = out.update_set?.name || update_set;
    const target = fields.collection || fields.table || table;
    const sysIdShort = out.created?.sys_id ? `${table}_${out.created.sys_id.slice(0, 4)}…` : table;
    const auditParts = [
      setName ? 'sys_update_xml' : null,
      sysIdShort,
      stamp(),
      me?.user_name || '',
    ].filter(Boolean);
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">Change created</span>
        <span class="nc-badge">${escapeHtml(kind)}</span>
        <span class="nc-head-right green">created · ${clock()}</span>
      </div>
      <div class="nc-prose">"${escapeHtml(fields.name || '(unnamed)')}" created on <span class="mono">${escapeHtml(target)}</span>${
        setName ? ` and captured in update set <span class="mono">${escapeHtml(setName)}</span>` : ''
      }.${out.created?.link ? ` <a href="${escapeHtml(out.created.link)}" target="_blank" rel="noopener">Open in ServiceNow ↗</a>` : ''}</div>
      <div class="nc-audit">${auditParts.map(escapeHtml).join(' · ')}</div>`;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = `
      <div class="nc-discard-text">Proposal discarded. Nothing was created; the update set is untouched.</div>
      <button class="nc-restore" type="button">restore</button>`;
    card.querySelector('.nc-restore').addEventListener('click', renderPending);
  }

  renderPending();
  card.markCommitted = (out) => renderCreated(out || {});
  return card;
}

// ---- catalog proposal cards (ADR 0010): one record, shown before and after,
// committed by one click on the human's credentials ----

function displayOf(v) {
  if (v && typeof v === 'object') return String(v.display_value ?? v.value ?? '');
  return v === undefined || v === null || v === '' ? '—' : String(v);
}

function makeProposalCard(data) {
  if (data.action === 'dynamic.apply') return makeDynamicRecordCard(data);
  if (data.action === 'task.update') return makeRecordUpdateCard(data);
  if (data.action === 'approval.decide') return makeApprovalCard(data);
  if (data.action === 'config.update') {
    return makeRecordUpdateCard({
      ...data,
      number: data.name,
      badge: (ARTIFACT_KINDS[data.table] || data.table).toUpperCase(),
      title: 'Proposed change',
      doneTitle: 'Change applied',
      endpoint: '/api/artifact/update',
      updateSet: data.update_set,
      executable: true,
    });
  }
  if (data.action === 'catalog.order') {
    const vars = Object.entries(data.variables || {});
    return makeFieldsProposalCard({
      title: 'Proposed order',
      badge: 'CATALOG ITEM',
      rationale: data.rationale,
      rows: [
        ['Item', data.item_name || data.item_sys_id, 'name'],
        ...(data.requested_for ? [['Requested for', data.requested_for]] : []),
        ...vars.map(([k, v]) => [k, displayOf(v)]),
      ],
      caption: `Nothing is requested until you press Order. Ordered as`,
      verb: 'Order',
      endpoint: '/api/catalog/order',
      body: { item_sys_id: data.item_sys_id, variables: data.variables || {}, requested_for: data.requested_for || undefined },
      doneTitle: 'Order placed',
      doneLine: (out) => `${out.request_number || 'Request'} raised for ${data.item_name || 'the item'}.`,
      doneLink: (out) => out.link,
      audit: (out) => ['sc_request', out.request_number || '', stamp(), me?.user_name || ''],
    });
  }
  if (data.action === 'change.create') {
    const f = data.fields || {};
    const rows = [
      ['Type', data.type + (data.template_name ? ` · ${data.template_name}` : '')],
      ...Object.entries(f).map(([k, v]) => [k, displayOf(v), /plan|description|justification/.test(k) ? 'name' : '']),
    ];
    return makeFieldsProposalCard({
      title: 'Proposed change request',
      badge: String(data.type).toUpperCase(),
      rationale: data.rationale,
      rows,
      caption: 'Nothing is created until you press Create. Raised as',
      verb: 'Create',
      endpoint: '/api/change/create',
      body: { type: data.type, template_sys_id: data.template_sys_id || undefined, fields: f },
      doneTitle: 'Change request created',
      doneLine: (out) => `${out.created?.number || 'Change'} created in state ${out.created?.state || '—'}.`,
      doneLink: (out) => out.created?.link,
      audit: (out) => ['change_request', out.created?.number || '', stamp(), me?.user_name || ''],
    });
  }
  const card = document.createElement('div');
  card.className = 'nc-card discarded';
  card.innerHTML = `<div class="nc-discard-text">Unknown proposal kind. Nothing was written to ServiceNow.</div>`;
  return card;
}

function makeDynamicRecordCard(data) {
  const { table, operation, fields, current, label, name, labels, executable, confirmation } = data;
  const body = { table, operation, fields, ...(data.sys_id ? { sys_id: data.sys_id, current } : {}) };
  if (operation === 'update') {
    return makeRecordUpdateCard({
      table, sys_id: data.sys_id, number: name, rationale: data.rationale,
      current, changes: fields, badge: label, title: `Update ${label}`,
      endpoint: '/api/dynamic/apply', executable, body, confirmation, fieldLabels: labels,
    });
  }
  return makeFieldsProposalCard({
    title: `Create ${label}`, badge: table, rationale: data.rationale,
    rows: Object.entries(fields).map(([key, value]) => [labels?.[key] ? `${labels[key]} (${key})` : key, String(value), 'dynamic-value']),
    caption: 'Nothing is created until you press Create. Created as',
    verb: 'Create', endpoint: '/api/dynamic/apply', body, executable, confirmation,
    doneTitle: `${label} created`, doneLine: out => `${out.record?.name || name} created.${out.warnings?.length ? ` ${out.warnings.join(' ')}` : ''}`,
    doneLink: out => out.record?.link,
    audit: out => [table, out.record?.sys_id, stamp(), me?.user_name || ''],
  });
}

function typedApprovalMarkup(confirmation) {
  return confirmation ? `<label class="nc-prose">Security-sensitive change. Type <strong>${escapeHtml(confirmation)}</strong> to approve.<input class="dynamic-confirmation" type="text" autocomplete="off" aria-label="Type the record name to approve"></label>` : '';
}

function bindTypedApproval(card, button, confirmation) {
  if (!confirmation) return;
  button.disabled = true;
  card.querySelector('.dynamic-confirmation').addEventListener('input', event => {
    button.disabled = event.target.value !== confirmation;
  });
}

function makeRecordUpdateCard({
  table, sys_id, number, rationale, current, changes,
  badge = String(table).toUpperCase(), title = 'Proposed update', doneTitle = 'Record updated',
  endpoint = '/api/record/update', updateSet = null, executable = false, body = null, confirmation = null, fieldLabels = null,
}) {
  const card = document.createElement('div');
  const fields = Object.keys(changes || {});
  const label = number || sys_id;
  // A changed script is shown in full, not as a cell — it is executable code.
  const scriptFields = executable ? fields.filter((f) => /script|condition|template|^link$/.test(f) && typeof changes[f] === 'string' && changes[f].length > 60) : [];
  const cellFields = fields.filter((f) => !scriptFields.includes(f));

  function renderPending() {
    card.className = 'nc-card pending';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">${escapeHtml(title)}</span>
        <span class="nc-badge">${escapeHtml(badge)}</span>
        ${executable ? '<span class="nc-badge exec">EXECUTABLE CODE</span>' : ''}
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      ${rationale ? `<div class="nc-prose">${escapeHtml(rationale)}</div>` : ''}
      ${cellFields.length ? `<div class="nc-diff">
        <div class="diff-h">${escapeHtml(label)}</div><div class="diff-h">now</div><div class="diff-h">after your click</div>
        ${cellFields.map((f) =>
          `<div class="diff-f">${escapeHtml(fieldLabels?.[f] ? `${fieldLabels[f]} (${f})` : f)}</div><div class="diff-old">${escapeHtml(displayOf(current?.[f]))}</div><div class="diff-new">${escapeHtml(displayOf(changes[f]))}</div>`).join('')}
      </div>` : ''}
      ${scriptFields.map((f) => `<div class="nc-fields"><div class="label">${escapeHtml(f)}</div><div class="val">replaced in full — the new ${escapeHtml(f)} follows</div></div>${fieldLabels ? `<div class="nc-script">Before:\n${escapeHtml(displayOf(current?.[f]))}</div>` : ''}<div class="nc-script">${escapeHtml(changes[f])}</div>`).join('')}
      ${updateSet !== null ? `<div class="nc-updset">
        <span class="set-label">UPDATE SET</span>
        <span class="set-name">${escapeHtml(updateSet || 'Default')}</span>
        <span class="set-state">${updateSet ? 'in progress' : 'none selected'}</span>
      </div>` : ''}
      ${typedApprovalMarkup(confirmation)}
      <div class="nc-foot">
        <div class="nc-caption">Nothing changes on ${escapeHtml(label)} until you press Apply. Applies as <span class="hl">${escapeHtml(me?.name || 'you')}</span>.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">Apply</button>
      </div>`;

    card.querySelector('.btn-ghost').addEventListener('click', renderDiscarded);
    const applyBtn = card.querySelector('.btn-primary');
    bindTypedApproval(card, applyBtn, confirmation);
    applyBtn.addEventListener('click', async () => {
      if (applyBtn.disabled) return;
      if (confirmation && card.querySelector('.dynamic-confirmation').value !== confirmation) return;
      applyBtn.disabled = true;
      if (confirmation) card.querySelector('.dynamic-confirmation').disabled = true;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(body || { table, sys_id, fields: changes }), ...(confirmation ? { confirmation: card.querySelector('.dynamic-confirmation').value } : {}) }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        renderDone(out.record || out.updated || {}, out.warnings);
      } catch (err) {
        applyBtn.disabled = false;
        if (confirmation) card.querySelector('.dynamic-confirmation').disabled = false;
        showCardError(card, err);
      }
    });
  }

  function renderDone(record, warnings = []) {
    card.className = 'nc-card done';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">${escapeHtml(doneTitle)}</span>
        <span class="nc-badge">${escapeHtml(badge)}</span>
        <span class="nc-head-right green">applied by ${escapeHtml(me?.name || 'you')} · ${clock()}</span>
      </div>
      ${warnings.length ? `<div class="nc-prose">${escapeHtml(warnings.join(' '))}</div>` : ''}
      <div class="nc-fields">${fields.map((f) =>
        `<div class="label">${escapeHtml(f)}</div><div class="val">${escapeHtml(displayOf(record[f] ?? (body ? undefined : changes[f])))}</div>`).join('')}</div>
      <div class="nc-audit">${escapeHtml(table)} · ${escapeHtml(record.number || label)} · ${stamp()} · ${escapeHtml(me?.user_name || '')}</div>`;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = `
      <div class="nc-discard-text">Update discarded. ${escapeHtml(label)} is unchanged.</div>
      <button class="nc-restore" type="button">restore</button>`;
    card.querySelector('.nc-restore').addEventListener('click', renderPending);
  }

  renderPending();
  card.markCommitted = (out) => renderDone(out?.record || out?.updated || {}, out?.warnings);
  return card;
}

// A proposal that creates one record from a list of fields: a catalog order,
// a change request. Same three states as every card; the endpoint and body
// come from the catalog entry that produced it.
function makeFieldsProposalCard({ title, badge, rationale, rows, caption, verb, endpoint, body, doneTitle, doneLine, doneLink, audit, executable = false, confirmation = null }) {
  const card = document.createElement('div');

  function renderPending() {
    card.className = 'nc-card pending';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">${escapeHtml(title)}</span>
        <span class="nc-badge">${escapeHtml(badge)}</span>
        ${executable ? '<span class="nc-badge exec">EXECUTABLE CODE</span>' : ''}
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      ${rationale ? `<div class="nc-prose">${escapeHtml(rationale)}</div>` : ''}
      <div class="nc-fields wide">${rows.map(([label, value, cls]) =>
        `<div class="label">${escapeHtml(label)}</div><div class="val${cls ? ` ${cls}` : ''}">${escapeHtml(value)}</div>`).join('')}</div>
      ${typedApprovalMarkup(confirmation)}
      <div class="nc-foot">
        <div class="nc-caption">${escapeHtml(caption)} <span class="hl">${escapeHtml(me?.name || 'you')}</span>.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">${escapeHtml(verb)}</button>
      </div>`;

    card.querySelector('.btn-ghost').addEventListener('click', renderDiscarded);
    const btn = card.querySelector('.btn-primary');
    bindTypedApproval(card, btn, confirmation);
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (confirmation && card.querySelector('.dynamic-confirmation').value !== confirmation) return;
      btn.disabled = true;
      if (confirmation) card.querySelector('.dynamic-confirmation').disabled = true;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, ...(confirmation ? { confirmation: card.querySelector('.dynamic-confirmation').value } : {}) }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        renderDone(out);
      } catch (err) {
        btn.disabled = false;
        if (confirmation) card.querySelector('.dynamic-confirmation').disabled = false;
        showCardError(card, err);
      }
    });
  }

  function renderDone(out) {
    card.className = 'nc-card done';
    const link = doneLink?.(out);
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">${escapeHtml(doneTitle)}</span>
        <span class="nc-badge">${escapeHtml(badge)}</span>
        <span class="nc-head-right green">${escapeHtml(verb.toLowerCase())}d by ${escapeHtml(me?.name || 'you')} · ${clock()}</span>
      </div>
      <div class="nc-prose">${escapeHtml(doneLine(out))}${link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open in ServiceNow ↗</a>` : ''}</div>
      <div class="nc-audit">${audit(out).filter(Boolean).map(escapeHtml).join(' · ')}</div>`;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = `
      <div class="nc-discard-text">Proposal discarded. Nothing was written to ServiceNow.</div>
      <button class="nc-restore" type="button">restore</button>`;
    card.querySelector('.nc-restore').addEventListener('click', renderPending);
  }

  renderPending();
  card.markCommitted = (out) => renderDone(out || {});
  return card;
}

function makeApprovalCard({ sys_id, decision, comments, approving }) {
  const card = document.createElement('div');
  const verb = decision === 'rejected' ? 'Reject' : 'Approve';
  const what = [approving?.number, approving?.summary].filter(Boolean).join(' — ') || sys_id;

  function renderPending() {
    card.className = 'nc-card pending';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">Proposed decision</span>
        <span class="nc-badge">${escapeHtml(String(decision).toUpperCase())}</span>
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      <div class="nc-fields">
        <div class="label">Approving</div><div class="val name">${escapeHtml(what)}</div>
        ${approving?.table ? `<div class="label">Table</div><div class="val">${escapeHtml(approving.table)}</div>` : ''}
        <div class="label">Decision</div><div class="val">${escapeHtml(decision)}</div>
        ${comments ? `<div class="label">Comments</div><div class="val name">${escapeHtml(comments)}</div>` : ''}
      </div>
      <div class="nc-foot">
        <div class="nc-caption">Nothing is decided until you press ${escapeHtml(verb)}. Recorded as <span class="hl">${escapeHtml(me?.name || 'you')}</span>.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">${escapeHtml(verb)}</button>
      </div>`;

    card.querySelector('.btn-ghost').addEventListener('click', renderDiscarded);
    const btn = card.querySelector('.btn-primary');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch('/api/approval/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sys_id, decision, comments }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        renderDone(out.record || {});
      } catch (err) {
        btn.disabled = false;
        showCardError(card, err);
      }
    });
  }

  function renderDone(record) {
    card.className = 'nc-card done';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">${decision === 'rejected' ? 'Rejected' : 'Approved'}</span>
        <span class="nc-badge">${escapeHtml(String(decision).toUpperCase())}</span>
        <span class="nc-head-right green">by ${escapeHtml(me?.name || 'you')} · ${clock()}</span>
      </div>
      <div class="nc-prose">${escapeHtml(what)}</div>
      <div class="nc-audit">sysapproval_approver · ${escapeHtml(displayOf(record.state) || decision)} · ${stamp()} · ${escapeHtml(me?.user_name || '')}</div>`;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = `
      <div class="nc-discard-text">Decision discarded. The approval is still waiting.</div>
      <button class="nc-restore" type="button">restore</button>`;
    card.querySelector('.nc-restore').addEventListener('click', renderPending);
  }

  renderPending();
  card.markCommitted = (out) => renderDone(out?.record || {});
  return card;
}

// ---- proposed-update-set card (pending / created / discarded) ----
// Creating an update set was an autonomous agent write until ADR 0008 D12.
// It now follows the same pattern as every other write: the agent proposes,
// the human commits, on the human's credentials.

function makeUpdateSetCard({ name, description, current }) {
  const card = document.createElement('div');

  function renderPending() {
    card.className = 'nc-card pending';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">Proposed update set</span>
        <span class="nc-badge">UPDATE SET</span>
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      <div class="nc-fields">
        <div class="label">Name</div><div class="val name">${escapeHtml(name)}</div>
        ${description ? `<div class="label">Description</div><div class="val">${escapeHtml(description)}</div>` : ''}
        <div class="label">Current</div><div class="val">${escapeHtml(current || 'Default (none selected)')}</div>
      </div>
      <div class="nc-foot">
        <div class="nc-caption">Nothing is created until you press Create. Creating it also makes it your current set, as <span class="hl">${escapeHtml(me?.name || 'you')}</span>.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">Create</button>
      </div>`;

    card.querySelector('.btn-ghost').addEventListener('click', renderDiscarded);

    const createBtn = card.querySelector('.btn-primary');
    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      try {
        const res = await fetch('/api/update-set/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        renderCreated(out);
      } catch (err) {
        createBtn.disabled = false;
        showCardError(card, err);
      }
    });
  }

  function renderCreated(out) {
    card.className = 'nc-card done';
    const sysId = out.created?.sys_id ? `sys_update_set_${out.created.sys_id.slice(0, 4)}…` : 'sys_update_set';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">Update set created</span>
        <span class="nc-badge">UPDATE SET</span>
        <span class="nc-head-right green">created · ${clock()}</span>
      </div>
      <div class="nc-prose">"${escapeHtml(name)}" is now your current update set. Configuration changes you approve from here are captured in it.</div>
      <div class="nc-audit">${[sysId, stamp(), me?.user_name || ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>`;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = `
      <div class="nc-discard-text">Proposal discarded. No update set was created; your current set is unchanged.</div>
      <button class="nc-restore" type="button">restore</button>`;
    card.querySelector('.nc-restore').addEventListener('click', renderPending);
  }

  renderPending();
  card.markCommitted = (out) => renderCreated(out || {});
  return card;
}

// ---- notebook keep/discard card (ADR 0008 D5) ----
// The notebook is console-local, but an agent-written note that everyone's
// system prompt inherits is a cross-user channel — so it gets the same
// approval pattern as an instance write, and only kept notes are injected.

function makeNoteCard({ id, text, context, status }) {
  const card = document.createElement('div');

  function renderPending() {
    card.className = 'nc-card pending';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot amber pulse-pending"></span>
        <span class="nc-title">Note for this instance</span>
        <span class="nc-badge internal">NOTEBOOK</span>
        <span class="nc-head-right amber">pending your approval</span>
      </div>
      ${context ? `<div class="nc-fields"><div class="label">Applies to</div><div class="val">${escapeHtml(context)}</div></div>` : ''}
      <div class="nc-body"></div>
      <div class="nc-foot">
        <div class="nc-caption">Kept notes are shown at the start of every future conversation on this instance. Nothing is written to ServiceNow either way.</div>
        <button class="btn-ghost" type="button">Discard</button>
        <button class="btn-primary" type="button">Keep</button>
      </div>`;
    card.querySelector('.nc-body').textContent = text;

    const discardBtn = card.querySelector('.btn-ghost');
    discardBtn.addEventListener('click', async () => {
      discardBtn.disabled = true;
      try {
        await postNote('/api/notebook/discard');
        renderDiscarded();
      } catch (err) {
        discardBtn.disabled = false;
        showCardError(card, err);
      }
    });

    const keepBtn = card.querySelector('.btn-primary');
    keepBtn.addEventListener('click', async () => {
      keepBtn.disabled = true;
      try {
        await postNote('/api/notebook/keep');
        renderKept();
      } catch (err) {
        keepBtn.disabled = false;
        showCardError(card, err);
      }
    });
  }

  async function postNote(url) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, conversation_id: currentConv }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  function renderKept() {
    card.className = 'nc-card done';
    card.innerHTML = `
      <div class="nc-head">
        <span class="dot green"></span>
        <span class="nc-title">Note kept</span>
        <span class="nc-badge internal">NOTEBOOK</span>
        <span class="nc-head-right green">kept by ${escapeHtml(me?.name || 'you')} · ${clock()}</span>
      </div>
      <div class="nc-body"></div>
      <div class="nc-audit">${[context || 'instance', stamp(), me?.user_name || ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>`;
    card.querySelector('.nc-body').textContent = text;
  }

  function renderDiscarded() {
    card.className = 'nc-card discarded';
    card.innerHTML = '<div class="nc-discard-text">Note discarded. It carries into no future conversation.</div>';
  }

  if (status === 'kept') renderKept();
  else renderPending();
  return card;
}

/** Failure text under a card's footer caption, replacing any previous one. */
function showCardError(card, err) {
  const caption = card.querySelector('.nc-caption');
  if (!caption) return;
  caption.querySelector('.err')?.remove();
  const e = document.createElement('span');
  e.className = 'err';
  e.textContent = `failed · ${err.message}`;
  caption.appendChild(e);
}

// ---- usage + spend ----

// Every answer says whose credential it ran on (ADR 0008 D9): the server's
// 'done' event carries the provider label ('trial allowance', 'your key',
// 'your gateway'), printed after the cost so the trial is named per turn.
function makeUsageLine({ usage, cost, provider }) {
  const el = document.createElement('div');
  el.className = 'usage-line';
  const parts = [
    `in ${fmtNum(usage.input_tokens)} tok`,
    `out ${fmtNum(usage.output_tokens)} tok`,
  ];
  if (usage.cache_read_input_tokens) parts.push(`cached ${fmtNum(usage.cache_read_input_tokens)}`);
  el.innerHTML = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('');
  if (cost != null) {
    const c = document.createElement('span');
    c.className = 'cost';
    c.textContent = `≈ $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;
    el.appendChild(c);
  }
  if (provider) {
    const p = document.createElement('span');
    p.className = 'provider';
    p.textContent = `on ${provider}`;
    el.appendChild(p);
  }
  return el;
}

function recordSpend(cost) {
  if (cost == null) return;
  sessionCost += cost;
  sessionTurns += 1;
  const el = document.getElementById('spend');
  el.hidden = false;
  el.textContent = `≈ $${sessionCost.toFixed(3)} · ${sessionTurns} turn${sessionTurns === 1 ? '' : 's'}`;
}

function fmtNum(n) {
  return (n || 0).toLocaleString('en-US');
}

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- transport + rendering helpers ----


// ---- shared stream events: cards, records, plan commits (ADR 0011) ----
// Chat turns and run stages emit the same card events; this handles the
// ones that draw or flip a card, and returns true when it did.
function handleSharedEvent(event, data, assistant, textEl, toolCards) {
  const place = (card) => {
    if (data.proposal_id) proposalCards.set(data.proposal_id, card);
    assistant.insertBefore(card, textEl);
    if (data.automatic) {
      card.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = true; });
      const caption = card.querySelector('.nc-caption');
      if (caption) caption.textContent = 'Applying under your task authorization…';
    }
  };
  if (event === 'focus') { showRecord(data); return true; }
  if (event === 'draft') { place(makeDraftCard(data)); return true; }
  if (event === 'artifact') { place(makeArtifactCard(data)); return true; }
  if (event === 'proposal') { place(makeProposalCard(data)); return true; }
  if (event === 'update_set_proposal') { place(makeUpdateSetCard(data)); return true; }
  if (event === 'note') { assistant.insertBefore(makeNoteCard(data), textEl); return true; }
  if (event === 'committed') {
    const card = proposalCards.get(data.proposal_id);
    if (card?.markCommitted) card.markCommitted(data.result);
    return true;
  }
  if (event === 'commit_failed') {
    const card = proposalCards.get(data.proposal_id);
    if (card) showCardError(card, new Error(data.error || 'the instance refused this commit'));
    return true;
  }
  if (event === 'run') { currentRun = data; renderRunRail(data); return true; }
  return false;
}

// ---- model choice for the next turn ----
function selectedModel() {
  const sel = document.getElementById('model-select');
  if (sel && !sel.hidden && sel.value) return sel.value;
  return me?.default_model || me?.model_id || '';
}

function renderModelSelect() {
  const sel = document.getElementById('model-select');
  const models = me?.models || [];
  const label = document.getElementById('model-select-label');
  if (label) label.hidden = !models.length;
  if (!models.length) { sel.hidden = true; return; }
  let remembered = '';
  try { remembered = localStorage.getItem(`kd.model.${me.org.id}`) || ''; } catch { /* storage unavailable */ }
  sel.innerHTML = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label || m.id;
    sel.appendChild(o);
  }
  sel.value = models.some((m) => m.id === remembered) ? remembered : (me.default_model || models[0].id);
  sel.hidden = false;
  renderModelBadge();
  sel.addEventListener('change', () => {
    try { localStorage.setItem(`kd.model.${me.org.id}`, sel.value); } catch { /* ignore */ }
    renderModelBadge();
  });
}

// ---- attachments: text files dropped on the composer ----
const MAX_FILE_BYTES = 150_000;
const MAX_FILES = 4;

function initAttachments() {
  const attach = document.getElementById('attach');
  const fileInput = document.getElementById('file-input');
  const composer = document.querySelector('.composer');
  attach.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { queueFiles(fileInput.files); fileInput.value = ''; });
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drop'); });
  composer.addEventListener('dragleave', () => composer.classList.remove('drop'));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('drop');
    queueFiles(e.dataTransfer?.files);
  });
}

async function queueFiles(list) {
  for (const file of Array.from(list || [])) {
    if (pendingFiles.length >= MAX_FILES) break;
    if (file.size > MAX_FILE_BYTES) { pendingFiles.push({ name: file.name, text: '', error: `over ${MAX_FILE_BYTES / 1000} KB` }); continue; }
    try {
      const text = await file.text();
      pendingFiles.push({ name: file.name, text });
    } catch {
      pendingFiles.push({ name: file.name, text: '', error: 'could not read' });
    }
  }
  renderAttachmentChips();
  input.focus();
}

function renderAttachmentChips() {
  const box = document.getElementById('attachments');
  box.innerHTML = '';
  box.hidden = pendingFiles.length === 0;
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = `attachment${f.error ? ' bad' : ''}`;
    chip.textContent = f.error ? `${f.name} · ${f.error}` : `${f.name} · ${Math.max(1, Math.round(f.text.length / 1000))}k`;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', `Remove ${f.name}`);
    x.addEventListener('click', () => { pendingFiles.splice(i, 1); renderAttachmentChips(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

// ---- runs (ADR 0011): longer work in stages, from a plan the person approved ----

function initWorkMode() {
  document.getElementById('work-mode').addEventListener('change', syncWorkMode);
  syncWorkMode();
}

function syncWorkMode() {
  const mode = document.getElementById('work-mode');
  if (!mode) return;
  const autonomous = mode.value === 'autonomous';
  document.getElementById('work-template').hidden = mode.value === 'review';
  document.getElementById('work-template-label').hidden = mode.value === 'review';
  document.getElementById('autonomy-warning').hidden = !autonomous;
  const ack = document.getElementById('autonomy-ack');
  ack.checked = false; ack.required = autonomous; ack.disabled = !autonomous || !me?.autonomous_available;
  document.getElementById('autonomy-context').textContent = me?.autonomous_available
    ? `Working as ${me.name} on ${me.instance_host} (${me.instance_non_production ? 'non-production' : 'production'}).`
    : 'An organization admin must enable autonomous mode under Admin → Access first.';
}

async function startStagedTask(text) {
  const mode = document.getElementById('work-mode').value;
  const policy = mode === 'autonomous' ? 'autonomous' : 'each';
  if (policy === 'autonomous' && (!me?.autonomous_available || !document.getElementById('autonomy-ack').checked)) {
    document.getElementById('autonomy-warning').hidden = false;
    return;
  }
  if (text.length < 8) { input.focus(); return; }
  busy = true; sendBtn.disabled = true;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: text, conversation_id: currentConv || undefined, template: document.getElementById('work-template').value, policy, acknowledged: policy === 'autonomous', model: selectedModel(), attachments: pendingFiles }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    currentConv = out.conversation_id; currentRun = out.run;
    input.value = ''; autoGrow(); setNextStep(null);
    pendingFiles.splice(0); renderAttachmentChips();
    document.querySelector('.welcome')?.remove();
    setThreadTitle(text.slice(0, 64)); addBubble('user', text);
    document.getElementById('autonomy-ack').checked = false;
    renderRunRail(currentRun); refreshConversations();
    busy = false;
    runStage();
  } catch (err) { addBubble('assistant', `**Could not start:** ${err.message}`); }
  finally { busy = false; if (!runBusy) sendBtn.disabled = false; }
}

// Stages that run without a click once the previous one has finished.
const AUTO_STAGES = new Set(['spec', 'review', 'test', 'verify']);

async function runStage() {
  if (!currentConv || !currentRun || runBusy || currentRun.status !== 'active') return;
  const taskConversation = currentConv;
  let failed = false;
  runBusy = true;
  runStopRequested = false;
  runRequestController = new AbortController();
  sendBtn.disabled = true;
  renderRunRail(currentRun);
  const assistant = addBubble('assistant', '');
  const textEl = assistant.querySelector('.md');
  let raw = '';
  const toolCards = new Map();
  let marker = null;
  try {
    const res = await fetch(`/api/runs/${currentConv}/stage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: runRequestController.signal });
    if (res.status === 401) return location.assign('/signin');
    if (!res.ok || !res.body) {
      const out = await res.json().catch(() => ({}));
      throw new Error(out.error || `Server error (${res.status})`);
    }
    for await (const { event, data } of sseEvents(res.body)) {
      if (event === 'run' && data.running && !marker) {
        marker = stageMarker(data.running === 'spec' && data.revisions ? 'spec · revision' : data.running);
        chat.insertBefore(marker, assistant);
      }
      if (handleSharedEvent(event, data, assistant, textEl, toolCards)) continue;
      if (event === 'text') {
        raw += data.delta;
        textEl.innerHTML = renderMarkdown(raw);
      } else if (event === 'tool_start') {
        const card = makeToolCard(data);
        toolCards.set(data.id, card);
        assistant.insertBefore(card, textEl);
      } else if (event === 'tool_end') {
        finishToolCard(toolCards.get(data.id), data);
      } else if (event === 'paywall') {
        failed = true;
        assistant.insertBefore(makePaywallCard(data), textEl);
      } else if (event === 'done') {
        assistant.appendChild(makeUsageLine(data));
        recordSpend(data.cost);
      } else if (event === 'error') {
        failed = true;
        raw += `\n\n**Error:** ${data.message}`;
        textEl.innerHTML = renderMarkdown(raw);
      }
      scrollDown();
    }
  } catch (err) {
    failed = true;
    textEl.innerHTML = renderMarkdown(raw + `\n\n**Connection error:** ${err.message}`);
  } finally {
    for (const card of toolCards.values()) stopToolTimer(card);
    runBusy = false;
    runRequestController = null;
    sendBtn.disabled = false;
    scrollDown();
    refreshConversations();
  }
  if (!failed && currentConv === taskConversation && currentRun?.status === 'active' && !runStopRequested && (AUTO_STAGES.has(currentRun.stage) || (currentRun.policy === 'autonomous' && currentRun.stage === 'build'))) {
    setTimeout(() => { if (currentConv === taskConversation && !runStopRequested) runStage(); }, 400);
  } else {
    renderRunRail(currentRun);
  }
}

function pendingCardCount() {
  return chat.querySelectorAll('.nc-card.pending:not(.paywall)').length;
}

function stageMarker(label) {
  const el = document.createElement('div');
  el.className = 'stage-marker';
  el.innerHTML = `<span class="stage-marker-line"></span><span class="stage-marker-text">${escapeHtml(String(label).toUpperCase())}</span><span class="stage-marker-line"></span>`;
  return el;
}

function removeRunRail() {
  document.getElementById('run-rail')?.remove();
}

function renderRunRail(run) {
  if (!run) return removeRunRail();
  let rail = document.getElementById('run-rail');
  if (!rail) {
    rail = document.createElement('div');
    rail.id = 'run-rail';
    rail.className = 'run-rail';
    document.querySelector('.centre').insertBefore(rail, chat);
  }
  const stages = (run.stages || []).filter((s) => s.id !== 'done');
  const order = stages.map((s) => s.id);
  const stageNow = run.stage === 'build_pending' ? 'build' : run.stage;
  const at = run.status === 'done' ? order.length : order.indexOf(stageNow);
  rail.innerHTML = `
    <div class="run-rail-stages">${stages.map((s, i) => {
      const state = run.status === 'done' || i < at ? 'done' : i === at ? (runBusy ? 'running' : 'current') : 'todo';
      return `<span class="run-stage ${state}"><span class="dot"></span>${escapeHtml(s.label)}</span>`;
    }).join('')}</div>
    <div class="run-rail-meta"><span class="mono">${escapeHtml(run.template_label || run.template)}</span><span class="mono">${escapeHtml(run.policy_label || run.policy)}</span></div>
    <div class="run-rail-actions"></div>`;
  const actions = rail.querySelector('.run-rail-actions');
  const btn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  const note = (text) => {
    const n = document.createElement('span');
    n.className = 'run-note';
    n.textContent = text;
    actions.appendChild(n);
  };

  if (run.status === 'needs_attention') { note(run.findings || 'This task needs your attention. Review the transcript before starting more work.'); return; }
  if (run.status === 'stopped') { note('Stopped.'); return; }
  if (run.status === 'done') { note('Done. The summary above is the record of this run.'); return; }
  if (runBusy) {
    note(`${(stages.find((s) => s.id === stageNow) || {}).label || stageNow} is running…`);
    btn('Stop now', 'btn-ghost', () => { runStopRequested = true; stopRun(); });
    return;
  }
  if (run.stage === 'approve') {
    note(run.findings ? 'The reviewer still had findings; read them above, then decide.' : 'The reviewer approved the spec. Your decision:');
    const noteInput = document.createElement('input');
    noteInput.className = 'text-input run-note-input';
    noteInput.placeholder = 'Optional note for the builder, or why you are sending it back';
    actions.appendChild(noteInput);
    btn('Send back', 'btn-ghost', () => decidePlan(false, noteInput.value));
    btn(run.policy === 'plan' ? 'Approve the plan and run it' : 'Approve the plan and build', 'btn-primary', () => decidePlan(true, noteInput.value));
    return;
  }
  if (run.stage === 'build_pending') {
    const left = pendingCardCount();
    note(left ? `${left} proposal${left === 1 ? '' : 's'} waiting for your click above.` : 'Every proposal is committed or discarded.');
    const b = btn('Continue to test', 'btn-primary', () => runStage());
    b.disabled = left > 0;
    if (left) {
      const watch = setInterval(() => {
        if (!document.getElementById('run-rail')) return clearInterval(watch);
        const n = pendingCardCount();
        b.disabled = n > 0;
        rail.querySelector('.run-note').textContent = n ? `${n} proposal${n === 1 ? '' : 's'} waiting for your click above.` : 'Every proposal is committed or discarded.';
        if (!n) clearInterval(watch);
      }, 800);
    }
    btn('Stop', 'btn-ghost', () => stopRun());
    return;
  }
  if (run.stage === 'build') {
    note('Plan approved.');
    btn(run.policy === 'plan' ? 'Run the build' : 'Build', 'btn-primary', () => runStage());
    btn('Stop', 'btn-ghost', () => stopRun());
    return;
  }
  if (AUTO_STAGES.has(run.stage)) {
    note('Paused.');
    btn('Continue', 'btn-primary', () => runStage());
    btn('Stop', 'btn-ghost', () => stopRun());
  }
}

async function decidePlan(approved, noteText) {
  if (!currentConv) return;
  try {
    const res = await fetch(`/api/runs/${currentConv}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, note: noteText || '' }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    currentRun = out.run;
    chat.appendChild(stageMarker(approved ? 'plan approved' : 'plan sent back'));
    if (noteText) addBubble('user', noteText);
    renderRunRail(currentRun);
    runStage();
  } catch (err) {
    addBubble('assistant', `**Error:** ${err.message}`);
  }
}

async function stopRun() {
  if (!currentConv) return;
  runStopRequested = true;
  runRequestController?.abort();
  try {
    const res = await fetch(`/api/runs/${currentConv}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const out = await res.json();
    if (res.ok) { currentRun = out.run; renderRunRail(currentRun); }
  } catch { /* the rail keeps its state */ }
}

async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Markdown, rendered as a closed set of tags (test/render.test.js pins the
// allow-list): escaping runs first, so model output and instance content can
// only ever come out as text. Fenced code keeps its language as a label and
// gets a Copy button (handled by delegation in init: no inline handlers);
// tables, ordered lists, blockquotes and rules render; links stay text with
// the URL beside them, because an <a> the model controls is a phishing
// surface (ADR 0008 D8).
function renderMarkdown(src) {
  const escaped = escapeHtml(src);
  const blocks = [];
  const withBlocks = escaped.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
    const label = (lang || '').toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 24);
    blocks.push(
      `<div class="codeblock"><div class="codeblock-head"><span class="codeblock-lang">${label || 'code'}</span>` +
      `<button class="codeblock-copy" type="button">Copy</button></div><pre class="code">${code.replace(/\n$/, '')}</pre></div>`,
    );
    return `%%codeblock:${blocks.length - 1}%%`;
  });
  const lines = withBlocks.split('\n');
  const out = [];
  let list = null;      // 'ul' | 'ol' | null
  let quote = false;
  let table = null;     // { header: [], rows: [] }
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  const flushTable = () => {
    if (!table) return;
    const cellsOf = (cells, tag) => cells.map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('');
    out.push(
      `<table><thead><tr>${cellsOf(table.header, 'th')}</tr></thead>` +
      `<tbody>${table.rows.map((r) => `<tr>${cellsOf(r, 'td')}</tr>`).join('')}</tbody></table>`,
    );
    table = null;
  };
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = line.match(/^%%codeblock:(\d+)%%$/);
    if (block) { closeList(); closeQuote(); flushTable(); out.push(blocks[Number(block[1])]); continue; }

    // A table: a header row, a separator row, then body rows.
    if (!table && isRow(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      closeList(); closeQuote();
      table = { header: splitRow(line), rows: [] };
      i += 1;
      continue;
    }
    if (table) {
      if (isRow(line)) { table.rows.push(splitRow(line)); continue; }
      flushTable();
    }

    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) {
      closeList();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push(`<p>${inline(q[1])}</p>`);
      continue;
    }
    closeQuote();

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list && list !== kind) closeList();
      if (!list) { out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    if (line.trim() === '') { out.push('<br>'); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeQuote(); flushTable();
  return out.join('');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // [text](url): the text, then the URL as machine text. Never an <a>.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => `${text} <code>${url}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}
