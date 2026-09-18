// Orgs, instances, members (ADR 0008 D1–D5).
//
// An org is a row that owns verified ServiceNow instances; the instance is
// the identity provider; membership is derived from being able to OAuth into
// one of the org's instances and passing its join policy. There is no console
// user directory and no password anywhere in this file.
//
// The load-bearing mechanism is verifyInstance(): after the registrant's own
// OAuth completes, the console reads the application registry record back
// through *their* token. System OAuth tables are admin-gated, so one read
// proves the admin role, control of the specific registry record, and its
// redirect URL — and binds the instance by its instance_id property rather
// than by hostname, because one instance can answer to many hostnames.

import crypto from 'node:crypto';
import { normalizeBranding } from './branding.js';
import { withOrg, system } from './db.js';
import { OrgContext, newWrappedDek } from './keys.js';

export const SESSION_CEILING_MS = 8 * 60 * 60 * 1000;
/** ADR 0014 D2: the code ceiling an org may only move downward from. */
export const MCP_TOKEN_CEILING_MS = 90 * 24 * 60 * 60 * 1000;
export const MCP_TOKEN_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_TTL_DAYS = 14;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('base64url');

const ORG_PUBLIC_COLUMNS = `id, name, branding, slug, region, edition, status, join_policy, deny_external, required_role,
  actions_tiers, session_ttl_ms, runs_plan_mode, autonomous_mode, mcp_enabled, mcp_token_ttl_ms, default_model_connection,
  COALESCE((SELECT jsonb_agg(c - 'key_enc') FROM jsonb_array_elements(orgs.model_connections) c), '[]'::jsonb) AS model_connections,
  model_provider, model_id, model_base_url, model_effort,
  plan, plan_status, stripe_customer_id, stripe_subscription_id, verified_at, anchor_instance_id,
  expires_at, created_at, updated_at, dek_wrapped, key_version, (model_key_enc IS NOT NULL) AS has_model_key`;

const INSTANCE_PUBLIC_COLUMNS = `id, org_id, label, host, instance_id, client_id, status, verified_by_sys_id,
  verified_by_user_name, verified_at, oauth_entity_sys_id, edge_encryption, non_production,
  refresh_token_lifespan_s, created_at, updated_at`;

/** A personal developer instance, by host. Marked non-production at registration (ADR 0011 D3). */
export const isDeveloperInstance = (host) => /^dev\d+\.service-now\.com$/.test(String(host || ''));

/** Strip an org row to what a browser may see (no wrapped key, no Stripe ids). */
export function publicOrg(org) {
  if (!org) return null;
  const { dek_wrapped, key_version, stripe_customer_id, stripe_subscription_id, draft_binding, ...rest } = org;
  return rest;
}

/**
 * A hostname the console will talk to: a public DNS name, nothing that could
 * point the egress at the console's own network (D6 egress allowlist; the
 * resolve-and-pin step is the residual). Scheme and path are dropped.
 */
export function normalizeHost(input) {
  let host = String(input || '').trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!host) throw new Error('An instance host is required.');
  if (host.includes(':') || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host) || host.includes('..')) {
    throw new Error('That does not look like an instance host (for example dev123456.service-now.com).');
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || !host.includes('.')
    || /\.(local|internal|localhost|home|lan|arpa)$/.test(host)) {
    throw new Error('The instance host must be a public DNS name.');
  }
  return host;
}

export function contextFor(orgRow) {
  return new OrgContext(orgRow);
}

export function sessionTtlFor(org) {
  const requested = Number(org?.session_ttl_ms) || SESSION_CEILING_MS;
  return Math.max(5 * 60 * 1000, Math.min(requested, SESSION_CEILING_MS));
}

/**
 * The effective lifetime of a new MCP token (ADR 0014 D2), and which bound
 * decided it: the person's request, then the org's ceiling, then the code
 * ceiling, then the instance's own refresh-token lifespan when the
 * verification read recorded one. The last is the real-world one —
 * docs/kit/02 tells instance admins to set 28,800 s, which silently caps a
 * 30-day token at eight hours unless we say so — so the reveal names it.
 */
