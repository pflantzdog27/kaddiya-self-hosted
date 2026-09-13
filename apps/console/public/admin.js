// The admin console (ADR 0008 D17): thin, complete, and every control is a
// POST to a console-local endpoint — nothing here touches the instance.
// Rendering is escape-first: every value from the server passes through
// text nodes or escapeHtml(), never innerHTML with interpolated data.

let state = null;
let editingModelId = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brandingEditor = KaddiyaBranding.editor(document.querySelector('[data-brand-editor]'), $('brand-name'));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showBanner(message) {
  $('banner').textContent = message || '';
  $('banner').hidden = !message;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { location.assign('/signin'); throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function load() {
  state = await api('/api/admin');
  await render();
}

async function render() {
  const { org, plan, usage, instances, members } = state;
  $('org-name').textContent = org.name;
  $('org-kicker').textContent = `Admin · ${state.me.role}`;
  const pill = $('plan-pill');
  pill.textContent = `${plan.label}${plan.id === 'self-hosted' ? ' workspace' : ' plan'}${org.plan_status && org.plan_status !== 'active' ? ` · ${org.plan_status}` : ''}`;
  pill.className = 'pill green';
  $('callback-url').textContent = state.callback_url;

  renderStats(plan, usage, instances, members, state.model_connections?.length || (state.model?.has_key && state.model?.provider !== 'trial'));
  renderInstances(instances);
  renderMembers(members);
  renderAccess(org);
  KaddiyaBranding.apply(org);
  $('brand-name').value = org.name;
  brandingEditor.load(org.branding);
  renderModel();
  renderBilling();
  const setup = org.edition === 'self-hosted' && (params.has('setup') || !state.available_models?.length);
  $('setup-summary').hidden = !setup;
  document.querySelector('main').classList.toggle('wide', !setup);
  for (const id of ['stats', 'sec-instances', 'sec-members', 'sec-access', 'sec-billing', 'sec-audit']) $(id).hidden = setup;
  if (setup) {
    const ready = !!state.available_models?.length;
    $('admin-lede').textContent = ready ? 'Your workspace is ready. Add another model or start your first conversation.' : 'ServiceNow is connected. Add your first model to finish setup.';
    $('setup-status').textContent = ready ? 'Model connected and tested. Setup complete.' : 'Give this connection a name, enter your model ID and API key, then test it.';
    $('setup-ready').hidden = !ready;
    if (!ready) $('model-editor').open = true;
  }
  if (!setup) await loadAudit(true);
}

function stat(label, value, sub, ratio) {
  const el = document.createElement('div');
  el.className = 'stat';
  const l = document.createElement('div'); l.className = 'mono-label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'stat-value'; v.textContent = value;
  const s = document.createElement('div'); s.className = 'stat-sub'; s.textContent = sub;
  el.append(l, v, s);
  if (ratio != null) {
    const m = document.createElement('div');
    m.className = `meter${ratio >= 0.8 ? ' warn' : ''}`;
    const i = document.createElement('i');
    // No inline styles under the CSP: the width comes from a class ladder.
    i.className = `w${Math.min(10, Math.round(ratio * 10))}`;
    m.appendChild(i);
    el.appendChild(m);
  }
  return el;
}

function renderStats(plan, usage, instances, members, ownKey) {
  const grid = $('stats');
  grid.innerHTML = '';
  const live = instances.filter((i) => i.status !== 'disconnected').length;
  const active = members.filter((m) => m.status === 'active').length;
  grid.append(
    stat('Turns this month', String(usage.turns_this_month),
      'no monthly cap on this deployment',
      plan.turns_per_month == null || ownKey ? null : usage.turns_this_month / plan.turns_per_month),
    stat('Model spend', money(usage.spend_this_month_usd),
      'estimated from model usage records',
      null),
    stat('Members', String(active), plan.max_members == null ? 'no cap' : `of ${plan.max_members} active seats`, plan.max_members == null ? null : active / plan.max_members),
    stat('Instances', String(live), plan.max_instances == null ? 'no cap' : `of ${plan.max_instances} on this plan`, plan.max_instances == null ? null : live / plan.max_instances),
  );
}

function table(id, headers, rows) {
  const t = $(id);
  t.innerHTML = '';
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const h of headers) { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) tbody.appendChild(row);
  t.appendChild(tbody);
  if (!rows.length) {
    const tr2 = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = headers.length;
    td.className = 'empty';
    td.textContent = 'Nothing yet.';
    tr2.appendChild(td);
    tbody.appendChild(tr2);
  }
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text ?? '';
  return td;
}
function pillCell(text, tone) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = `pill ${tone || ''}`;
  span.textContent = text;
  td.appendChild(span);
  return td;
}
function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); await load(); } catch (err) { showError(err.message); b.disabled = false; }
  });
  return b;
}
function link(label, cls, href) {
  const a = document.createElement('a');
  a.className = cls;
  a.href = href;
  a.textContent = label;
  return a;
}

