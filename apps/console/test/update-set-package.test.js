// The update set package, pinned.
//
// Two things here are worth a test rather than a reading. The first is that
// packaging never writes: the fake client below fails the test if anything
// but a GET is attempted. The second is the payload round-trip — the whole
// artifact is worthless if a captured script comes back through the escaper
// changed by one character, and that is not something a reviewer can see by
// eye in a 12 MB file.
//
// The row shapes are copies of real `sys_update_set` / `sys_update_xml` rows
// read off an instance, including the reference fields that arrive as plain
// strings under sysparm_exclude_reference_link.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUpdateSetPackage, packageResponse, PackageError, MAX_ENTRIES } from '../server/update-set-package.js';

const SET_ID = '000679d09360fe107745f4974dba1003';

const SET = {
  sys_id: { display_value: SET_ID, value: SET_ID },
  name: { display_value: 'KD: incident autoclose', value: 'KD: incident autoclose' },
  description: { display_value: '', value: '' },
  state: { display_value: 'Complete', value: 'complete' },
  application: { display_value: 'Global', value: 'global' },
  release_date: { display_value: '', value: '' },
  is_default: { display_value: 'false', value: 'false' },
  parent: { display_value: '', value: '' },
  base_update_set: { display_value: '', value: '' },
  merged_to: { display_value: '', value: '' },
  sys_created_by: { display_value: 'a.pflantzer', value: 'a.pflantzer' },
  sys_created_on: { display_value: '2026-09-17 11:02:04', value: '2026-09-17 11:02:04' },
  sys_updated_by: { display_value: 'a.pflantzer', value: 'a.pflantzer' },
  sys_updated_on: { display_value: '2026-09-17 12:40:19', value: '2026-09-17 12:40:19' },
  completed_by: { display_value: 'a.pflantzer', value: 'a.pflantzer' },
  completed_on: { display_value: '2026-09-17 12:40:19', value: '2026-09-17 12:40:19' },
};

// A script payload with the three things that break a naive escaper: a `<`,
// an `&`, and a quote.
const SCRIPT_PAYLOAD =
  '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script">'
  + '<sys_script action="INSERT_OR_UPDATE"><name>Autoclose</name>'
  + '<script><![CDATA[(function(current) { if (current.state == 6 && current.u_flag != "x") { gs.info("close"); } })(current);]]></script>'
  + '<sys_id>2f1c9a7b93cb72907745f4974dba10e2</sys_id></sys_script></record_update>';

function entry(overrides = {}) {
  return {
    action: 'INSERT_OR_UPDATE',
    application: 'global',
    category: 'customer',
    comments: '',
    name: 'sys_script_2f1c9a7b93cb72907745f4974dba10e2',
    payload: SCRIPT_PAYLOAD,
    payload_hash: '-875692405',
    replace_on_upgrade: 'false',
    sys_created_by: 'a.pflantzer',
    sys_created_on: '2026-09-17 11:04:31',
    sys_id: '3a1c9a7b93cb72907745f4974dba10ff',
    sys_recorded_at: '199c4b9d53f0000001',
    sys_updated_by: 'a.pflantzer',
    sys_updated_on: '2026-09-17 11:04:31',
    table: 'sys_script',
    target_name: 'Autoclose',
    type: 'Business Rule',
    update_domain: 'global',
    update_guid: '038675181960fe1062f41ba3846ce9f0',
    update_guid_history: '038675181960fe1062f41ba3846ce9f0:-875692405',
    view: '',
    ...overrides,
  };
}

/**
 * A client that answers the two GETs the packager makes and refuses
 * everything else. `calls` is the proof of the read-only claim.
 */
function fakeSn({ set = SET, entries = [entry()] } = {}) {
  const calls = [];
  const deny = (name) => () => { throw new Error(`the packager called ${name}, which writes`); };
  return {
    calls,
    cfg: { instanceUrl: 'https://dev12345.service-now.com' },
    post: deny('post'), patch: deny('patch'), write: deny('write'),
    createUpdateSet: deny('createUpdateSet'), createArtifact: deny('createArtifact'),
    async currentUpdateSet() { calls.push('currentUpdateSet'); return { current: { sys_id: SET_ID, name: 'current' } }; },
    async get(pathname, params = {}) {
      calls.push(`GET ${pathname}`);
      if (pathname.startsWith('/api/now/table/sys_update_set/')) {
        if (!set) throw new Error('ServiceNow 404 on sys_update_set');
        return { result: set };
      }
      if (pathname === '/api/now/table/sys_update_xml') {
        const offset = Number(params.sysparm_offset || 0);
        const limit = Number(params.sysparm_limit || 50);
        return { result: entries.slice(offset, offset + limit) };
      }
      throw new Error(`unexpected GET ${pathname}`);
    },
  };
}

