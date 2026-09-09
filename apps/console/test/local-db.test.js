import { resetDb, close, seedOrg } from './helpers/db.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, localStorage, localDataDir, withOrg, system } from '../server/db.js';
import { LocalPool } from '../server/local-db.js';

before(resetDb);
after(close);

test('overlapping transactions keep roles and tenant context isolated, including rollback', async () => {
  const a = await seedOrg('local-a');
  const b = await seedOrg('local-b');
  const seen = await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const org = index % 2 ? a : b;
    return withOrg(org.org.id, async client => {
      const before = await client.query('SELECT id FROM orgs');
      await new Promise(resolve => setTimeout(resolve, index % 3));
      const after = await client.query('SELECT id FROM orgs');
      assert.deepEqual(before.rows, [{ id: org.org.id }]);
      assert.deepEqual(after.rows, before.rows);
      return org.org.id;
    });
  }));
  assert.equal(new Set(seen).size, 2);
  await assert.rejects(withOrg(a.org.id, async client => {
    await client.query('UPDATE orgs SET name=$1', ['must-roll-back']);
    throw new Error('cancelled');
  }), /cancelled/);
  const rows = await system(client => client.query('SELECT name FROM orgs'));
  assert.ok(rows.rows.every(row => row.name !== 'must-roll-back'));
  await withOrg(b.org.id, async client => {
    assert.deepEqual((await client.query('SELECT id FROM orgs')).rows, [{ id: b.org.id }]);
  });
});

test('a second database instance cannot open the local data directory', async t => {
  if (!localStorage()) return t.skip('Local data directory locking applies to embedded storage.');
  // Initialize and hold the first database.
  const client = await db().connect(); client.release();
  const other = new LocalPool(localDataDir());
  await assert.rejects(other.connect(), /already open/);
  await other.end().catch(() => {});
  assert.equal((await system(client => client.query('SELECT 1 AS healthy'))).rows[0].healthy, 1);
});