function renderInstances(instances) {
  $('instances-note').textContent = `${instances.filter((i) => i.status === 'verified').length} verified`;
  const rows = instances.map((i) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(i.label),
      cell(i.host, 'mono'),
      pillCell(i.status.replace('_', ' '), i.status === 'verified' ? 'green' : i.status === 'disconnected' ? '' : 'amber'),
      pillCell(i.non_production ? 'non-production' : 'production', i.non_production ? 'amber' : ''),
      cell(i.instance_id && !i.instance_id.startsWith('env:') ? i.instance_id : (i.instance_id || '—'), 'mono'),
      cell(i.verified_by_user_name ? `${i.verified_by_user_name} · ${when(i.verified_at)}` : '—'),
    );
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (i.status !== 'verified' && i.status !== 'disconnected') {
      actions.appendChild(link('Verify as an admin', 'btn-primary as-link', `/auth/verify?instance=${encodeURIComponent(i.id)}`));
    }
    if (i.status !== 'disconnected' && state.mode !== 'self-hosted') {
      // ADR 0011 D3, condition 2: a plan may commit only on an instance an
      // admin has marked non-production. Developer instances arrive marked.
      actions.appendChild(button(i.non_production ? 'Mark production' : 'Mark non-production', 'btn-ghost', () =>
        api(`/api/admin/instances/${i.id}/environment`, { non_production: !i.non_production })));
      actions.appendChild(button('Disconnect', 'btn-ghost', () => api(`/api/admin/instances/${i.id}/disconnect`, {})));
    }
    tr.appendChild(actions);
    return tr;
  });
  table('instances-table', ['Label', 'Host', 'Status', 'Environment', 'instance_id', 'Verified by', ''], rows);
}

function renderMembers(members) {
  const pending = members.filter((m) => m.status === 'pending').length;
  $('members-note').textContent = pending ? `${pending} waiting` : `${members.filter((m) => m.status === 'active').length} active`;
  const iAmOwner = state.me.role === 'owner';
  const rows = members.map((m) => {
    const tr = document.createElement('tr');
    if (m.status === 'pending') tr.className = 'is-pending';
    tr.append(
      cell(m.name || m.user_name || m.sn_user_sys_id),
      cell(m.user_name, 'mono'),
      pillCell(m.status, m.status === 'active' ? 'green' : m.status === 'pending' ? 'amber' : ''),
    );
    const roleTd = document.createElement('td');
    if (m.id === state.me.member_id || (m.role === 'owner' && !iAmOwner)) {
      roleTd.textContent = m.role;
    } else {
      const sel = document.createElement('select');
      sel.className = 'text-input compact';
      for (const r of ['member', 'admin', ...(iAmOwner ? ['owner'] : [])]) {
        const o = document.createElement('option');
        o.value = r; o.textContent = r; o.selected = r === m.role;
        sel.appendChild(o);
      }
      sel.addEventListener('change', async () => {
        try { await api(`/api/admin/members/${m.id}`, { role: sel.value }); await load(); } catch (err) { showError(err.message); }
      });
      roleTd.appendChild(sel);
    }
    tr.appendChild(roleTd);
    tr.appendChild(cell(m.pending_reason || (m.approved_by ? `approved by ${m.approved_by}` : ''), 'reason'));
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (m.id !== state.me.member_id) {
      if (m.status !== 'active') actions.appendChild(button('Approve', 'btn-primary', () => api(`/api/admin/members/${m.id}`, { status: 'active' })));
      if (m.status !== 'blocked' && !(m.role === 'owner' && !iAmOwner)) actions.appendChild(button('Block', 'btn-ghost', () => api(`/api/admin/members/${m.id}`, { status: 'blocked' })));
    }
    tr.appendChild(actions);
    return tr;
  });
  table('members-table', ['Name', 'User', 'Status', 'Role', 'Note', ''], rows);
}