export function mcpTokenTtlFor(org, requestedMs, instance) {
  const asked = Number(requestedMs) > 0 ? Number(requestedMs) : MCP_TOKEN_DEFAULT_MS;
  let ttl = Math.max(60 * 1000, Math.min(asked, MCP_TOKEN_CEILING_MS));
  let clampedBy = ttl < asked ? 'code_ceiling' : null;

  const orgCeiling = Number(org?.mcp_token_ttl_ms) || 0;
  if (orgCeiling > 0 && orgCeiling < ttl) { ttl = orgCeiling; clampedBy = 'org_ceiling'; }

  const lifespanMs = Number(instance?.refresh_token_lifespan_s) > 0
    ? Number(instance.refresh_token_lifespan_s) * 1000 : 0;
  if (lifespanMs > 0 && lifespanMs < ttl) { ttl = lifespanMs; clampedBy = 'refresh_token_lifespan'; }

  return { ttlMs: ttl, clampedBy };
}

// ---- orgs ----

export async function createOrgDraft({ name, region = 'us', edition = 'saas' }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new Error('An org name is required.');
  const id = crypto.randomUUID();
  const draftSecret = crypto.randomBytes(32).toString('base64url');
  await system((c) => c.query(
    `INSERT INTO orgs (id, name, region, edition, status, dek_wrapped, draft_binding, expires_at, plan)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, now() + ($7 || ' days')::interval, 'free')`,
    [id, clean, region, edition, newWrappedDek(id), sha256(draftSecret), String(DRAFT_TTL_DAYS)],
  ));
  return { org: await getOrg(id), draftSecret };
}

/** One workspace per self-hosted installation. The operator code is checked by the route. */
export async function createSelfHostedDraft({ name, branding }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new Error('A workspace name is required.');
  const identity = branding === undefined ? null : JSON.stringify(normalizeBranding(branding));
  const draftSecret = crypto.randomBytes(32).toString('base64url');
  const id = await system(async c => {
    await c.query('BEGIN');
    try {
      await c.query('SELECT pg_advisory_xact_lock(72419011)');
      const { rows } = await c.query(`SELECT id, status FROM orgs WHERE edition = 'self-hosted' ORDER BY created_at LIMIT 1 FOR UPDATE`);
      if (rows[0] && rows[0].status !== 'draft') throw new Error('This workspace is already configured. Sign in with ServiceNow.');
      const orgId = rows[0]?.id || crypto.randomUUID();
      if (rows.length) {
        // The operator can resume an abandoned setup in a new browser without
        // discarding saved instance details or creating a second workspace.
        await c.query(`UPDATE orgs SET name=$2, draft_binding=$3, expires_at=now()+interval '14 days' WHERE id=$1`, [orgId, clean, sha256(draftSecret)]);
      } else {
        await c.query(`INSERT INTO orgs (id,name,region,edition,status,dek_wrapped,draft_binding,expires_at,plan)
          VALUES ($1,$2,'us','self-hosted','draft',$3,$4,now()+interval '14 days','self-hosted')`,
        [orgId, clean, newWrappedDek(orgId), sha256(draftSecret)]);
      }
      if (identity !== null) await c.query('UPDATE orgs SET branding=$2::jsonb, updated_at=now() WHERE id=$1', [orgId, identity]);
      await c.query('COMMIT');
      return orgId;
    } catch (err) { await c.query('ROLLBACK'); throw err; }
  });
  return { org: await getOrg(id), draftSecret };
}

export async function selfHostedDeployment() {
  const { rows } = await system(c => c.query(`SELECT ${ORG_PUBLIC_COLUMNS} FROM orgs WHERE edition='self-hosted' AND status='active' ORDER BY created_at LIMIT 1`));
  const org = rows[0];
  if (!org) return null;
  const instance = await getInstance(contextFor(org), org.anchor_instance_id);
  return instance?.status === 'verified' ? { org, instance } : null;
}

/** Directory read: the org row a session or a draft cookie resolved to. */
export async function getOrg(orgId) {
  const { rows } = await system((c) => c.query(`SELECT ${ORG_PUBLIC_COLUMNS} FROM orgs WHERE id = $1`, [orgId]));
  return rows[0] || null;
}

