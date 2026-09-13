// The browser only receives public draft details. Credentials remain server-side.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let existingInstance = null;
const brandingEditor = KaddiyaBranding.editor(document.querySelector('[data-brand-editor]'), $('org-name'));
// The local launcher passes its operator code without putting it in HTTP
// requests, access logs or referrers. Remove it from browser history at once.
const launchCode = new URLSearchParams(location.hash.slice(1)).get('setup');
if (launchCode) {
  history.replaceState(null, '', location.pathname + location.search);
  $('setup-code').value = launchCode;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}). Please try again.`);
  return data;
}
function showInstanceStep(draft) {
  KaddiyaBranding.apply(draft.org);
  brandingEditor.preview();
  $('step-org').hidden = true;
  $('step-instance').hidden = false;
  $('step-verify').hidden = false;
  $('callback-url').textContent = draft.callback_url;
  $('setup-progress').textContent = '1 · Workspace ✓ / 2 · ServiceNow / 3 · Models';
  existingInstance = (draft.instances || []).find(i => i.status === 'draft') || null;
  if (existingInstance) {
    $('host').value = existingInstance.host;
    $('client-id').value = existingInstance.client_id;
    $('client-secret').required = false;
    $('client-secret').placeholder = 'Saved. Re-enter only to change the connection.';
    $('retry-row').hidden = false;
    $('retry-verify').href = `/auth/verify?instance=${encodeURIComponent(existingInstance.id)}`;
  }
}
async function init() {
  if (params.get('error')) showError(params.get('error'));
  try {
    const config = await api('/api/config');
    if (config.mode === 'self-hosted' && !config.setup_required) return location.replace('/');
    $('setup-code-row').hidden = config.mode !== 'self-hosted';
    $('setup-code').required = config.mode === 'self-hosted';
    const res = await fetch('/api/org/draft');
    if (res.status === 404) return;
    const draft = await res.json();
    if (!res.ok) throw new Error(draft.error || 'Could not load setup. Reload to retry.');
    showInstanceStep(draft);
  } catch (err) { showError(err.message); }
}
$('org-form').addEventListener('submit', async e => {
  e.preventDefault(); showError('');
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const draft = await api('/api/org', { name: $('org-name').value.trim(), branding: brandingEditor.changed() ? brandingEditor.value() : undefined, setup_token: $('setup-code').value.trim() });
    $('setup-code').value = '';
    showInstanceStep(draft);
    $('host').focus();
  } catch (err) { showError(err.message); }
  finally { button.disabled = false; }
});
$('instance-form').addEventListener('submit', async e => {
  e.preventDefault(); showError('');
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const secret = $('client-secret').value;
    const host = $('host').value.trim();
    const clientId = $('client-id').value.trim();
    if (existingInstance && !secret) {
      if (host !== existingInstance.host || clientId !== existingInstance.client_id) {
        throw new Error('Re-enter the client secret when changing the instance or client ID.');
      }
      return location.assign($('retry-verify').getAttribute('href'));
    }
    const data = await api('/api/org/draft/instance', { host, client_id: clientId, client_secret: secret });
    $('client-secret').value = '';
    location.assign(data.verify_url);
  } catch (err) { showError(err.message); button.disabled = false; }
});
$('change-details').addEventListener('click', () => $('host').focus());
$('copy-callback').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('callback-url').textContent); $('copy-status').textContent = 'Copied'; }
  catch { $('copy-status').textContent = 'Select and copy the URL above.'; }
});
init();
