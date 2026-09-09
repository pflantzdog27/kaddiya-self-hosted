// The sign-in page has two shapes (ADR 0008 D11): self-hosted shows the one
// instance it will send you to; multi-tenant asks which instance is yours
// and resolves it to an org server-side. Kept in its own file, not inline,
// because the console serves a strict CSP with no 'unsafe-inline' (D8).

const notice = new URLSearchParams(location.search).get('notice');
if (notice) {
  const el = document.getElementById('notice');
  el.textContent = notice;
  el.hidden = false;
}

fetch('/api/config')
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(({ mode, instance_host, setup_required }) => {
    if (setup_required) return location.replace('/start');
    if (mode === 'self-hosted') {
      document.getElementById('self-hosted').hidden = false;
      if (instance_host) {
        document.getElementById('instance-host').textContent = instance_host;
        document.getElementById('instance-field').hidden = false;
      }
      return;
    }
    const form = document.getElementById('instance-form');
    const input = document.getElementById('instance');
    form.hidden = false;
    try {
      const last = localStorage.getItem('kd.instance');
      if (last) input.value = last;
    } catch { /* storage unavailable */ }
    // Navigate rather than submit. /auth/login answers with a 302 to the
    // instance's own OAuth page, and Chrome applies the CSP form-action
    // directive to the redirect that follows a form submission, so a real
    // submit is blocked by "form-action 'self'" (seen on kaddiya.com,
    // 2026-09-06). A navigation is not a form submission; form-action does
    // not apply, and the CSP stays as strict as it is.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const host = input.value.trim();
      if (!host) return input.focus();
      try { localStorage.setItem('kd.instance', host); } catch { /* ignore */ }
      location.assign('/auth/login?instance=' + encodeURIComponent(host));
    });
    input.focus();
  })
  .catch(() => {
    document.getElementById('self-hosted').hidden = false;
  });