export async function orgForDraft(draftSecret) {
  if (!draftSecret) return null;
  const { rows } = await system((c) => c.query(
    `SELECT ${ORG_PUBLIC_COLUMNS} FROM orgs WHERE draft_binding = $1 AND status = 'draft' AND expires_at > now()`,
    [sha256(draftSecret)],
  ));
  return rows[0] || null;
}

const SETTABLE = new Set(['name', 'branding', 'join_policy', 'deny_external', 'required_role', 'actions_tiers',
  'session_ttl_ms', 'runs_plan_mode', 'autonomous_mode', 'mcp_enabled', 'mcp_token_ttl_ms']);

export async function updateOrgSettings(ctx, patch) {
  const sets = [];
  const values = [];
  let mcpTurnedOff = false;
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!SETTABLE.has(key)) continue;
    let value = raw;
    if (key === 'branding') value = JSON.stringify(normalizeBranding(raw));
    if (key === 'name') value = String(raw || '').trim().slice(0, 80) || null;
    if (key === 'join_policy') value = raw === 'auto' ? 'auto' : 'approve';
    if (key === 'deny_external') value = raw !== false && raw !== 'false';
    if (key === 'runs_plan_mode' || key === 'autonomous_mode') value = raw === true || raw === 'true';  // ADR 0011 D3, condition 1
    // ADR 0014 D5: off by default, and turning it off revokes every token.
    if (key === 'mcp_enabled') { value = raw === true || raw === 'true'; mcpTurnedOff = !value; }
    if (key === 'required_role') value = String(raw || '').trim().slice(0, 80) || null;
    if (key === 'actions_tiers') {
      const tiers = String(raw || '').split(',').map((t) => t.trim()).filter((t) => /^[123]$/.test(t));
      value = tiers.length ? [...new Set(tiers)].sort().join(',') : '1';
    }
    if (key === 'session_ttl_ms') value = raw ? Math.min(Number(raw), SESSION_CEILING_MS) : null;
    if (key === 'mcp_token_ttl_ms') value = raw ? Math.min(Number(raw), MCP_TOKEN_CEILING_MS) : null;
    if (value === null && key === 'name') continue;
    values.push(value);
    sets.push(`${key} = $${values.length}`);
  }
  if (!sets.length) return getOrg(ctx.orgId);
  await withOrg(ctx.orgId, async (c) => {
    await c.query(`UPDATE orgs SET ${sets.join(', ')}, updated_at = now() WHERE id = current_setting('app.org_id')::uuid`, values);
    // The org wall does the WHERE: inside withOrg this cannot reach another
    // org's rows even though the statement names no org_id (D3).
    if (mcpTurnedOff) await c.query(`UPDATE mcp_tokens SET revoke_on_present = true`);
  });
  return getOrg(ctx.orgId);
}

/** BYOM (D9): the org's own model credential, write-only, under the org key. */
export async function setOrgModel(ctx, { provider, apiKey, baseUrl, modelId, effort }) {
  if (provider === 'trial') {
    await withOrg(ctx.orgId, (c) => c.query(
      `UPDATE orgs SET model_provider = 'trial', model_key_enc = NULL, model_base_url = NULL, model_id = NULL, model_effort = NULL, updated_at = now()
       WHERE id = current_setting('app.org_id')::uuid`,
    ));
    return getOrg(ctx.orgId);
  }
  if (!['anthropic', 'gateway', 'openai'].includes(provider)) throw new Error('provider must be trial, anthropic, gateway or openai');
  let url = null;
  // A gateway is nothing without its URL; an OpenAI-compatible endpoint
  // defaults to api.openai.com and takes one for Azure OpenAI, vLLM, LiteLLM
  // (ADR 0009 D4). Either way it is https and passes the egress rules.
  const raw = String(baseUrl || '').trim();
  if (provider === 'gateway' || (provider === 'openai' && raw)) {
    url = raw.replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/]+/.test(url)) throw new Error(provider === 'gateway' ? 'A gateway needs an https:// base URL.' : 'The base URL must start with https://.');
    normalizeHost(new URL(url).host); // same egress rules as an instance host
  }
  const sets = ['model_provider = $1', 'model_base_url = $2', 'model_id = $3', 'model_effort = $4', 'updated_at = now()'];
  const values = [provider, url, String(modelId || '').trim().slice(0, 80) || null, String(effort || '').trim().slice(0, 12) || null];
  if (apiKey) {
    values.push(ctx.encrypt('orgs.model_key', String(apiKey)));
    sets.push(`model_key_enc = $${values.length}`);
  }
  await withOrg(ctx.orgId, (c) => c.query(`UPDATE orgs SET ${sets.join(', ')} WHERE id = current_setting('app.org_id')::uuid`, values));
  return getOrg(ctx.orgId);
}

