// Local workspaces use embedded PGlite; shared hosts use PostgreSQL. Both
// keep org_id and row-level security on every tenant row. This module owns
// the connection boundary, including the serialized local checkout queue.
//
// Two ways to talk to the database, and the difference is the security story:
//
//   withOrg(orgId, fn)  — a transaction that first drops to the NOBYPASSRLS
//                         application role and pins app.org_id. Every tenant
//                         table's policy reads that setting, so a query in
//                         here cannot see or write another org's rows even if
//                         the SQL forgets its WHERE clause. This is the door
//                         for everything that happens on behalf of a session.
//
//   system(fn)          — the pool's own role, no org context. Used ONLY for
//                         the handful of lookups that happen before a tenant
//                         is known (which org does this hostname belong to?
//                         which session does this cookie name?), for org
//                         creation. test/db-gates.test.js checks the
//                         server for `system(` and fails the build if it shows
//                         up outside the modules listed there.
//
// Tenant tables (conversations, notebook_entries, audit_events, usage_events,
// members) carry FORCE ROW LEVEL SECURITY, so even the table owner is subject
// to the policy. Directory tables (orgs, instances, instance_aliases, sessions,
// oauth_states) carry ENABLE ROW LEVEL SECURITY: the app role is confined to
// its org, the owner role can resolve a hostname or a session id. The policy
// expression is `org_id = current_setting('app.org_id')::uuid`, which raises
// rather than returns when the setting is absent — a query outside withOrg()
// errors instead of leaking (D6 gate c).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LocalPool } from './local-db.js';

const { Pool } = pg;
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export const APP_ROLE = 'kaddiya_app';

let pool;

export function databaseUrl() {
  return process.env.DATABASE_URL || '';
}

export function localStorage() {
  const selected = process.env.KADDIYA_STORAGE;
  if (selected && !['local', 'postgres'].includes(selected)) throw new Error('KADDIYA_STORAGE must be local or postgres.');
  if (selected === 'local' && databaseUrl()) throw new Error('Both local storage and DATABASE_URL are configured. Choose one explicitly in apps/console/.env.');
  return selected === 'local' || (!selected && !databaseUrl());
}

export function localDataDir() {
  return path.resolve(path.dirname(MIGRATIONS_DIR), '..', process.env.KADDIYA_DATA_DIR || 'data/workspace');
}

export function db() {
  if (!pool) {
    if (localStorage()) {
      pool = new LocalPool(localDataDir());
      return pool;
    }
    const url = databaseUrl();
    if (!url) throw new Error('Set DATABASE_URL for PostgreSQL, or use npm run setup for local storage.');
    pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX || 8) });
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }
  return pool;
}

export async function close() {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

/**
 * Apply server/migrations/*.sql in name order, once each, inside a
 * transaction per file. Runs at boot (ADR 0008 D11: migrations at boot, one
 * image for SaaS and self-hosted).
 */
export async function migrate() {
  const client = await db().connect();
  try {
    // Several processes may boot at once (a rolling deploy, a test runner):
    // one runs the migrations, the rest wait on the lock and find them applied.
    await client.query('SELECT pg_advisory_lock(7245001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const ran = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7245001)').catch(() => {});
    client.release();
  }
}

/** Tenant transaction: app role + pinned org. See the module comment. */
export async function withOrg(orgId, fn) {
  if (!orgId || typeof orgId !== 'string') throw new Error('withOrg needs an org id');
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Directory access with no tenant context. Allowed callers are enumerated in test/db-gates.test.js. */
export async function system(fn) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
