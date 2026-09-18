// Capture the seeded demo workspace as a capabilities PDF.
//
// Drives headless Chrome over the DevTools protocol — no Puppeteer, no new
// dependency, just the Chrome that is already on the machine and Node 22's
// own WebSocket. It sets the seeded session cookie, walks the console, and
// screenshots each screen at 2× for print; then it lays the shots out with
// their captions and prints that to PDF through the same browser.
//
// Run the seeder first, and leave the console running on the demo workspace:
//
//   node scripts/seed-demo.mjs   --dir /tmp/kaddiya-demo
//   KADDIYA_DATA_DIR=/tmp/kaddiya-demo … npm --prefix apps/console start
//   node scripts/demo-capture.mjs --dir /tmp/kaddiya-demo --out output/demo

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, wait } from './lib/chrome.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dataDir = path.resolve(flag('dir', path.join(os.tmpdir(), 'kaddiya-demo')));
const outDir = path.resolve(flag('out', path.join(ROOT, 'output', 'demo')));
const demo = JSON.parse(fs.readFileSync(path.join(dataDir, 'demo.json'), 'utf8'));
const shotsDir = path.join(outDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;

// ---- what to capture ----
//
// `until` is polled after load so a shot is never taken of a half-rendered
// page; `prepare` is the clicking a person would do to reach the state.

const SHOTS = [
  {
    name: '01-signin', url: '/signin', cookie: null,
    caption: 'Sign in',
    blurb: 'The workspace carries the organization\'s own name, colour and message before anyone signs in. '
      + 'There is no Kaddiya account: authentication is the customer\'s own ServiceNow instance, through OAuth, '
      + 'so their SSO and MFA apply and passwords never reach Kaddiya.',
    until: 'document.querySelector(".signin-host, #host-line, form") !== null',
  },
  {
    name: '02-workspace', url: '/',
    caption: 'The workspace',
    blurb: 'Conversations on the left, the composer below. The model, the reasoning effort and the work style '
      + 'are chosen per message — including which of several configured models runs this turn.',
    until: 'document.getElementById("who-name").textContent.length > 0',
  },
  {
    name: '03-read', url: '/', scroll: 'top',
    caption: 'Reading the instance',
    blurb: 'Every read runs on the signed-in person\'s own ServiceNow token, so ServiceNow\'s ACLs, roles and '
      + 'user criteria decide what comes back. Two people asking the same question get different answers, and '
      + 'the difference is produced by the platform, not by Kaddiya.',
    prepare: 'openByTitle("Show my open incidents")',
    until: 'document.querySelectorAll("#chat .bubble").length > 1',
  },
  {
    name: '04-evidence', url: '/', scroll: 'top',
    caption: 'Evidence, not assertion',
    blurb: 'The tool calls stay on the transcript: which table was queried, with what filter, and what came back. '
      + 'An answer can be checked rather than trusted.',
    prepare: 'openByTitle("Why did INC0012840 breach its SLA?")',
    until: 'document.querySelectorAll("#chat .tool-card, #chat .bubble").length > 2',
  },
  {
    name: '05-run', url: '/',
    caption: 'Longer work, in stages',
    blurb: 'A build runs as spec → review → plan approval → build → test → verify. The review stage is the model '
      + 'as a second developer checking the spec against the instance; here it sent the spec back once before the '
      + 'plan was approved.',
    prepare: 'openByTitle("Run: autoclose resolved incidents after 5 days")',
    until: 'document.querySelector(".run-rail, #chat .bubble") !== null',
  },
  {
    name: '06-package', url: '/', scroll: 'top',
    caption: 'The hand-over',
    blurb: 'When the work is captured in an update set, Kaddiya reads it back and produces the loadable XML plus a '
      + 'ledger of what is in it. Nothing is written to build it. The change is reviewed where it lands, in the '
      + 'target instance\'s own update set preview.',
    prepare: 'openByTitle("Package the autoclose update set")',
    until: 'document.querySelectorAll("#chat .bubble").length > 1',
  },
  {
    name: '07-profile', url: '/',
    caption: 'Connect your own MCP client',
    blurb: 'A member can point Claude Code or Claude Desktop at their own instance through Kaddiya and get the read '
      + 'tools only — no write is reachable, because a tool call is a model deciding and there is no card for anyone '
      + 'to click. Each token is one person on one instance, absolutely expiring, revocable from both sides, audited.',
    // The one screen that reads the live instance: /api/profile asks
    // ServiceNow for the person's own user record, roles and groups, and
    // there is no instance behind a seeded workspace. So that ONE response is
    // stubbed here with a plausible profile; everything else on the panel —
    // the org, the model, the session expiry, the MCP tokens — is the seeded
    // workspace answering for itself, and the markup is the console's own.
    prepare: `(() => {
      const real = window.fetch;
      window.fetch = (url, init) => String(url).includes('/api/profile')
        ? Promise.resolve(new Response(JSON.stringify(${JSON.stringify({
          user: {
            sys_id: 'db51f0b68799f1c3304dbbfd25091c07', user_name: 'avery.kline', name: 'Avery Kline',
            first_name: 'Avery', last_name: 'Kline', email: 'avery.kline@northwind.example.com',
            title: 'Senior ServiceNow Developer', department: 'Digital Platforms',
            location: 'Chicago', manager: 'Dana Whitfield', phone: '', time_zone: 'US/Central',
            last_login_time: '2026-09-18 08:12:44',
          },
          roles: {
            direct: ['catalog_admin', 'itil', 'sn_incident_write'],
            inherited: ['approver_user', 'snc_internal', 'template_editor'],
          },
          groups: ['Payroll Applications', 'Platform Admins', 'Service Desk'],
          instance: 'https://dev89412.service-now.com',
          org: { id: 'demo', name: 'Northwind Consulting', edition: 'self-hosted' },
          member: { role: 'owner', status: 'active' },
          admin: true,
          model: { id: 'claude-opus-5', label: 'Opus 5', effort: 'high', provider: 'Claude Opus 5' },
          session: {
            expires_at: '2026-09-18T21:58:06.000Z',
            token_expires_at: '2026-09-18T15:12:44.000Z',
          },
        })}), { headers: { 'Content-Type': 'application/json' } }))
        : real(url, init);
      document.getElementById('who').click();
    })()`,
    until: 'document.getElementById("panel") && !document.getElementById("panel").hidden'
      + ' && !/Could not load/.test(document.getElementById("panel-body").textContent)',
  },
];

const ADMIN_SHOTS = [
  { name: '08-admin-models', section: 'sec-model', caption: 'Bring your own models',
    blurb: 'Several connections from several providers, each with its own key, endpoint and model ID, one of them '
      + 'the default. Keys are encrypted in the workspace database and never returned to the browser. The provider '
      + 'bills the customer directly; Kaddiya takes no margin and needs no allowance.' },
  { name: '09-admin-members', section: 'sec-members', caption: 'Who may use the workspace',
    blurb: 'Membership is approved by an admin, and roles are owner, admin and member. Someone who leaves loses '
      + 'access through the customer\'s existing ServiceNow joiner/leaver process, because sign-in is their instance.' },
  { name: '10-admin-access', section: 'sec-access', caption: 'What the workspace may do',
    blurb: 'The action tiers, autonomous mode, plan-approved runs and the MCP surface are all deployment decisions, '
      + 'default-off where they matter. Turning the MCP surface off revokes its tokens.' },
  { name: '11-admin-mcp', section: 'sec-mcp', caption: 'Every token, listed',
    blurb: 'An admin sees every MCP token in the workspace: who minted it, from which client, when it was last used, '
      + 'when it expires and what clamped that expiry — and can revoke any of them.' },
  { name: '12-admin-audit', section: 'sec-audit', caption: 'Append-only audit',
    blurb: 'Every write and every MCP call is a row: who, what, which record, and whether a human approved it. '
      + 'The application role has UPDATE and DELETE revoked on this table, so the console cannot rewrite its own history.' },
  { name: '13-admin-branding', section: 'sec-branding', caption: 'The team\'s own identity',
    blurb: 'Name, logo and accent colour, stored in the workspace database. Logos are never fetched from third-party URLs.' },
];

// ---- capture ----

const browser = await openPage({ chrome: flag('chrome', undefined), width: WIDTH, height: HEIGHT });
const { send, evaluate } = browser;
const client = { once: browser.once };

await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
});