export async function orgModelKey(ctx) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(`SELECT model_key_enc FROM orgs WHERE id = current_setting('app.org_id')::uuid`));
  const enc = rows[0]?.model_key_enc;
  return enc ? ctx.decrypt('orgs.model_key', enc) : null;
}

// Model connections share the org's RLS boundary. Secrets are separately bound
// to each connection ID as well as the org's encryption key (ADR 0012).
export function cleanModelConnection(input) {
  const provider = input.provider;
  if (!['anthropic', 'gateway', 'openai'].includes(provider)) throw new Error('Choose a supported provider.');
  const model_id = String(input.model_id || '').trim();
  const label = String(input.label || '').trim();
  if (!model_id || model_id.length > 160 || !label || label.length > 80) throw new Error('Add a name and model ID (up to 80 and 160 characters).');
  let base_url = String(input.base_url || '').trim().replace(/\/+$/, '');
  if (provider === 'anthropic') base_url = '';
  if (provider === 'gateway' && !base_url) throw new Error('Add your gateway URL.');
  if (base_url) {
    const url = new URL(base_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Use an HTTPS endpoint without credentials, query parameters, or fragments.');
    normalizeHost(url.hostname);
  }
  const effort = String(input.effort || '').trim();
  if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Choose a valid reasoning effort.');
  return { provider, label, model_id, base_url, effort };
}

export async function modelConnectionKey(ctx, id) {
  const { rows } = await withOrg(ctx.orgId, c => c.query(
    `SELECT model_connections FROM orgs WHERE id = current_setting('app.org_id')::uuid`));
  const connection = rows[0]?.model_connections.find(c => c.id === id);
  if (!connection?.key_enc) throw new Error('This model connection is no longer available. Choose another model.');
  return ctx.decrypt(`orgs.model_connection.${id}`, typeof connection.key_enc === 'string' ? Buffer.from(connection.key_enc, 'base64') : connection.key_enc);
}

export async function saveModelConnection(ctx, details, apiKey, id) {
  const clean = cleanModelConnection(details);
  if (!apiKey || typeof apiKey !== 'string') throw new Error('An API key is required.');
  const connectionId = id || crypto.randomUUID();
  await withOrg(ctx.orgId, async c => {
    const { rows } = await c.query(`SELECT model_connections FROM orgs WHERE id = current_setting('app.org_id')::uuid FOR UPDATE`);
    const connections = rows[0].model_connections;
    if (id && !connections.some(m => m.id === id)) throw new Error('Model connection not found.');
    const next = { ...clean, id: connectionId, has_key: true, tested_at: new Date().toISOString(), key_enc: ctx.encrypt(`orgs.model_connection.${connectionId}`, apiKey).toString('base64') };
    const updated = [...connections.filter(m => m.id !== connectionId), next];
    await c.query(`UPDATE orgs SET model_connections = $1, default_model_connection = COALESCE(default_model_connection, $2), updated_at = now() WHERE id = current_setting('app.org_id')::uuid`, [JSON.stringify(updated), connectionId]);
  });
  return getOrg(ctx.orgId);
}

export async function removeModelConnection(ctx, id) {
  await withOrg(ctx.orgId, async c => {
    const { rows } = await c.query(`SELECT model_connections, default_model_connection FROM orgs WHERE id = current_setting('app.org_id')::uuid FOR UPDATE`);
    const remaining = rows[0].model_connections.filter(m => m.id !== id);
    if (remaining.length === rows[0].model_connections.length) throw new Error('Model connection not found.');
    await c.query(`UPDATE orgs SET model_connections = $1, default_model_connection = CASE WHEN default_model_connection = $2 THEN NULL ELSE default_model_connection END, updated_at = now() WHERE id = current_setting('app.org_id')::uuid`, [JSON.stringify(remaining), id]);
  });
  return getOrg(ctx.orgId);
}

export async function setDefaultModelConnection(ctx, id) {
  await withOrg(ctx.orgId, c => c.query(`UPDATE orgs SET default_model_connection = $1, updated_at = now() WHERE id = current_setting('app.org_id')::uuid`, [id]));
  return getOrg(ctx.orgId);
}

// ---- instances ----

export async function addInstanceDraft(ctx, { host, clientId, clientSecret, label }) {
  const cleanHost = normalizeHost(host);
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('The client ID is the 32-character value on the application registry record.');
  if (secret.length < 8) throw new Error('The client secret is missing or too short.');
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `INSERT INTO instances (org_id, label, host, client_id, client_secret_enc, non_production)
     VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)
     RETURNING ${INSTANCE_PUBLIC_COLUMNS}`,
    [String(label || 'prod').trim().slice(0, 40) || 'prod', cleanHost, id, ctx.encrypt('instances.client_secret', secret), isDeveloperInstance(cleanHost)],
  ));
  return rows[0];
}