/** Minimal extraction — enough to assert structure without an XML library. */
const between = (xml, tag) => xml.slice(xml.indexOf(`<${tag} `), xml.indexOf(`</${tag}>`));
const valueOf = (xml, tag) => {
  const open = xml.indexOf(`<${tag}>`);
  if (open === -1) return xml.includes(`<${tag}/>`) ? '' : null;
  return xml.slice(open + tag.length + 2, xml.indexOf(`</${tag}>`));
};
const unescapeXml = (text) => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('packaging reads the set and its entries, and nothing else', async () => {
  const sn = fakeSn();
  await buildUpdateSetPackage(sn, { sys_id: SET_ID, actor: 'a.pflantzer' });
  assert.deepEqual(sn.calls, [
    `GET /api/now/table/sys_update_set/${SET_ID}`,
    'GET /api/now/table/sys_update_xml',
  ]);
});

test('an omitted sys_id packages the person\'s current set', async () => {
  const sn = fakeSn();
  const pkg = await buildUpdateSetPackage(sn, {});
  assert.equal(sn.calls[0], 'currentUpdateSet');
  assert.equal(pkg.manifest.sys_id, SET_ID);
});

test('the XML is an unload holding one remote set and one element per change', async () => {
  const sn = fakeSn({ entries: [entry(), entry({ sys_id: 'b'.repeat(32), target_name: 'Second' })] });
  const { xml } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<unload unload_date="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}">\n/);
  assert.ok(xml.trimEnd().endsWith('</unload>'));
  assert.equal(xml.match(/<sys_remote_update_set action="INSERT_OR_UPDATE">/g).length, 1);
  assert.equal(xml.match(/<sys_update_xml action="INSERT_OR_UPDATE">/g).length, 2);

  const remote = between(xml, 'sys_remote_update_set');
  // The set arrives ready to preview, carrying its origin so a re-import
  // updates the same retrieved row rather than making a second one.
  assert.equal(valueOf(remote, 'state'), 'loaded');
  assert.equal(valueOf(remote, 'remote_sys_id'), SET_ID);
  assert.equal(valueOf(remote, 'origin_sys_id'), SET_ID);
  assert.equal(valueOf(remote, 'name'), 'KD: incident autoclose');
  assert.equal(valueOf(remote, 'application_name'), 'Global');

  // Every change points at that set, or the import files it nowhere.
  const parent = valueOf(remote, 'sys_id');
  assert.match(parent, /^[0-9a-f]{32}$/);
  const links = [...xml.matchAll(/<remote_update_set>([0-9a-f]{32})<\/remote_update_set>/g)].map((m) => m[1]);
  assert.deepEqual(links, [parent, parent]);
});

test('the captured payload survives escaping unchanged', async () => {
  const sn = fakeSn();
  const { xml } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });

  // It must be escaped in the file...
  assert.ok(!xml.includes('<record_update'), 'the payload must not be live markup inside the unload');
  assert.ok(xml.includes('&lt;record_update'));
  // ...and identical once unescaped. A script that comes back one character
  // different is a package that deploys something nobody reviewed.
  assert.equal(unescapeXml(valueOf(between(xml, 'sys_update_xml'), 'payload')), SCRIPT_PAYLOAD);
});

test('fields are emitted in column order, and empty ones self-close', async () => {
  const sn = fakeSn({ entries: [entry({ comments: '', view: '' })] });
  const { xml } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  const element = between(xml, 'sys_update_xml');
  assert.ok(element.includes('<comments/>'), 'an empty column is an empty element, as an export writes it');
  const order = [...element.matchAll(/^<([a-z_]+)[>/]/gm)].map((m) => m[1]);
  assert.deepEqual(order, [...order].sort(), 'columns are alphabetical, so two packages of one set diff cleanly');
});

test('the same set packages to the same bytes', async () => {
  const first = await buildUpdateSetPackage(fakeSn(), { sys_id: SET_ID });
  const second = await buildUpdateSetPackage(fakeSn(), { sys_id: SET_ID });
  // unload_date is a clock reading; everything below it must be stable, or
  // two exports of untouched work look like a change.
  const body = (xml) => xml.split('\n').slice(2).join('\n');
  assert.equal(body(first.xml), body(second.xml));
});