async function until(expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(`!!(${expression})`)) return true; } catch { /* still loading */ }
    await wait(150);
  }
  return false;
}

// Opening a conversation from the list is a click on its row, and the rows
// are rendered from a fetch — so this waits for the one it wants.
const HELPERS = `
window.openByTitle = async (title) => {
  for (let i = 0; i < 60; i++) {
    const row = [...document.querySelectorAll('.conv-open')]
      .find((el) => el.textContent.trim().startsWith(title.slice(0, 24)));
    if (row) { row.click(); return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('conversation not found: ' + title);
};`;

async function capture(name, { clip } = {}) {
  const metrics = await send('Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize;
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: clip || { x: 0, y: 0, width: WIDTH, height: Math.min(content.height, 4000), scale: 1 },
  });
  const file = path.join(shotsDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const captured = [];

// The cookie is set for the whole demo origin once; the sign-in shot clears it.
const setCookie = (value) => send('Network.setCookie', {
  name: 'sid', value, domain: 'localhost', path: '/',
});

for (const shot of SHOTS) {
  if (shot.cookie === null) await send('Network.clearBrowserCookies');
  else await setCookie(demo.sid);

  await send('Page.navigate', { url: demo.baseUrl + shot.url });
  await client.once('Page.loadEventFired');
  await evaluate(HELPERS);
  if (shot.until) await until(shot.until);
  if (shot.prepare) { await evaluate(shot.prepare); await wait(700); }
  if (shot.until) await until(shot.until);
  // The transcript opens scrolled to the newest message; for most of these
  // the question and the first tool call are the point, so wind it back.
  if (shot.scroll === 'top') {
    await evaluate(`(() => { const c = document.getElementById('chat');
      if (c) { c.scrollTop = 0; if (c.parentElement) c.parentElement.scrollTop = 0; }
      scrollTo(0, 0); })()`);
    await wait(350);
  }
  await wait(450);
  const file = await capture(shot.name);
  captured.push({ ...shot, file });
  console.log(`  ✓ ${shot.name}`);
}

// The pending-approval screen, as the person waiting actually sees it.
await send('Network.clearBrowserCookies');
await setCookie(demo.pendingSid);
await send('Page.navigate', { url: demo.baseUrl + '/pending' });
await client.once('Page.loadEventFired');
await until('document.body.textContent.length > 40');
await wait(500);
captured.push({
  name: '14-pending', caption: 'Waiting for approval',
  blurb: 'Someone who signs in before an admin has admitted them sees why, and nothing else. '
    + 'They hold no membership, so no instance call is ever made for them.',
  file: await capture('14-pending'),
});
console.log('  ✓ 14-pending');

// Admin is one scrolling page; each section is shot at its own bounds.
await send('Network.clearBrowserCookies');
await setCookie(demo.sid);
await send('Page.navigate', { url: demo.baseUrl + '/admin' });
await client.once('Page.loadEventFired');
await until('document.getElementById("sec-audit") && document.querySelectorAll("#sec-members tr, #sec-members .row, #sec-members li").length >= 0');
await wait(1200);

for (const shot of ADMIN_SHOTS) {
  const box = await evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(shot.section)});
    if (!el) return null;
    el.scrollIntoView();
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left + scrollX - 16), y: Math.max(0, r.top + scrollY - 16),
             width: Math.min(${WIDTH}, r.width + 32), height: r.height + 32 };
  })()`);
  if (!box) { console.log(`  · ${shot.name} skipped (no #${shot.section})`); continue; }
  await wait(250);
  const file = await capture(shot.name, { clip: { ...box, scale: 1 } });
  captured.push({ ...shot, file });
  console.log(`  ✓ ${shot.name}`);
}