/** Re-enter credentials on an existing draft or a record that needs re-verification. */
export async function updateInstanceCredentials(ctx, instanceId, { host, clientId, clientSecret }) {
  const cleanHost = normalizeHost(host);
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('The client ID is the 32-character value on the application registry record.');
  if (secret.length < 8) throw new Error('The client secret is missing or too short.');
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `UPDATE instances SET host = $2, client_id = $3, client_secret_enc = $4, updated_at = now()
     WHERE id = $1 AND status <> 'disconnected' RETURNING ${INSTANCE_PUBLIC_COLUMNS}`,
    [instanceId, cleanHost, id, ctx.encrypt('instances.client_secret', secret)],
  ));
  return rows[0] || null;
}

export async function listInstances(ctx) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(`SELECT ${INSTANCE_PUBLIC_COLUMNS} FROM instances ORDER BY created_at`));
  return rows;
}

export async function getInstance(ctx, instanceId) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(`SELECT ${INSTANCE_PUBLIC_COLUMNS} FROM instances WHERE id = $1`, [instanceId]));
  return rows[0] || null;
}

/**
 * The OAuth client configuration for one instance: what server/sn.js needs to
 * exchange a code, refresh, and call the Table API. The secret is decrypted
 * here and nowhere else.
 */
export async function instanceConfig(ctx, instanceId, baseUrl) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `SELECT ${INSTANCE_PUBLIC_COLUMNS}, client_secret_enc FROM instances WHERE id = $1`, [instanceId],
  ));
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    host: row.host,
    label: row.label,
    status: row.status,
    instanceUrl: `https://${row.host}`,
    clientId: row.client_id,
    clientSecret: ctx.decrypt('instances.client_secret', row.client_secret_enc),
    baseUrl,
    org: ctx.org.slug || ctx.org.name,
  };
}

/** Directory lookup at sign-in: which verified instance, and whose, answers to this host? */
export async function resolveHost(input) {
  const host = normalizeHost(input);
  const { rows } = await system((c) => c.query(
    `SELECT i.id AS instance_id, i.org_id
       FROM instance_aliases a
       JOIN instances i ON i.id = a.instance_id
       JOIN orgs o ON o.id = a.org_id
      WHERE a.host = $1 AND i.status = 'verified' AND o.status = 'active'`,
    [host],
  ));
  if (!rows[0]) return null;
  const org = await getOrg(rows[0].org_id);
  const ctx = contextFor(org);
  const instance = await getInstance(ctx, rows[0].instance_id);
  return { org, ctx, instance };
}

/**
 * Verification of control (D2). `sn` is a client on the registrant's own
 * token for this instance; `expectedRedirect` is the console's callback.
 */