test('control characters XML cannot carry are removed, and the ledger says so', async () => {
  const sn = fakeSn({ entries: [entry({ payload: `<x>a\u0001b</x>` })] });
  const { xml, ledger } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'the file must parse');
  assert.match(ledger, /control character/);
});

test('entries are read in capture order, across pages', async () => {
  const entries = Array.from({ length: 120 }, (_, i) =>
    entry({ sys_id: String(i).padStart(32, '0'), target_name: `Rule ${i}` }));
  const sn = fakeSn({ entries });
  const { manifest, xml } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  assert.equal(manifest.changes, 120);
  assert.equal(xml.match(/<sys_update_xml action=/g).length, 120);
  assert.equal(sn.calls.filter((c) => c.endsWith('sys_update_xml')).length, 3);
  const names = [...xml.matchAll(/<target_name>Rule (\d+)<\/target_name>/g)].map((m) => Number(m[1]));
  assert.deepEqual(names, names.slice().sort((a, b) => a - b));
});

test('the manifest describes the package without carrying it', async () => {
  const sn = fakeSn({ entries: [entry(), entry({ sys_id: 'c'.repeat(32), type: 'Script Include', table: 'sys_script_include' })] });
  const { manifest, bytes, sha256 } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  assert.equal(manifest.changes, 2);
  assert.deepEqual(manifest.by_type, [{ type: 'Business Rule', count: 1 }, { type: 'Script Include', count: 1 }]);
  assert.equal(manifest.source_instance, 'https://dev12345.service-now.com');
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.bytes, bytes);
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes('record_update'), 'no payload reaches the model through the manifest');
});

test('the ledger is the hand-over document', async () => {
  const { ledger, sha256, filenames } = await buildUpdateSetPackage(fakeSn(), { sys_id: SET_ID, actor: 'a.pflantzer' });
  assert.match(ledger, /^# Update set package — KD: incident autoclose/);
  assert.ok(ledger.includes(sha256));
  assert.ok(ledger.includes('https://dev12345.service-now.com'));
  assert.ok(ledger.includes('a.pflantzer'));
  assert.match(ledger, /Import Update Set from XML/);
  assert.match(ledger, /Preview Update Set/);
  assert.ok(ledger.includes('| Business Rule | Autoclose | sys_script | INSERT_OR_UPDATE |'));
  assert.deepEqual(filenames, { xml: 'kd-incident-autoclose.xml', ledger: 'kd-incident-autoclose-ledger.md' });
});

test('an in-progress set packages, with the warning on both the manifest and the ledger', async () => {
  const sn = fakeSn({ set: { ...SET, state: { display_value: 'In progress', value: 'in progress' } } });
  const { manifest, ledger } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  assert.equal(manifest.warnings.length, 1);
  assert.match(manifest.warnings[0], /not Complete/);
  assert.match(ledger, /Before you load this/);
});

test('a set in a batch warns that its siblings are not in the file', async () => {
  const sn = fakeSn({ set: { ...SET, parent: { display_value: 'Batch', value: 'f'.repeat(32) } } });
  const { warnings } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  assert.ok(warnings.some((w) => /part of a batch/.test(w)));
});

test('mixed scopes warn, because the target needs all of them', async () => {
  const sn = fakeSn({ entries: [entry(), entry({ sys_id: 'd'.repeat(32), application: 'x_kdy_thing' })] });
  const { warnings } = await buildUpdateSetPackage(sn, { sys_id: SET_ID });
  assert.ok(warnings.some((w) => /application scopes/.test(w)));
});

test('refusals: Default, empty, unknown, and too large to be one file', async () => {
  await assert.rejects(
    () => buildUpdateSetPackage(fakeSn({ set: { ...SET, is_default: { display_value: 'true', value: 'true' } } }), { sys_id: SET_ID }),
    (err) => err instanceof PackageError && err.code === 'default_set',
  );
  await assert.rejects(
    () => buildUpdateSetPackage(fakeSn({ entries: [] }), { sys_id: SET_ID }),
    (err) => err instanceof PackageError && err.code === 'empty',
  );
  await assert.rejects(
    () => buildUpdateSetPackage(fakeSn({ set: null }), { sys_id: SET_ID }),
    (err) => err instanceof PackageError && err.code === 'unreadable',
  );

  // The important one: over the cap it refuses rather than trimming. A
  // package missing its last hundred changes previews clean and deploys
  // something incomplete.
  const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => entry({ sys_id: String(i).padStart(32, '0') }));
  await assert.rejects(
    () => buildUpdateSetPackage(fakeSn({ entries: many }), { sys_id: SET_ID }),
    (err) => err instanceof PackageError && err.code === 'too_many',
  );
});

