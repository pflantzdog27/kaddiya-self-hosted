// Render the approval cards to a standalone page.
//
// The cards a reviewer most needs to see — the draft, the proposed record,
// the update set, the package, the notebook note — exist only while a turn is
// streaming: they are drawn from SSE events, and reopening a conversation
// replays the tool cards but not these. So a seeded workspace cannot show
// them, and demonstrating them would otherwise need a live model and a live
// instance.
//
// This writes a page that loads the console's own app.js and calls its own
// card factories against sample data, in a real browser DOM. It is not a
// mock-up and not a re-implementation: change a card in the product and this
// page changes with it. (The factories fill some parts of a card through DOM
// properties rather than markup — the draft's editable body, for one — which
// is why this needs a real DOM and not a stub.)
//
// `data-preview` on <body> is the console's own hook for exactly this: app.js
// checks it and skips init(), so nothing fetches and nothing signs in.
//
//   node scripts/demo-cards.mjs --out output/demo/cards.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'apps', 'console', 'public');

const args = process.argv.slice(2);
const outPath = path.resolve(args[args.indexOf('--out') + 1] || path.join(ROOT, 'output', 'demo', 'cards.html'));
const outDir = path.dirname(outPath);

const SCRIPT = `(function executeRule(current, previous) {
  var days = parseInt(gs.getProperty('northwind.autoclose.days', '5'), 10);
  if (new IncidentAutocloseUtil().isQuiet(current, days)) {
    current.state = 7;
    current.close_code = 'Closed by autoclose';
    current.update();
  }
})(current, previous);`;

const CARDS = [
  {
    title: 'Draft reply',
    note: 'A comment the agent wrote, before it is sent. The body stays editable, and the Send button is the only thing that writes.',
    factory: 'makeDraftCard',
    data: {
      table: 'incident', sys_id: 'bc9a1f2e77d301105f4c8e1a7b6d0c33', field: 'comments',
      text: 'Hi Marcus — the Saturday payroll export failed on an expired SFTP key, not on the data. '
        + 'I have rotated the key and re-run the export; the file landed at 09:14 this morning and Finance '
        + 'has confirmed receipt. I am leaving this open until Thursday\'s run completes cleanly, then I will close it.',
    },
  },
  {
    title: 'Proposed record',
    note: 'A configuration change, built from the live schema. The full script is on the card before anyone approves it.',
    factory: 'makeProposalCard',
    data: {
      action: 'dynamic.apply', operation: 'create', table: 'sys_script', label: 'Business Rule',
      name: 'Autoclose resolved incidents',
      fields: {
        name: 'Autoclose resolved incidents', collection: 'incident', when: 'async',
        order: '100', active: true, condition: 'current.state == 6', script: SCRIPT,
      },
      labels: {
        name: 'Name', collection: 'Table', when: 'When', order: 'Order',
        active: 'Active', condition: 'Condition', script: 'Script',
      },
      rationale: 'Closes incidents resolved for five days with no customer comment, per the approved spec.',
      confirmation: null,
    },
  },
  {
    title: 'Proposed record — on a security table',
    note: 'A tier-3 table does not just need a click: the approver types the record name first. The button stays disabled until they do.',
    factory: 'makeProposalCard',
    data: {
      action: 'dynamic.apply', operation: 'update', table: 'sys_security_acl', label: 'Access Control',
      sys_id: 'f0c21a9b7e4d22105f4c8e1a7b6d0c99', name: 'sn_hr_core_case.read',
      fields: { active: false },
      labels: { active: 'Active' },
      current: { active: 'true' },
      rationale: 'The duplicate read ACL shadows the role check; the approved spec deactivates it.',
      confirmation: 'sn_hr_core_case.read',
    },
  },
  {
    title: 'Proposed update set',
    note: 'Where the work will be captured. Creating it also makes it the current set.',
    factory: 'makeUpdateSetCard',
    data: {
      name: 'NW: incident autoclose',
      description: 'Autoclose rule, utility script include and its window property.',
      current: 'Default',
    },
  },
  {
    title: 'Update set package',
    note: 'The hand-over. Two downloads, read from the instance — the XML that loads on the target, and the ledger that says what is in it.',
    factory: 'makePackageCard',
    data: {
      sys_id: '9b1c4e77d3ba22105f4c8e1a7b6d0c33', update_set: 'NW: incident autoclose',
      state: 'Complete', changes: 3,
      by_type: [
        { type: 'Business Rule', count: 1 },
        { type: 'Script Include', count: 1 },
        { type: 'System Property', count: 1 },
      ],
      bytes: 11842,
      warnings: [],
      filenames: { xml: 'nw-incident-autoclose.xml', ledger: 'nw-incident-autoclose-ledger.md' },
    },
  },
  {
    title: 'Update set package — with a warning',
    note: 'The same card when the set is not finished. It still packages; it says what is wrong with doing so.',
    factory: 'makePackageCard',
    data: {
      sys_id: '4a7d2e60f85b22105f4c8e1a7b6d0c11', update_set: 'NW: SLA routing fix',
      state: 'In progress', changes: 2,
      by_type: [{ type: 'Business Rule', count: 1 }, { type: 'Script Include', count: 1 }],
      bytes: 6180,
      warnings: ['This set is "In progress", not Complete. Anything captured after this package was built is not in it.'],
      filenames: { xml: 'nw-sla-routing-fix.xml', ledger: 'nw-sla-routing-fix-ledger.md' },
    },
  },
  {
    title: 'Instance note',
    note: 'Something the agent learned about this instance. It informs this conversation only; it reaches future ones only if a person keeps it.',
    factory: 'makeNoteCard',
    data: {
      id: 'note-1', status: 'pending', context: 'incident',
      text: 'Incident state 6 is "Resolved" here, not "Closed" — closure is state 7 and requires close_code.',
    },
  },
];