export async function verifyInstance(ctx, instanceId, { sn, user, expectedRedirect }) {
  const instance = await getInstance(ctx, instanceId);
  if (!instance) throw new Error('Unknown instance.');

  let entity;
  try {
    entity = await sn.readOAuthEntity(instance.client_id);
  } catch (err) {
    throw new Error(`Could not read the application registry record on ${instance.host} as ${user?.user_name || 'this user'}: ${err.message}. Verification has to be completed by an admin, because System OAuth records are admin-only on the instance.`);
  }
  if (!entity) {
    throw new Error(`No application registry record with client ID ${instance.client_id} was readable on ${instance.host}. Check the client ID, and that you signed in as an admin.`);
  }
  const redirects = String(entity.redirect_url || '').split(/[\s,]+/).filter(Boolean);
  if (!redirects.includes(expectedRedirect)) {
    throw new Error(`The registry record's redirect URL is "${entity.redirect_url || '(empty)'}", not ${expectedRedirect}. Set it to exactly that value and verify again.`);
  }

  let snInstanceId = '';
  try {
    snInstanceId = await sn.instanceProperty('instance_id');
  } catch (err) {
    throw new Error(`Could not read the instance_id property on ${instance.host}: ${err.message}`);
  }
  if (!snInstanceId) throw new Error(`The instance_id property on ${instance.host} is empty or unreadable — the console binds an instance by that value, not by hostname.`);

  // The registry's refresh-token lifespan, when this admin's token could read
  // it (ADR 0014 D2). It caps an MCP token's life at the first refresh, so we
  // record it here and clamp at mint rather than letting a "30-day" token die
  // in eight hours without explanation. Null when the field is absent — an
  // older instance, or a read that did not return it.
  const lifespan = Number(entity.refresh_token_lifespan);
  const refreshLifespanS = Number.isFinite(lifespan) && lifespan > 0 ? Math.floor(lifespan) : null;

  try {
    await withOrg(ctx.orgId, async (c) => {
      await c.query(
        `UPDATE instances SET status = 'verified', instance_id = $2, verified_by_sys_id = $3, verified_by_user_name = $4,
                verified_at = now(), oauth_entity_sys_id = $5, refresh_token_lifespan_s = $6, updated_at = now()
          WHERE id = $1`,
        [instanceId, snInstanceId, user?.sys_id || null, user?.user_name || null, entity.sys_id || null, refreshLifespanS],
      );
      await c.query(
        `INSERT INTO instance_aliases (host, org_id, instance_id) VALUES ($1, current_setting('app.org_id')::uuid, $2)
         ON CONFLICT (host) DO UPDATE SET instance_id = EXCLUDED.instance_id, verified_at = now()
           WHERE instance_aliases.org_id = current_setting('app.org_id')::uuid`,
        [instance.host, instanceId],
      );
      await c.query(
        `UPDATE orgs SET status = 'active', verified_at = COALESCE(verified_at, now()),
                anchor_instance_id = COALESCE(anchor_instance_id, $1), draft_binding = NULL, expires_at = NULL, updated_at = now()
          WHERE id = current_setting('app.org_id')::uuid`,
        [instanceId],
      );
      // The registrant of the first verified instance is the Owner; a later
      // admin who verifies another instance keeps whatever role they hold.
      await c.query(
        `INSERT INTO members (org_id, instance_id, sn_user_sys_id, user_name, name, role, status, approved_by, approved_at, last_seen_at)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4,
                 CASE WHEN EXISTS (SELECT 1 FROM members WHERE role = 'owner') THEN 'admin' ELSE 'owner' END,
                 'active', 'instance verification', now(), now())
         ON CONFLICT (org_id, sn_user_sys_id) DO UPDATE
           SET status = 'active', instance_id = EXCLUDED.instance_id, user_name = EXCLUDED.user_name, name = EXCLUDED.name,
               role = CASE WHEN members.role = 'member' THEN 'admin' ELSE members.role END, last_seen_at = now()`,
        [instanceId, user?.sys_id || 'unknown', user?.user_name || null, user?.name || null],
      );
    });
  } catch (err) {
    if (err.code === '23505' && /instances_instance_id_key/.test(err.message || err.constraint || '')) {
      throw new Error('This ServiceNow instance is already registered to another org. One instance belongs to one org; ask that org\'s owner, or contact support with your instance host.');
    }
    if (err.code === '23505') throw new Error('That hostname is already registered to another org.');
    throw err;
  }
  return getInstance(ctx, instanceId);
}