function renderAccess(org) {
  $('a-name').value = org.name;
  document.querySelector(`input[name=join_policy][value=${org.join_policy === 'auto' ? 'auto' : 'approve'}]`).checked = true;
  $('a-deny-external').checked = org.deny_external !== false;
  $('a-runs-plan').checked = org.runs_plan_mode === true;
  $('a-autonomous').checked = org.autonomous_mode === true;
  $('a-required-role').value = org.required_role || '';
  $('a-session').value = org.session_ttl_ms ? String(org.session_ttl_ms) : '';
  const tiers = $('tiers');
  tiers.innerHTML = '';
  const enabled = new Set(String(org.actions_tiers || '1,2').split(','));
  const labels = {
    1: 'Tier 1 — task and request actions: replies, work notes, state and assignment changes, approvals',
    2: 'Tier 2 — configuration changes and creation, including executable code',
    3: 'Tier 3 — security-sensitive configuration (no actions available yet)',
  };
  for (const t of ['1', '2', '3']) {
    const label = document.createElement('label');
    label.className = 'check-row';
    const box = document.createElement('input');
    box.type = 'checkbox'; box.value = t; box.checked = enabled.has(t); box.name = 'tier';
    label.append(box, document.createTextNode(' ' + labels[t]));
    tiers.appendChild(label);
  }
}

function renderModel() {
  const connections = state.model_connections || [];
  $('model-note').textContent = connections.length ? `${connections.length} connected · no Kaddiya usage caps` : 'No models connected';
  const container = $('model-connections');
  container.replaceChildren();
  for (const connection of connections) {
    const card = document.createElement('article');
    card.className = 'model-connection';
    const copy = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = connection.label;
    const detail = document.createElement('p'); detail.textContent = `${connection.model_id} · ${connection.provider}`;
    const test = document.createElement('span'); test.className = 'step-note'; test.textContent = `Connection tested ${when(connection.tested_at)}`;
    copy.append(title, detail, test);
    const actions = document.createElement('div'); actions.className = 'form-row';
    actions.append(button('Edit', 'btn-ghost', async () => editModel(connection)), button('Remove', 'btn-ghost', async () => {
      if (!window.confirm(`Remove ${connection.label}? New tasks will need another connection.`)) return;
      await api('/api/admin/models', { operation: 'remove', id: connection.id });
    }));
    card.append(copy, actions); container.append(card);
  }
  const select = $('model-default'); select.replaceChildren();
  for (const model of state.available_models || []) {
    const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; select.append(option);
  }
  select.value = state.default_model || '';
  select.disabled = !select.options.length;
  document.querySelector('.model-default-row').hidden = !select.options.length;
  if (!editingModelId) syncModelFields();
}

function editModel(connection) {
  editingModelId = connection?.id || null;
  $('m-label').value = connection?.label || '';
  $('m-provider').value = connection?.provider || 'anthropic';
  $('m-base-url').value = connection?.base_url || '';
  $('m-model').value = connection?.model_id || '';
  $('m-effort').value = connection?.effort || '';
  $('m-key').value = '';
  $('model-result').textContent = '';
  $('model-editor').open = true;
  syncModelFields();
  $('m-label').focus();
}

function syncModelFields() {
  const provider = $('m-provider').value;
  const hasUrl = provider !== 'anthropic';
  $('m-base-url').hidden = !hasUrl;
  $('m-base-url-label').hidden = !hasUrl;
  $('m-base-url').required = provider === 'gateway';
  $('m-base-url-label').textContent = provider === 'openai' ? 'Endpoint URL (optional for OpenAI)' : 'Gateway URL';
  $('m-base-url').placeholder = provider === 'openai' ? 'https://api.openai.com/v1' : 'https://your-gateway.example.com/anthropic';
  $('m-model').placeholder = provider === 'openai' ? 'Your model or deployment ID' : 'claude-sonnet-5';
  $('m-key').required = !editingModelId;
  $('m-key-hint').textContent = editingModelId ? 'Leave blank to keep it; re-enter if changing endpoints.' : '';
  $('model-save').textContent = editingModelId ? 'Test and save changes' : 'Test and add model';
}
$('m-provider').addEventListener('change', syncModelFields);
$('model-cancel').addEventListener('click', () => { editingModelId = null; $('model-form').reset(); $('model-editor').open = false; syncModelFields(); });
$('model-default').addEventListener('change', async () => {
  try { await api('/api/admin/models', { operation: 'default', id: $('model-default').value }); await load(); }
  catch (err) { showError(err.message); }
});