test('no update set selected and none named is a refusal, not an empty file', async () => {
  const sn = fakeSn();
  sn.currentUpdateSet = async () => ({ current: null });
  await assert.rejects(
    () => buildUpdateSetPackage(sn, {}),
    (err) => err instanceof PackageError && err.code === 'no_set',
  );
});

// ---- what the tool hands back, on each surface ----
//
// The bytes never travel in a tool result: an update set is far over any
// model's result cap, and a truncated package is the one failure this feature
// must not have. So the result names the file instead, and the name has to be
// usable on the surface that asked — relative for a browser already on the
// origin, absolute for a host that is not "on" anything (ADR 0014 D9).

test('the tool result describes the package and points at it, never carries it', async () => {
  const { executeTool } = await import('../server/agent.js');
  const events = [];
  const emit = (event, data) => events.push([event, data]);

  const overMcp = await executeTool(fakeSn(), 'sn_package_update_set', {}, emit, {
    consoleUrl: 'https://kaddiya.example.com',
  });
  assert.equal(overMcp.download.xml, `https://kaddiya.example.com/api/update-set/${SET_ID}/package.xml`);
  assert.equal(overMcp.download.ledger, `https://kaddiya.example.com/api/update-set/${SET_ID}/package.md`);
  assert.equal(overMcp.xml, undefined, 'the XML is never in the result');
  assert.ok(!JSON.stringify(overMcp).includes('record_update'), 'and neither is any captured payload');
  assert.equal(overMcp.changes, 1);
  assert.match(overMcp.sha256, /^[0-9a-f]{64}$/);

  // The browser is already on the origin, and a card renders from the event.
  const inConsole = await executeTool(fakeSn(), 'sn_package_update_set', {}, emit, {});
  assert.equal(inConsole.download.xml, `/api/update-set/${SET_ID}/package.xml`);
  assert.deepEqual(events.map(([event]) => event), ['package', 'package']);
  assert.equal(events[0][1].update_set, 'KD: incident autoclose');
  assert.equal(events[0][1].changes, 1);
});

test('a ledger too long for the result is left out rather than truncated', async () => {
  const { executeTool } = await import('../server/agent.js');
  const many = Array.from({ length: 300 }, (_, i) =>
    entry({ sys_id: String(i).padStart(32, '0'), target_name: `Rule ${i}` }));
  const out = await executeTool(fakeSn({ entries: many }), 'sn_package_update_set', {}, () => {}, {});
  assert.equal(out.ledger, undefined, 'half a ledger would misdescribe the package');
  assert.equal(out.items.length, 40);
  assert.match(out.items_truncated, /showing 40 of 300/);
  assert.equal(out.changes, 300, 'the count is still the whole set');
});

test('each file is served as itself, named after the set', async () => {
  const pkg = await buildUpdateSetPackage(fakeSn(), { sys_id: SET_ID });

  const xml = packageResponse(pkg, 'xml');
  assert.equal(xml.contentType, 'application/xml; charset=utf-8');
  assert.equal(xml.filename, 'kd-incident-autoclose.xml');
  assert.equal(xml.body, pkg.xml);
  assert.match(xml.body, /^<\?xml/, 'the XML is served whole, not a description of it');

  const ledger = packageResponse(pkg, 'md');
  assert.equal(ledger.contentType, 'text/markdown; charset=utf-8');
  assert.equal(ledger.filename, 'kd-incident-autoclose-ledger.md');
  assert.equal(ledger.body, pkg.ledger);

  // The filename goes into a Content-Disposition header unquoted, so it must
  // never carry a quote, a semicolon or a path separator, whatever the set is
  // called on the instance.
  for (const name of [xml.filename, ledger.filename]) assert.match(name, /^[a-z0-9-]+\.(xml|md)$/);
});

test('a hostile set name cannot escape the filename', async () => {
  const hostile = { ...SET, name: { display_value: 'x"; rm -rf /', value: '../../etc/passwd"; evil' } };
  const pkg = await buildUpdateSetPackage(fakeSn({ set: hostile }), { sys_id: SET_ID });
  assert.match(packageResponse(pkg, 'xml').filename, /^[a-z0-9-]+\.xml$/);
  assert.ok(!packageResponse(pkg, 'xml').filename.includes('..'));
});