export async function disconnectInstance(ctx, instanceId) {
  return withOrg(ctx.orgId, async (c) => {
    await c.query(`UPDATE instances SET status = 'disconnected', updated_at = now() WHERE id = $1`, [instanceId]);
    await c.query(`DELETE FROM instance_aliases WHERE instance_id = $1`, [instanceId]);
    await c.query(`UPDATE sessions SET revoke_on_present = true WHERE instance_id = $1`, [instanceId]);
    // ADR 0014 D3: an MCP token names the instance it was minted against.
    await c.query(`UPDATE mcp_tokens SET revoke_on_present = true WHERE instance_id = $1`, [instanceId]);
    return true;
  });
}

// ---- members ----

/**
 * Sign-in door policy (D3). Authentication happened on the instance; this
 * decides entitlement. Every check reads the joiner's own token; if the
 * instance's ACLs deny those reads, the joiner lands in the pending queue
 * with the reason — never silently in, never silently out.
 */
export async function signinMember(ctx, { org, instance, user, sn }) {
  const sysId = user?.sys_id;
  if (!sysId) throw new Error('Could not read your user record on the instance.');

  const existing = await withOrg(ctx.orgId, (c) => c.query(`SELECT * FROM members WHERE sn_user_sys_id = $1`, [sysId]));
  if (existing.rows[0]) {
    const { rows } = await withOrg(ctx.orgId, (c) => c.query(
      `UPDATE members SET user_name = $2, name = $3, instance_id = $4, last_seen_at = now() WHERE sn_user_sys_id = $1 RETURNING *`,
      [sysId, user.user_name || null, user.name || null, instance.id],
    ));
    return rows[0];
  }

  let status = 'pending';
  let reason = null;
  try {
    const roles = await sn.myRoleNames();
    if (org.deny_external && roles.includes('snc_external')) {
      reason = 'External (snc_external) accounts are not admitted to this org.';
    } else if (org.required_role && !roles.includes(org.required_role)) {
      reason = `This org admits users with the ${org.required_role} role; your account does not carry it.`;
    } else if (org.join_policy === 'auto') {
      status = 'active';
    } else {
      reason = 'Waiting for an org admin to approve your membership.';
    }
  } catch (err) {
    reason = `Could not read your roles on the instance (${err.message}) — held for an admin to review.`;
  }

  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `INSERT INTO members (org_id, instance_id, sn_user_sys_id, user_name, name, role, status, pending_reason, approved_by, approved_at, last_seen_at)
     VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, 'member', $5, $6, $7, $8, now())
     RETURNING *`,
    [instance.id, sysId, user.user_name || null, user.name || null, status, reason,
      status === 'active' ? 'join policy: auto' : null, status === 'active' ? new Date() : null],
  ));
  return rows[0];
}

export async function getMember(ctx, memberId) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(`SELECT * FROM members WHERE id = $1`, [memberId]));
  return rows[0] || null;
}

export async function listMembers(ctx) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `SELECT id, instance_id, sn_user_sys_id, user_name, name, role, status, pending_reason, approved_by, approved_at, created_at, last_seen_at
       FROM members ORDER BY (status = 'pending') DESC, created_at`,
  ));
  return rows;
}

export async function countMembers(ctx) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(`SELECT count(*)::int AS n FROM members WHERE status = 'active'`));
  return rows[0].n;
}