function renderBilling() {
  const { plan } = state;
  const body = $('billing-body'); body.replaceChildren();
  const p = document.createElement('p'); p.className = 'step-desc';
  p.textContent = plan.id === 'self-hosted' ? 'Self-hosted deployment. Your provider bills model usage.' : 'Model usage is billed by your provider.';
  body.append(p);
}

let auditCursors = [null], auditNext = null;
async function loadAudit(reset = false) {
  if (reset) auditCursors = [null];
  const cursor = auditCursors.at(-1);
  const response = await api('/api/admin/audit' + (cursor ? '?before=' + encodeURIComponent(cursor) : ''));
  auditNext = response.next; renderAudit(response.audit);
  $('audit-prev').disabled = auditCursors.length === 1;
  $('audit-next').disabled = !auditNext;
  $('audit-page').textContent = `Page ${auditCursors.length}`;
}
$('audit-prev').addEventListener('click', async () => { if (auditCursors.length > 1) { auditCursors.pop(); try { await loadAudit(); } catch (err) { showError(err.message); } } });
$('audit-next').addEventListener('click', async () => { if (auditNext) { auditCursors.push(auditNext); try { await loadAudit(); } catch (err) { showError(err.message); } } });

function renderAudit(rows) {
  table('audit-table', ['When', 'User', 'Action', 'Table', 'Record', 'Approved'], rows.map((r) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(when(r.ts), 'mono'),
      cell(r.user || '—', 'mono'),
      cell((r.action === 'tool_call' ? (r.tool || 'Read data') : r.action).replaceAll('_', ' '), 'mono'),
      cell(r.table || '', 'mono'),
      cell(r.sys_id || r.host || r.member || r.note_id || '', 'mono'),
      cell(r.approval?.startsWith('autonomous:') ? 'autonomous task authorization' : r.approval?.startsWith('plan:') ? 'plan approval' : r.approved_by_user ? 'human click' : ''),
    );
    return tr;
  }));
}

// ---- forms ----

$('branding-form').addEventListener('submit', async e => {
  e.preventDefault(); showError('');
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true; $('branding-saved').textContent = '';
  try {
    const { org } = await api('/api/admin/settings', { name: $('brand-name').value.trim(), branding: brandingEditor.value() });
    state.org = org;
    KaddiyaBranding.apply(org);
    $('org-name').textContent = org.name;
    $('a-name').value = org.name;
    brandingEditor.load(org.branding);
    $('branding-saved').textContent = 'Branding saved.';
  } catch (err) { showError(err.message); }
  finally { button.disabled = false; }
});


$('instance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  try {
    const data = await api('/api/admin/instances', {
      label: $('i-label').value,
      host: $('i-host').value,
      client_id: $('i-client-id').value,
      client_secret: $('i-client-secret').value,
    });
    location.assign(data.verify_url);
  } catch (err) {
    showError(err.message);
  }
});

$('access-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  $('access-saved').textContent = '';
  try {
    await api('/api/admin/settings', {
      name: $('a-name').value,
      join_policy: document.querySelector('input[name=join_policy]:checked').value,
      deny_external: $('a-deny-external').checked,
      runs_plan_mode: $('a-runs-plan').checked,
      autonomous_mode: $('a-autonomous').checked,
      required_role: $('a-required-role').value,
      actions_tiers: [...document.querySelectorAll('input[name=tier]:checked')].map((b) => b.value).join(','),
      session_ttl_ms: $('a-session').value || null,
    });
    $('access-saved').textContent = 'Saved.';
    await load();
  } catch (err) {
    showError(err.message);
  }
});

$('model-form').addEventListener('submit', async e => {
  e.preventDefault(); showError('');
  const result = $('model-result');
  result.textContent = 'Testing connection, streaming, and tools…';
  $('model-save').disabled = true;
  try {
    await api('/api/admin/models', {
      operation: 'save', id: editingModelId || undefined,
      label: $('m-label').value, provider: $('m-provider').value,
      api_key: $('m-key').value || undefined, base_url: $('m-base-url').value,
      model_id: $('m-model').value, effort: $('m-effort').value,
    });
    editingModelId = null; $('model-form').reset();
    $('model-editor').open = false;
    showBanner('Model connected. Choose it in the composer and keep going without Kaddiya usage caps.');
    await load();
  } catch (err) { result.textContent = 'Connection not saved. ' + err.message; }
  finally { $('m-key').value = ''; $('model-save').disabled = false; }
});

// ---- boot ----

const params = new URLSearchParams(location.search);
if (params.get('verified')) showBanner('Instance verified. You are this org\'s owner; members who sign in on it now land in the queue below.');

load().catch((err) => showError(err.message));