// The approval cards, from scripts/demo-cards.mjs — one page each. Six cards
// on one page reduces every one of them to unreadable grey; the card IS the
// security argument, so each gets the width to be read.
const cardsPage = path.join(outDir, 'cards.html');
if (fs.existsSync(cardsPage)) {
  await send('Page.navigate', { url: `file://${cardsPage}` });
  await client.once('Page.loadEventFired');
  if (!await until('document.body.dataset.cardsReady')) throw new Error('the card gallery did not render');
  await wait(500);

  const items = await evaluate(`[...document.querySelectorAll('.gallery-item')].map((el, i) => {
    const card = el.querySelector('.gallery-slot > *');
    const r = card.getBoundingClientRect();
    return {
      index: i,
      title: el.querySelector('h2').textContent,
      note: el.querySelector('.gallery-note').textContent,
      // The card alone: this page prints the title and the note above the frame.
      box: { x: r.left + scrollX - 10, y: r.top + scrollY - 10, width: r.width + 20, height: r.height + 20 },
    };
  })`);

  for (const item of items) {
    const name = `15-${String(item.index + 1).padStart(2, '0')}-card`;
    captured.push({
      name,
      caption: item.title,
      blurb: `${item.note} Every write Kaddiya can make arrives as one of these: the agent draws the card, a `
        + `person clicks, and the write runs on that person's own ServiceNow token, audited as approved by them. `
        + `This is the console's own renderer, not a mock-up.`,
      file: await capture(name, { clip: { ...item.box, scale: 1 } }),
    });
    console.log(`  ✓ ${name} — ${item.title}`);
  }
}

