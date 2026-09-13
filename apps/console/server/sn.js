import { prepareDynamicRecord, checkDynamicApproval } from './dynamic-records.js';
// ServiceNow REST client bound to one user's OAuth tokens.
// Every call runs as that user — ACLs, roles, and user criteria are enforced
// by the platform, never re-implemented here (ADR 0002).
//
// Platform stewardship (ADR 0008 D14): every call carries an identifying
// User-Agent and X-Kaddiya-* headers so the instance's own
// syslog_transaction shows exactly who is calling; concurrent calls per user
// are capped, because the Table API shares the instance's integration
// semaphore pool; and 429/Retry-After is honored rather than hammered.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_TABLES, TASK_TABLES, TASK_FIELDS, CHANGE_TYPES, CHANGE_FIELDS } from './actions.js';
import { fileURLToPath } from 'node:url';

const ME_DYNAMIC_FILTER = '90d1921e5f510100a9ad2572f2b477fe'; // OOB "Me" dynamic filter sys_id

const VERSION = (() => {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const USER_AGENT = `Kaddiya/${VERSION}`;

// The platform owner's veto comes before the CISO's: two in-flight calls per
// user is the documented ceiling in the approval kit's traffic profile.
const MAX_IN_FLIGHT_PER_USER = 2;
const MAX_RETRIES_ON_429 = 2;
const MAX_RETRY_WAIT_MS = 10_000;

const gates = new Map(); // concurrency key -> { active, queue: [resolve] }

/**
 * Bounded per-user concurrency over instance calls. A released slot is handed
 * straight to the next waiter without the count ever dropping, so the ceiling
 * holds even under contention — a caller arriving between a release and the
 * waiter waking cannot slip through as an extra.
 */
async function withSlot(key, fn) {
  const gate = gates.get(key) || { active: 0, queue: [] };
  gates.set(key, gate);
  if (gate.active >= MAX_IN_FLIGHT_PER_USER) {
    await new Promise((resolve) => gate.queue.push(resolve)); // slot handed over already counted
  } else {
    gate.active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = gate.queue.shift();
    if (next) {
      next();
    } else {
      gate.active -= 1;
      if (gate.active === 0) gates.delete(key);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Header values must be ASCII; a display name or org label may not be. */
function headerSafe(value) {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 128) || 'unknown';
}

/** Seconds, or an HTTP-date, per RFC 9110. Clamped so we never park a turn. */
function retryAfterMs(res, attempt) {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  }
  return Math.min(500 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}


/**
 * Egress allowlist, network-grade where the runtime allows (ADR 0008 D6):
 * every instance call is HTTPS, to exactly the host the verified instance
 * record names, and never follows a redirect — a 3xx from the instance is
 * an error, not a hop. Resolve-and-pin DNS is the documented residual.
 */
export function guardedFetch(cfg, url, init = {}) {
  const target = url instanceof URL ? url : new URL(String(url));
  const expected = new URL(cfg.instanceUrl);
  if (target.protocol !== 'https:') throw new Error(`refusing non-HTTPS instance call to ${target.host}`);
  if (target.host !== expected.host) throw new Error(`refusing instance call to ${target.host}: this session is bound to ${expected.host}`);
  return fetch(target, { ...init, redirect: 'manual' }).then((res) => {
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`ServiceNow answered ${res.status} (redirect) on ${target.pathname} — the console does not follow redirects. The instance may be hibernating or behind a login gateway.`);
    }
    return res;
  });
}

/**
 * Revoke at the issuer on logout (ADR 0008 D8 revocation matrix). The
 * endpoint marks the token expired and needs no authentication —
 * platform-security/authentication/t_RevokeOAuthToken.
 */
export async function revokeToken(cfg, token) {
  if (!token) return false;
  const url = new URL(`${cfg.instanceUrl}/oauth_revoke_token.do`);
  url.searchParams.set('token', token);
  const res = await guardedFetch(cfg, url, { method: 'GET', headers: { 'User-Agent': USER_AGENT } });
  return res.ok;
}

export async function exchangeCode(cfg, code, codeVerifier) {
  return tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${cfg.baseUrl}/auth/callback`,
    // PKCE (RFC 7636 / ADR 0008 D2). ServiceNow names the parameter
    // `code_verifier` on oauth_token.do — platform-security/authentication/
    // authorization-workflow.
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });
}

async function tokenRequest(cfg, params) {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...params,
  });
  const res = await guardedFetch(cfg, `${cfg.instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token endpoint returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 1800) * 1000,
  };
}

export class SnClient {
  /**
   * `identity` names who this client acts for: it keys the per-user
   * concurrency gate and rides along in the X-Kaddiya-User header so the
   * instance's transaction log can be read without our audit file.
   */
  constructor(cfg, tokens, onTokensRefreshed, identity = {}) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.onTokensRefreshed = onTokensRefreshed;
    this.org = identity.org || cfg.org || 'self-hosted';
    this.userKey = identity.userKey || 'anonymous';
  }

  /** Headers every instance call carries (ADR 0008 D14). */
  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.tokens.accessToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'X-Kaddiya-Org': headerSafe(this.org),
      'X-Kaddiya-User': headerSafe(this.userKey),
      ...extra,
    };
  }

  async refresh() {
    this.tokens = await tokenRequest(this.cfg, {
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
    });
    this.onTokensRefreshed?.(this.tokens);
  }

  /**
   * One door for every instance call: bounded concurrency, identifying
   * headers, a single token refresh on 401, and 429/Retry-After honored with
   * backoff. `build()` is called per attempt because the Authorization header
   * changes after a refresh.
   */
  async send(build) {
    return withSlot(`${this.cfg.instanceUrl}|${this.userKey}`, async () => {
      let refreshed = false;
      for (let attempt = 0; ; attempt++) {
        const res = await build();
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await this.refresh();
          continue;
        }
        if (res.status === 429 && attempt < MAX_RETRIES_ON_429) {
          await sleep(retryAfterMs(res, attempt));
          continue;
        }
        return res;
      }
    });
  }

  async get(pathname, params = {}) {
    const url = new URL(this.cfg.instanceUrl + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.send(() => guardedFetch(this.cfg, url, { headers: this.headers() }));
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail = safeErrorDetail(text);
      throw new Error(`ServiceNow ${res.status} on ${pathname}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  /** PATCH/POST with a JSON body, through the same door as `get`. */
  async write(method, url, body) {
    return this.send(() => guardedFetch(this.cfg, url, {
      method,
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }));
  }

  async whoami() {
    const data = await this.get('/api/now/table/sys_user', {
      sysparm_query: `sys_idDYNAMIC${ME_DYNAMIC_FILTER}`,
      sysparm_fields: 'sys_id,user_name,name,email,title,department',
      sysparm_display_value: 'true',
      sysparm_limit: 1,
    });
    return data.result?.[0] ?? null;
  }

  async queryTable({ table, query, fields, limit, order_by }) {
    const data = await this.get(`/api/now/table/${encodeURIComponent(table)}`, {
      sysparm_query: order_by ? `${query || ''}^ORDERBYDESC${order_by}` : query,
      sysparm_fields: fields,
      sysparm_limit: Math.min(Number(limit) || 15, 50),
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
    });
    return data.result ?? [];
  }

  async schema({ table }) {
    const [dict, obj] = await Promise.all([
      this.get('/api/now/table/sys_dictionary', {
        sysparm_query: `name=${table}^elementISNOTEMPTY`,
        sysparm_fields: 'element,column_label,internal_type,max_length,reference,mandatory,read_only',
        sysparm_display_value: 'true',
        sysparm_exclude_reference_link: 'true',
        sysparm_limit: 250,
      }),
      this.get('/api/now/table/sys_db_object', {
        sysparm_query: `name=${table}`,
        sysparm_fields: 'name,label,super_class,sys_scope',
        sysparm_display_value: 'true',
        sysparm_exclude_reference_link: 'true',
        sysparm_limit: 1,
      }),
    ]);
    return {
      table: obj.result?.[0] ?? { name: table },
      note: 'Fields defined directly on this table; inherited fields live on the parent (see super_class).',
      fields: dict.result ?? [],
    };
  }

  async aggregate({ table, group_by, query }) {
    const data = await this.get(`/api/now/stats/${encodeURIComponent(table)}`, {
      sysparm_query: query,
      sysparm_count: 'true',
      sysparm_group_by: group_by,
      sysparm_display_value: 'true',
    });
    return data.result ?? data;
  }

  /** Group sys_ids the signed-in user belongs to (drives "or my group" queries). */
  async myGroups() {
    if (this._groups) return this._groups;
    const me = await this.whoami();
    if (!me) return (this._groups = []);
    const data = await this.get('/api/now/table/sys_user_grmember', {
      sysparm_query: `user=${me.sys_id}`,
      sysparm_fields: 'group',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: 100,
    });
    this._groups = (data.result ?? []).map((r) => r.group?.value || r.group).filter(Boolean);
    return this._groups;
  }

  /**
   * The signed-in user's work queue. Defaults to `task`, the parent of incident,
   * sc_task, HR case etc., so one query spans every work type they own.
   */
  async myWork({ table = 'task', include_groups = true, only_active = true, limit = 15 }) {
    const me = await this.whoami();
    if (!me) throw new Error('Could not resolve the signed-in user.');
    const clauses = [`assigned_to=${me.sys_id}`];
    if (include_groups) {
      const groups = await this.myGroups();
      if (groups.length) clauses.push(`assignment_groupIN${groups.join(',')}`);
    }
    let query = clauses.join('^OR');
    if (only_active) query = `active=true^${query.includes('^OR') ? `(${query})` : query}`;

    const rows = await this.queryTable({
      table,
      query: `${query}^ORDERBYpriority^ORDERBYDESCsys_updated_on`,
      fields: 'sys_id,number,sys_class_name,short_description,priority,state,assigned_to,assignment_group,opened_by,sys_updated_on',
      limit,
    });
    return { assigned_to: me.name || me.user_name, group_count: (this._groups || []).length, records: rows };
  }

  /** Full detail for one record, including its journal (comments / work notes). */
  async getRecord({ table, sys_id, number }) {
    let rec;
    if (sys_id) {
      const data = await this.get(`/api/now/table/${encodeURIComponent(table)}/${sys_id}`, {
        sysparm_display_value: 'true',
        sysparm_exclude_reference_link: 'true',
      });
      rec = data.result;
    } else {
      const rows = await this.queryTable({ table, query: `number=${number}`, limit: 1 });
      rec = rows[0];
    }
    if (!rec) throw new Error(`No ${table} record found (you may not have access to it).`);

    const journal = await this.get('/api/now/table/sys_journal_field', {
      sysparm_query: `element_id=${rec.sys_id}^ORDERBYDESCsys_created_on`,
      sysparm_fields: 'element,value,sys_created_by,sys_created_on',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: 20,
    }).then((d) => d.result ?? []).catch(() => []);

    return { record: rec, journal };
  }

  /**
   * Prior resolved work that resembles some text — the "haven't we solved this
   * before?" lookup. Tries ServiceNow's text-search operator, falls back to a
   * keyword LIKE union when the table has no text index.
   */
  async similar({ table = 'incident', text, exclude_sys_id, limit = 8 }) {
    const fields =
      'sys_id,number,short_description,close_notes,close_code,resolved_at,sys_class_name,state';
    const closed = 'stateIN6,7^ORclose_notesISNOTEMPTY';
    const runQuery = async (q) =>
      this.queryTable({ table, query: q, fields, limit }).catch(() => []);

    let rows = await runQuery(`123TEXTQUERY321=${text}^${closed}`);
    let strategy = 'text index';

    if (!rows.length) {
      const words = String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
        .slice(0, 4);
      if (!words.length) return { strategy: 'none', note: 'No usable keywords in the text.', records: [] };
      const or = words.map((w) => `short_descriptionLIKE${w}`).join('^OR');
      rows = await runQuery(`${closed}^${or}`);
      strategy = `keywords: ${words.join(', ')}`;
    }

    if (exclude_sys_id) rows = rows.filter((r) => r.sys_id !== exclude_sys_id);
    return { strategy, records: rows };
  }

  /** Append to a journal field (comments = customer-visible, work_notes = internal). */
  async addJournalEntry({ table, sys_id, field, text }) {
    if (!['comments', 'work_notes'].includes(field)) {
      throw new Error(`Refusing to write to field "${field}" — only comments or work_notes.`);
    }
    const url = new URL(`${this.cfg.instanceUrl}/api/now/table/${encodeURIComponent(table)}/${sys_id}`);
    url.searchParams.set('sysparm_fields', 'sys_id,number');
    const res = await this.write('PATCH', url, { [field]: text });
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      // 403 here means the platform's own ACLs refused the write — as intended.
      throw new Error(`ServiceNow ${res.status} writing ${field}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()).result;
  }

  /**
   * The signed-in user as ServiceNow knows them, plus the roles and groups that
   * actually determine what this console can see on their behalf.
   */

  // ---- registration and join policy (ADR 0008 D2/D3) ----

  /**
   * The application registry record for a client id, read on the caller's
   * own token. System OAuth tables are admin-gated on the instance, so a
   * successful read is the proof of control D2 asks for. Field names per
   * platform-security/authentication/t_CreateEndpointforExternalClients
   * (Client ID, Redirect URL).
   */
  async readOAuthEntity(clientId) {
    const data = await this.get('/api/now/table/oauth_entity', {
      sysparm_query: `client_id=${clientId}`,
      sysparm_fields: 'sys_id,name,client_id,redirect_url,active,type',
      sysparm_limit: 1,
    });
    return data.result?.[0] ?? null;
  }

  /** One sys_properties value, or '' when absent or unreadable by this user. */
  async instanceProperty(name) {
    const data = await this.get('/api/now/table/sys_properties', {
      sysparm_query: `name=${name}`,
      sysparm_fields: 'value',
      sysparm_limit: 1,
    });
    return data.result?.[0]?.value || '';
  }

  /**
   * Role names the signed-in user carries, inherited included — the join
   * policy's door check. Throws when the read is denied, so the caller can
   * fail closed into the pending queue instead of assuming.
   */
  async myRoleNames() {
    const me = await this.whoami();
    if (!me?.sys_id) throw new Error('could not read own user record');
    const data = await this.get('/api/now/table/sys_user_has_role', {
      sysparm_query: `user=${me.sys_id}`,
      sysparm_fields: 'role',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: 500,
    });
    const names = (data.result ?? []).map((r) => (typeof r.role === 'object' ? r.role.display_value : r.role) || '');
    return [...new Set(names.filter(Boolean))];
  }

  async profile() {
    const me = await this.get('/api/now/table/sys_user', {
      sysparm_query: `sys_idDYNAMIC${ME_DYNAMIC_FILTER}`,
      sysparm_fields:
        'sys_id,user_name,name,first_name,last_name,email,title,department,location,manager,phone,time_zone,last_login_time',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: 1,
    }).then((d) => d.result?.[0] ?? null);

    if (!me) return { user: null, roles: [], groups: [] };

    const [roles, groups] = await Promise.all([
      this.get('/api/now/table/sys_user_has_role', {
        sysparm_query: `user=${me.sys_id}`,
        sysparm_fields: 'role,inherited',
        sysparm_display_value: 'true',
        sysparm_exclude_reference_link: 'true',
        sysparm_limit: 200,
      }).then((d) => d.result ?? []).catch(() => []),
      this.get('/api/now/table/sys_user_grmember', {
        sysparm_query: `user=${me.sys_id}`,
        sysparm_fields: 'group',
        sysparm_display_value: 'true',
        sysparm_exclude_reference_link: 'true',
        sysparm_limit: 100,
      }).then((d) => d.result ?? []).catch(() => []),
    ]);

    const roleName = (r) => (typeof r.role === 'object' ? r.role.display_value : r.role) || '';
    const direct = roles.filter((r) => String(r.inherited) !== 'true').map(roleName).filter(Boolean);
    const inherited = roles.filter((r) => String(r.inherited) === 'true').map(roleName).filter(Boolean);

    return {
      user: me,
      roles: { direct: [...new Set(direct)].sort(), inherited: [...new Set(inherited)].sort() },
      groups: [...new Set(groups.map((g) => (typeof g.group === 'object' ? g.group.display_value : g.group)).filter(Boolean))].sort(),
    };
  }

  // ---- developer surface: update sets + config artifacts ----

  async post(pathname, body) {
    const url = new URL(this.cfg.instanceUrl + pathname);
    const res = await this.write('POST', url, body);
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} on ${pathname}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()).result;
  }

  /** Set a user preference for the signed-in user (creating it if absent). */
  async setUserPreference(name, value) {
    const me = await this.whoami();
    const existing = await this.get('/api/now/table/sys_user_preference', {
      sysparm_query: `user=${me.sys_id}^name=${name}`,
      sysparm_fields: 'sys_id',
      sysparm_limit: 1,
    });
    const found = existing.result?.[0];
    if (found) {
      const url = new URL(`${this.cfg.instanceUrl}/api/now/table/sys_user_preference/${found.sys_id}`);
      const res = await this.write('PATCH', url, { value });
      if (!res.ok) throw new Error(`Could not update preference ${name} (${res.status})`);
      return { updated: true };
    }
    await this.post('/api/now/table/sys_user_preference', { user: me.sys_id, name, value, type: 'string' });
    return { created: true };
  }

  /** The update set new global-scope changes by this user are being captured into. */
  async currentUpdateSet() {
    const me = await this.whoami();
    const pref = await this.get('/api/now/table/sys_user_preference', {
      sysparm_query: `user=${me.sys_id}^name=sys_update_set`,
      sysparm_fields: 'value',
      sysparm_limit: 1,
    });
    const sysId = pref.result?.[0]?.value;
    if (!sysId) return { current: null, note: 'No update set selected — changes would land in the instance Default set.' };
    const set = await this.get(`/api/now/table/sys_update_set/${sysId}`, {
      sysparm_fields: 'sys_id,name,state,description,application',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
    }).catch(() => null);
    return { current: set?.result ?? { sys_id: sysId, name: '(unreadable)' } };
  }

  /** Create an update set and make it the user's current one. */
  async createUpdateSet({ name, description }) {
    const set = await this.post('/api/now/table/sys_update_set', {
      name,
      description: description || '',
      state: 'in progress',
    });
    await this.setUserPreference('sys_update_set', set.sys_id);
    // Keep artifact creation in the global application, which is what update
    // sets capture; scoped-app changes belong to the app, not a set.
    await this.setUserPreference('apps.current_app', 'global').catch(() => {});
    return { created: set, is_current: true };
  }

  /** The captured changes inside an update set — the proof that capture worked. */
  async updateSetContents({ sys_id, limit = 25 }) {
    let setId = sys_id;
    if (!setId) setId = (await this.currentUpdateSet()).current?.sys_id;
    if (!setId) return { note: 'No update set selected.', entries: [] };
    const data = await this.get('/api/now/table/sys_update_xml', {
      sysparm_query: `update_set=${setId}^ORDERBYDESCsys_created_on`,
      sysparm_fields: 'name,type,target_name,action,sys_created_on,sys_created_by',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: limit,
    });
    return { update_set: setId, entries: data.result ?? [] };
  }

  /** Create a config artifact. Table must be on the ARTIFACT_TABLES allow-list. */
  async createArtifact({ table, fields }) {
    if (!ARTIFACT_TABLES[table]) {
      throw new Error(
        `Refusing to create records on "${table}". Allowed: ${Object.keys(ARTIFACT_TABLES).join(', ')}`,
      );
    }
    const created = await this.post(`/api/now/table/${encodeURIComponent(table)}`, fields);
    return {
      table,
      kind: ARTIFACT_TABLES[table],
      sys_id: created.sys_id,
      name: created.name,
      sys_scope: created.sys_scope?.display_value || created.sys_scope?.value || created.sys_scope,
      link: `${this.cfg.instanceUrl}/${table}.do?sys_id=${created.sys_id}`,
    };
  }

  /**
   * Update allow-listed fields on one task record (ADR 0010, task.update).
   * The table and field allow-lists are enforced here as well as in the
   * endpoint and the tool schema; a 403 is the platform's ACLs refusing.
   */
  async updateRecord({ table, sys_id, fields }) {
    if (!TASK_TABLES.includes(table)) {
      throw new Error(`Refusing to update records on "${table}". Allowed: ${TASK_TABLES.join(', ')}`);
    }
    const names = Object.keys(fields || {});
    const bad = names.filter((f) => !TASK_FIELDS.includes(f));
    if (bad.length) {
      throw new Error(`Refusing to write field(s) ${bad.join(', ')} — only ${TASK_FIELDS.join(', ')}.`);
    }
    if (!names.length) throw new Error('Nothing to update.');
    const url = new URL(`${this.cfg.instanceUrl}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}`);
    url.searchParams.set('sysparm_fields', ['sys_id', 'number', ...names].join(','));
    url.searchParams.set('sysparm_display_value', 'true');
    url.searchParams.set('sysparm_exclude_reference_link', 'true');
    const res = await this.write('PATCH', url, fields);
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} updating ${table}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()).result;
  }

  /** Approve or reject one approval the signed-in user holds (ADR 0010, approval.decide). */
  async decideApproval({ sys_id, decision, comments }) {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error(`Refusing decision "${decision}" — only approved or rejected.`);
    }
    const url = new URL(`${this.cfg.instanceUrl}/api/now/table/sysapproval_approver/${encodeURIComponent(sys_id)}`);
    url.searchParams.set('sysparm_fields', 'sys_id,state,sysapproval,document_id,comments');
    url.searchParams.set('sysparm_display_value', 'true');
    url.searchParams.set('sysparm_exclude_reference_link', 'true');
    const body = { state: decision };
    if (comments) body.comments = String(comments);
    const res = await this.write('PATCH', url, body);
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} deciding approval${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()).result;
  }

  /** Update one existing configuration record on the allow-list (ADR 0010, config.update). */
  async updateArtifact({ table, sys_id, fields }) {
    if (!CONFIG_TABLES[table]) {
      throw new Error(`Refusing to update records on "${table}". Allowed: ${Object.keys(CONFIG_TABLES).join(', ')}`);
    }
    const names = Object.keys(fields || {}).filter((f) => !f.startsWith('sys_'));
    if (!names.length) throw new Error('Nothing to update.');
    const body = Object.fromEntries(names.map((f) => [f, fields[f]]));
    const url = new URL(`${this.cfg.instanceUrl}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}`);
    url.searchParams.set('sysparm_fields', ['sys_id', 'name', ...names].join(','));
    url.searchParams.set('sysparm_display_value', 'true');
    url.searchParams.set('sysparm_exclude_reference_link', 'true');
    const res = await this.write('PATCH', url, body);
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} updating ${table}${detail ? `: ${detail}` : ''}`);
    }
    const updated = (await res.json()).result;
    return { ...updated, table, kind: CONFIG_TABLES[table], link: `${this.cfg.instanceUrl}/${table}.do?sys_id=${sys_id}` };
  }

  /** Order one catalog item, quantity 1, as the signed-in user (ADR 0010, catalog.order). */
  async orderItem({ item_sys_id, variables, requested_for }) {
    const url = new URL(`${this.cfg.instanceUrl}/api/sn_sc/servicecatalog/items/${encodeURIComponent(item_sys_id)}/order_now`);
    const body = { sysparm_quantity: 1, variables: variables && typeof variables === 'object' ? variables : {} };
    if (requested_for) body.sysparm_requested_for = String(requested_for);
    const res = await this.write('POST', url, body);
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} ordering item${detail ? `: ${detail}` : ''}`);
    }
    const result = (await res.json()).result || {};
    return {
      request_number: result.request_number,
      request_id: result.request_id,
      link: result.request_id ? `${this.cfg.instanceUrl}/sc_request.do?sys_id=${result.request_id}` : undefined,
    };
  }

  /** Raise one change request through the Change Management API (ADR 0010, change.create). */
  async createChange({ type, template_sys_id, fields }) {
    if (!CHANGE_TYPES.includes(type)) throw new Error(`Refusing change type "${type}". Allowed: ${CHANGE_TYPES.join(', ')}`);
    const names = Object.keys(fields || {});
    const bad = names.filter((f) => !CHANGE_FIELDS.includes(f));
    if (bad.length) throw new Error(`Refusing to set field(s) ${bad.join(', ')} — only ${CHANGE_FIELDS.join(', ')}.`);
    if (type === 'standard' && !template_sys_id) throw new Error('A standard change needs a template.');
    const pathname = type === 'standard'
      ? `/api/sn_chg_rest/change/standard/${encodeURIComponent(template_sys_id)}`
      : `/api/sn_chg_rest/change/${type}`;
    const url = new URL(this.cfg.instanceUrl + pathname);
    const res = await this.write('POST', url, fields || {});
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} creating ${type} change${detail ? `: ${detail}` : ''}`);
    }
    // The Change API returns every field as { value, display_value }.
    const r = (await res.json()).result || {};
    const pick = (k) => r[k]?.display_value ?? r[k]?.value ?? r[k];
    return {
      sys_id: pick('sys_id'),
      number: pick('number'),
      state: pick('state'),
      type,
      link: pick('sys_id') ? `${this.cfg.instanceUrl}/change_request.do?sys_id=${pick('sys_id')}` : undefined,
    };
  }

  /** One schema-validated record, on the same user token as every other write. */
  async applyDynamicRecord(body, { actionsTiers, automatic = false } = {}) {
    const prepared = await prepareDynamicRecord(this, body, actionsTiers);
    checkDynamicApproval(prepared, body, automatic);
    const { table, operation, sys_id, fields } = prepared;
    const pathname = `/api/now/table/${table}${operation === 'update' ? `/${sys_id}` : ''}`;
    const url = new URL(this.cfg.instanceUrl + pathname);
    url.searchParams.set('sysparm_input_display_value', 'false');
    url.searchParams.set('sysparm_display_value', 'false');
    url.searchParams.set('sysparm_exclude_reference_link', 'true');
    url.searchParams.set('sysparm_fields', ['sys_id', ...Object.keys(fields)].join(','));
    const res = await this.write(operation === 'create' ? 'POST' : 'PATCH', url, fields);
    if (!res.ok) {
      const detail = safeErrorDetail(await res.text().catch(() => ''));
      throw new Error(`ServiceNow ${res.status} applying ${table}${detail ? `: ${detail}` : ''}`);
    }
    const record = (await res.json()).result;
    if (!record?.sys_id) throw new Error('ServiceNow returned no record id. Check the instance before retrying this proposal.');
    const stored = value => value && typeof value === 'object' ? value.value : value;
    const unconfirmed = Object.keys(fields).filter(name => {
      if (!Object.hasOwn(record, name)) return true;
      const actual = stored(record[name]);
      if (typeof fields[name] === 'boolean') return ![String(fields[name]), fields[name] ? '1' : '0'].includes(String(actual));
      return String(actual ?? '') !== String(fields[name]);
    });
    return {
      record: { ...record, table, link: `${this.cfg.instanceUrl}/${table}.do?sys_id=${encodeURIComponent(record.sys_id)}` },
      warnings: unconfirmed.length ? [`Record saved, but these values were not confirmed: ${unconfirmed.join(', ')}. Read the record before making further changes; do not repeat creation.`] : [],
    };
  }

  async listTables({ search, limit }) {
    const q = search
      ? `nameLIKE${search}^ORlabelLIKE${search}`
      : '';
    const data = await this.get('/api/now/table/sys_db_object', {
      sysparm_query: q,
      sysparm_fields: 'name,label,super_class,sys_scope',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: Math.min(Number(limit) || 20, 50),
    });
    return data.result ?? [];
  }
}

// The configuration allow-list lives in the catalog (ADR 0010 D1); this
// name is kept for the endpoint and the card.
export const ARTIFACT_TABLES = CONFIG_TABLES;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'not', 'can',
  'cannot', 'unable', 'issue', 'issues', 'problem', 'please', 'help', 'need', 'when',
  'user', 'users', 'error', 'their', 'there', 'been', 'about', 'into', 'after',
]);

function safeErrorDetail(text) {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.error?.detail || '';
  } catch {
    return '';
  }
}