const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// app.js reads these at parse time and would throw on null, so the host page
// carries them, hidden. This is the same shape app.html gives it.
const STUBS = ['chat', 'form', 'input', 'send', 'welcome', 'next-hint', 'panel', 'panel-body',
  'panel-close', 'who', 'who-name', 'who-avatar', 'admin-link', 'model-select', 'model-select-label',
  'thread-title', 'conversations', 'effort-select', 'effort-label', 'policy-select'];

const page = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>Kaddiya — approval cards</title>
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="gallery.css">
</head>
<body class="gallery-body" data-preview>
<div class="stubs" aria-hidden="true">
  ${STUBS.map((id) => (id === 'input' ? `<input id="${id}">` : `<div id="${id}"></div>`)).join('\n  ')}
</div>
<main class="gallery">
  <header class="gallery-head">
    <h1>Approval cards</h1>
    <p>Every write Kaddiya can make arrives as one of these. The agent draws the card; a person clicks
       the button; the write runs on that person's own ServiceNow token and is audited as theirs.
       These are the console's own renderers, called with sample data.</p>
  </header>
  ${CARDS.map((card, i) => `
  <section class="gallery-item" id="item-${i}">
    <h2>${escape(card.title)}</h2>
    <p class="gallery-note">${escape(card.note)}</p>
    <div class="gallery-slot" id="slot-${i}"></div>
  </section>`).join('\n')}
</main>
<script src="app.js"></script>
<script src="cards.js"></script>
</body>
</html>
`;

const driver = `// Generated by scripts/demo-cards.mjs — calls the console's own factories.
me = ${JSON.stringify({
  name: 'Avery Kline', user_name: 'avery.kline', instance_host: 'dev89412.service-now.com',
  admin: true, org: { id: 'demo', name: 'Northwind Consulting' },
})};

const CARDS = ${JSON.stringify(CARDS.map(({ factory, data }) => ({ factory, data })), null, 2)};

CARDS.forEach(({ factory, data }, i) => {
  const slot = document.getElementById('slot-' + i);
  const build = window[factory];
  if (typeof build !== 'function') {
    slot.textContent = 'public/app.js has no ' + factory + ' — the gallery is out of date';
    slot.style.color = 'crimson';
    return;
  }
  slot.appendChild(build(data));
});
document.body.dataset.cardsReady = String(CARDS.length);
`;

const galleryCss = `
.gallery-body { background: var(--bg); color: var(--text); margin: 0; font-family: var(--sans); }
.stubs { display: none; }
.gallery { max-width: 820px; margin: 0 auto; padding: 40px 24px 64px; }
.gallery-head h1 { font-size: 24px; margin: 0 0 10px; }
.gallery-head p { color: var(--muted); font-size: 13.5px; line-height: 1.6; margin: 0; max-width: 64ch; }
.gallery-item { margin-top: 38px; }
.gallery-item h2 { font-size: 15px; margin: 0 0 4px; }
.gallery-note { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin: 0 0 14px; max-width: 70ch; }
.gallery-slot .nc-card { margin: 0; }
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, page);
fs.writeFileSync(path.join(outDir, 'cards.js'), driver);
fs.writeFileSync(path.join(outDir, 'gallery.css'), galleryCss);
fs.copyFileSync(path.join(PUBLIC, 'style.css'), path.join(outDir, 'style.css'));
fs.copyFileSync(path.join(PUBLIC, 'app.js'), path.join(outDir, 'app.js'));

console.log(`Card gallery → ${outPath}`);
for (const card of CARDS) console.log(`  · ${card.title} (${card.factory})`);