// ---- the PDF ----

const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

const document_ = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kaddiya — capabilities</title>
<style>
  @page { size: 1180px 860px; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
         color: #14161a; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: 1180px; height: 860px; page-break-after: always; padding: 44px 56px;
          display: flex; flex-direction: column; overflow: hidden; }
  .page:last-child { page-break-after: auto; }
  .cover { justify-content: center; }
  .cover h1 { font-size: 52px; margin: 0 0 14px; letter-spacing: -0.02em; }
  .cover .sub { font-size: 20px; color: #4a5160; margin: 0 0 40px; }
  .cover ul { columns: 2; column-gap: 48px; padding-left: 20px; margin: 0; color: #2b313d;
              font-size: 14.5px; line-height: 2.05; }
  .cover .foot { margin-top: auto; color: #7b8290; font-size: 12px; }
  h2 { font-size: 25px; margin: 0 0 8px; letter-spacing: -0.01em; }
  .blurb { font-size: 13.5px; line-height: 1.62; color: #454c59; margin: 0 0 20px; max-width: 96ch; }
  .frame { flex: 1; min-height: 0; border: 1px solid #dfe3ea; border-radius: 9px; overflow: hidden;
           background: #fff; display: flex; align-items: flex-start; justify-content: center; }
  .frame img { width: 100%; height: 100%; object-fit: contain; object-position: top center; display: block; }
  .n { position: absolute; }
  .num { color: #9aa1ad; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 6px; }
</style></head><body>
<section class="page cover">
  <h1>Kaddiya</h1>
  <p class="sub">A self-hosted ServiceNow workspace. Your infrastructure, your models, your permissions.</p>
  <ul>
    ${captured.map((c) => `<li>${escape(c.caption)}</li>`).join('\n    ')}
  </ul>
  <p class="foot">${escape(demo.org)} · ${escape(demo.instanceHost)} · seeded demo workspace, no customer data.
     Kaddiya is not affiliated with or endorsed by ServiceNow.</p>
</section>
${captured.map((c, i) => `
<section class="page">
  <p class="num">${String(i + 1).padStart(2, '0')}</p>
  <h2>${escape(c.caption)}</h2>
  <p class="blurb">${escape(c.blurb)}</p>
  <div class="frame"><img src="${dataUri(c.file)}" alt="${escape(c.caption)}"></div>
</section>`).join('\n')}
</body></html>`;

const htmlPath = path.join(outDir, 'kaddiya-capabilities.html');
fs.writeFileSync(htmlPath, document_);

await send('Page.navigate', { url: `file://${htmlPath}` });
await client.once('Page.loadEventFired');
await wait(1500);
const { data: pdf } = await send('Page.printToPDF', {
  printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
});
const pdfPath = path.join(outDir, 'kaddiya-capabilities.pdf');
fs.writeFileSync(pdfPath, Buffer.from(pdf, 'base64'));

await browser.close();

console.log(`
${captured.length} screens captured.
  shots  ${shotsDir}
  html   ${htmlPath}
  pdf    ${pdfPath}  (${(fs.statSync(pdfPath).size / 1024 / 1024).toFixed(1)} MB)
`);