/** Approve, block, or re-role a member. Owners are only changed by owners (route enforces). */
export async function setMember(ctx, memberId, { status, role, actor }) {
  const sets = [];
  const values = [memberId];
  if (status) {
    if (!['active', 'pending', 'blocked'].includes(status)) throw new Error('bad status');
    values.push(status);
    sets.push(`status = $${values.length}`);
    if (status === 'active') {
      values.push(actor || 'admin');
      sets.push(`approved_by = $${values.length}`, 'approved_at = now()', 'pending_reason = NULL');
    }
  }
  if (role) {
    if (!['owner', 'admin', 'member'].includes(role)) throw new Error('bad role');
    values.push(role);
    sets.push(`role = $${values.length}`);
  }
  if (!sets.length) return getMember(ctx, memberId);
  return withOrg(ctx.orgId, async (c) => {
    const { rows } = await c.query(`UPDATE members SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values);
    if (status === 'blocked') {
      // Revocation matrix (D8): a blocked member's sessions die on next presentation.
      await c.query(`UPDATE sessions SET revoke_on_present = true WHERE member_id = $1`, [memberId]);
      // And their MCP tokens with them (ADR 0014 D3).
      await c.query(`UPDATE mcp_tokens SET revoke_on_present = true WHERE member_id = $1`, [memberId]);
    }
    return rows[0] || null;
  });
}

// ---- self-hosted: tenancy always on, one org row (D11) ----

/**
 * A deployment configured the old way — SN_INSTANCE_URL / SN_CLIENT_ID /
 * SN_CLIENT_SECRET in .env — is the self-hosted shape: one org, one instance,
 * verified by the operator's configuration rather than a registry read-back
 * (the person holding the .env holds the secret already). Members auto-join;
 * external accounts still do not.
 */
export async function seedSelfHosted({ instanceUrl, clientId, clientSecret, name = 'Self-hosted' }) {
  const host = normalizeHost(instanceUrl);
  const existing = await system((c) => c.query(`SELECT ${ORG_PUBLIC_COLUMNS} FROM orgs WHERE edition = 'self-hosted' ORDER BY created_at LIMIT 1`));
  let org = existing.rows[0];
  if (!org) {
    const id = crypto.randomUUID();
    await system((c) => c.query(
      `INSERT INTO orgs (id, name, slug, edition, status, dek_wrapped, join_policy, plan, plan_status, verified_at)
       VALUES ($1, $2, 'self-hosted', 'self-hosted', 'active', $3, 'auto', 'self-hosted', 'active', now())`,
      [id, name, newWrappedDek(id)],
    ));
    org = await getOrg(id);
  }
  const ctx = contextFor(org);
  const secretEnc = ctx.encrypt('instances.client_secret', clientSecret || '');
  const instance = await withOrg(org.id, async (c) => {
    const found = await c.query(`SELECT ${INSTANCE_PUBLIC_COLUMNS} FROM instances WHERE host = $1`, [host]);
    let row = found.rows[0];
    if (row) {
      await c.query(`UPDATE instances SET client_id = $2, client_secret_enc = $3, status = 'verified', updated_at = now() WHERE id = $1`, [row.id, clientId, secretEnc]);
    } else {
      const ins = await c.query(
        `INSERT INTO instances (org_id, label, host, instance_id, client_id, client_secret_enc, status, verified_by_user_name, verified_at)
         VALUES (current_setting('app.org_id')::uuid, 'prod', $1, $2, $3, $4, 'verified', 'operator (.env)', now())
         RETURNING ${INSTANCE_PUBLIC_COLUMNS}`,
        [host, `env:${host}`, clientId, secretEnc],
      );
      row = ins.rows[0];
    }
    await c.query(
      `INSERT INTO instance_aliases (host, org_id, instance_id) VALUES ($1, current_setting('app.org_id')::uuid, $2)
       ON CONFLICT (host) DO UPDATE SET instance_id = EXCLUDED.instance_id WHERE instance_aliases.org_id = current_setting('app.org_id')::uuid`,
      [host, row.id],
    );
    await c.query(`UPDATE orgs SET anchor_instance_id = COALESCE(anchor_instance_id, $1) WHERE id = current_setting('app.org_id')::uuid`, [row.id]);
    return row;
  });
  return { org: await getOrg(org.id), instance };
}

// The mailing list (migration 003). Not tenant data: a visitor on the
// marketing site has no org, so this is written through the directory role,
// which is why it lives in this module (test/db-gates.test.js (e)).
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export async function joinWaitlist({ email, note, source, fromOrg }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(addr)) throw new Error('That does not look like an email address.');
  await system((c) => c.query(
    `INSERT INTO waitlist (email, note, source, from_org) VALUES ($1, $2, $3, $4)`,
    [addr, String(note || '').slice(0, 500) || null, String(source || '').slice(0, 80) || null, fromOrg || null],
  ));
}

/** An org admin marks an instance non-production (or back). Condition 2 of ADR 0011 D3. */
export async function setInstanceEnvironment(ctx, instanceId, nonProduction) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `UPDATE instances SET non_production = $2, updated_at = now() WHERE id = $1 RETURNING ${INSTANCE_PUBLIC_COLUMNS}`,
    [instanceId, nonProduction === true],
  ));
  if (!rows[0]) throw new Error('instance not found');
  return rows[0];
}
