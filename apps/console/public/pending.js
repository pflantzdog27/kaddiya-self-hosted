// A member whose join is pending (or blocked) lands here (ADR 0008 D3).
// /api/me answers 403 with the status and the reason; an active member is
// sent on to the console.

async function load() {
  let res;
  try {
    res = await fetch('/api/me');
  } catch {
    return;
  }
  if (res.status === 401) return location.assign('/signin');
  if (res.ok) return location.assign('/');
  const data = await res.json().catch(() => ({}));
  const card = document.getElementById('status-card');
  const status = data.status || 'pending';
  document.getElementById('title').textContent = status === 'blocked'
    ? `Your access to ${data.org?.name || 'this org'} is blocked.`
    : `You are signed in, but not yet a member of ${data.org?.name || 'this org'}.`;
  document.getElementById('status-label').textContent = status;
  document.getElementById('status-text').textContent = data.reason
    || (status === 'blocked' ? 'An org admin blocked this account.' : 'Waiting for an org admin to approve your membership.');
  const who = data.user?.user_name ? `${data.user.name || ''} · ${data.user.user_name}`.replace(/^ · /, '') : '';
  document.getElementById('status-who').textContent = who;
  card.hidden = false;
}

document.getElementById('recheck').addEventListener('click', load);
document.getElementById('signout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.assign('/');
});
load();
