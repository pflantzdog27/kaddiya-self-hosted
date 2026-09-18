// Read-only MCP access to a member's ServiceNow instance (ADR 0014).
//
// An external MCP host presents a per-user bearer ("MCP token") and gets the
// console's read tools, running on that person's own ServiceNow OAuth token,
// audited like every other call. Nothing in server/actions.js is reachable
// from here: the surface is a frozen list of twelve read tools, and
// test/write-paths.test.js pins that list as a subset of READ_TOOLS with no
// sn_propose_* name in it and sn_note_save absent.
//
// Why read-only (ADR 0014 D1). Every write Kaddiya can make obeys the ADR
// 0009 D2 invariant: the agent renders a card, a human clicks it, a dedicated
// endpoint performs the write on the approving user's token, and the audit
// row says approved_by_user: true. That `true` is the click. An MCP host has
// no card and no click — a tools/call is the model deciding, and whatever
// "approve this tool call" prompt the host may show is not something Kaddiya
// can see, log, or hold anyone to. So the proposal tools stay out, and
// sn_note_save with them (it lands pending behind a keep/discard card that
// nobody would ever see, ADR 0008 D5).
//
// This module never reaches the database directly. The one directory read is
// sessions.lookupMcpToken(); everything after tenant resolution goes through
// tenancy, which uses withOrg — test/db-gates.test.js (e) checks that the
// directory role appears in no module but the ones it names, and this is not
// one of them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, Server, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { toolDefinitions, executeTool } from './agent.js';
import { SnClient, revokeToken } from './sn.js';
import * as sessions from './sessions.js';
import * as tenancy from './tenancy.js';
import { audit } from './audit.js';

const VERSION = (() => {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Read-only MCP surface (ADR 0014 D1). A frozen list, not "everything that is
// not a proposal": a new read tool in agent.js is exposed here only after
// someone adds it, and write-paths.test.js pins this list ⊆ READ_TOOLS.
export const MCP_TOOLS = Object.freeze([
  'sn_query', 'sn_schema', 'sn_aggregate', 'sn_my_work', 'sn_record', 'sn_similar',
  'sn_list_tables', 'sn_update_set', 'sn_update_set_contents', 'sn_package_update_set',
  'sn_docs_search', 'sn_docs_get',
]);

/** For hosts that show tools to people rather than only to models. */
export const MCP_TITLES = Object.freeze({
  sn_query: 'Query records',
  sn_schema: 'Table schema',
  sn_aggregate: 'Count records',
  sn_my_work: 'My work queue',
  sn_record: 'Record detail',
  sn_similar: 'Similar resolved records',
  sn_list_tables: 'Find tables',
  sn_update_set: 'Current update set',
  sn_update_set_contents: 'Update set contents',
  sn_package_update_set: 'Package an update set',
  sn_docs_search: 'Search ServiceNow docs',
  sn_docs_get: 'Read a docs topic',
});

// Five console descriptions describe console furniture — a side panel, a card,
// a download button — none of which exists on this surface. Only these five
// are overridden; every other description is the console's, verbatim, so a
// reviewer comparing the two surfaces compares the same words.
export const MCP_DESCRIPTIONS = Object.freeze({
  sn_record:
    'Full detail for one record plus its journal (comments and work notes), by sys_id or by number. Use this when the user focuses on a specific case. The result carries a `link` to the record on the instance.',
  sn_update_set:
    "Read the signed-in user's current update set — the set new global-scope configuration changes are captured into. Read it before making configuration changes elsewhere so you know where they will land.",
  sn_update_set_contents:
    'List the captured changes (sys_update_xml entries) inside an update set — the proof of what a set contains.',
  // The console puts the two files behind buttons; here the result names URLs
  // instead, and this is the only tool whose deliverable is not in its result.
  sn_package_update_set:
    'Package an update set as the two files a person can hand over: the loadable ServiceNow XML and a markdown ledger of what is in it. THIS READS ONLY — it calls the Table API for the set and its captured changes and writes nothing. The changes must already be captured in the set; packaging never creates them. Use it when the work is done and the user wants to promote it to another instance, attach it to a change request, or hand it to a client. The result carries the manifest and the ledger, never the XML itself — it is far too large for a tool result, and half a package is worse than none. Instead `download.xml` and `download.ledger` are absolute URLs, fetched with the SAME bearer token as this connection (`Authorization: Bearer …`); save the XML as a file rather than reading it into the conversation. Refuses the Default set, an empty set, and a set too large for one file, and warns when the set is still in progress or part of a batch.',
  sn_docs_search:
    "Full-text search of the official ServiceNow documentation pinned to THIS instance's release family. Use it for platform behaviour, API and syntax questions, so the answer matches the release actually running — not memory of another version. Returns matching topics; read one with sn_docs_get and cite its path or url in your answer.",
});

/** One tool result is one bounded read; past this the host's model is drowning, not reading. */
export const MCP_MAX_RESULT_CHARS = 100_000;
/** ADR 0014 D8: the bounds above sn.js's two-in-flight-per-user gate. */
export const MCP_CALLS_PER_MINUTE = 60;
export const MCP_MAX_IN_FLIGHT_PER_TOKEN = 8;
/** Refresh before the first call of a burst rather than racing through send()'s per-call 401. */
const REFRESH_MARGIN_MS = 60_000;

const JSONRPC_INVALID_PARAMS = -32602;

// ---- the tool list ----

/**
 * The twelve, in MCP_TOOLS order, with the console's own input schemas passed
 * through verbatim (write-paths.test.js asserts deep equality) and a
 * readOnlyHint on every one.
 */
export function listTools() {
  const byName = new Map(toolDefinitions().map((t) => [t.name, t]));
  return MCP_TOOLS.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`MCP_TOOLS names ${name}, which agent.js does not define`);
    return {
      name,
      title: MCP_TITLES[name],
      description: MCP_DESCRIPTIONS[name] ?? tool.description,
      inputSchema: tool.input_schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    };
  });
}

export function instructionsFor(host, userName) {
  return `Kaddiya is read-only over MCP. Every tool runs on ${host} as ${userName || 'the token owner'}; `
    + "ServiceNow's own access controls decide what is visible, and nothing here can change the instance. "
    + 'To change a record, propose it in the Kaddiya console, where a person approves it.';
}

// ---- per-token bounds (ADR 0014 D8) ----
//
// Above sn.js's per-user gate, which MCP shares with the browser because the
// gate key is the same. These are per process: N replicas have N× them, which
// is already true of the gate and is stated in docs/kit/06.

const buckets = new Map(); // token hash hex -> { tokens, refilledAt, inFlight }

const limits = {
  /** null when the call may proceed, or the sentence the host's model should read. */
  take(key) {
    const now = Date.now();
    const bucket = buckets.get(key) || { tokens: MCP_CALLS_PER_MINUTE, refilledAt: now, inFlight: 0 };
    buckets.set(key, bucket);
    // Rolling, not a fixed window: one call's worth of allowance returns per second.
    const refill = ((now - bucket.refilledAt) / 60_000) * MCP_CALLS_PER_MINUTE;
    if (refill > 0) {
      bucket.tokens = Math.min(MCP_CALLS_PER_MINUTE, bucket.tokens + refill);
      bucket.refilledAt = now;
    }
    if (bucket.inFlight >= MCP_MAX_IN_FLIGHT_PER_TOKEN) {
      return `Kaddiya allows ${MCP_MAX_IN_FLIGHT_PER_TOKEN} calls in flight per token; wait for one to finish and retry.`;
    }
    if (bucket.tokens < 1) {
      return `Kaddiya allows ${MCP_CALLS_PER_MINUTE} calls a minute per token; wait and retry.`;
    }
    bucket.tokens -= 1;
    bucket.inFlight += 1;
    return null;
  },
  release(key) {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    if (bucket.inFlight === 0 && bucket.tokens >= MCP_CALLS_PER_MINUTE) buckets.delete(key);
  },
  /** Tests only, so one file's bursts do not spill into the next. */
  _reset() { buckets.clear(); },
};

export const _limits = limits;

// ---- calling a tool ----

function invalidParams(message) {
  const err = new Error(message);
  err.code = JSONRPC_INVALID_PARAMS;
  return err;
}

/**
 * A tool error, not a transport error: the host's model reads the sentence and
 * backs off or narrows, rather than the host failing the connection.
 */
function toolError(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

function shape(result) {
  let text = JSON.stringify(result ?? null);
  let truncated = false;
  if (text.length > MCP_MAX_RESULT_CHARS) {
    text = text.slice(0, MCP_MAX_RESULT_CHARS) + '"...] (truncated — narrow the query)';
    truncated = true;
  }
  const out = { content: [{ type: 'text', text }] };
  // structuredContent must parse as the text does; a truncated body no longer
  // does, and the protocol's structured slot is an object, never an array.
  if (!truncated && result && typeof result === 'object' && !Array.isArray(result)) out.structuredContent = result;
  return out;
}

/** The audit row's one-line "what came back", in the console's vocabulary. */
function summarize(name, result) {
  if (Array.isArray(result)) return `${result.length} record${result.length === 1 ? '' : 's'}`;
  if (name === 'sn_schema') return `${result?.fields?.length ?? 0} fields`;
  if (name === 'sn_my_work') return `${result?.records?.length ?? 0} on queue`;
  if (name === 'sn_similar') return `${result?.records?.length ?? 0} prior · ${result?.strategy}`;
  if (name === 'sn_record') return result?.record?.number || 'record';
  if (name === 'sn_update_set') return result?.current?.name || 'none selected';
  if (name === 'sn_update_set_contents') return `${result?.entries?.length ?? 0} captured change(s)`;
  if (name === 'sn_docs_search') return `${result?.results?.length ?? 0} topics · ${result?.family}`;
  if (name === 'sn_docs_get') return `${Math.max(1, Math.round((result?.chars || 0) / 1000))}k chars · ${result?.family}`;
  return 'ok';
}

function auditCall(principal, entry) {
  return audit(principal.scope, {
    user: principal.user?.user_name,
    action: 'mcp_tool_call',
    table: entry.input?.table,
    sys_id: entry.input?.sys_id,
    token_id: principal.tokenId,
    token_label: principal.label,
    ...entry,
  });
}

export async function callTool(principal, name, args, clientInfo) {
  // The allow-list first, before the limiter and before anything is audited:
  // an unknown name never reaches executeTool, and a proposal name is an
  // unknown name here (ADR 0014 D1).
  if (!MCP_TOOLS.includes(name)) throw invalidParams(`Unknown tool: ${name}`);
  const limited = limits.take(principal.tokenHashHex);
  if (limited) return toolError(limited);

  const input = args && typeof args === 'object' ? args : {};
  const started = Date.now();
  try {
    // readOnly is the second wall behind the allow-list: executeTool refuses
    // every sn_propose_* under it even if this list ever let one through.
    let result = await executeTool(principal.sn, name, input, () => {}, {
      cfg: principal.cfg,
      consoleUrl: principal.consoleUrl,
      user: principal.user,
      conversationId: null,
      scope: principal.scope,
    });
    // The console's `focus` emit opens the record in the right rail; there is
    // no rail here, so the address goes in the result instead.
    if (name === 'sn_record' && result?.record?.sys_id) {
      result = { ...result, link: `${principal.sn.cfg.instanceUrl}/${input.table}.do?sys_id=${result.record.sys_id}` };
    }
    await auditCall(principal, { tool: name, input, ms: Date.now() - started, summary: summarize(name, result), client: clientInfo?.name });
    return shape(result);
  } catch (err) {
    const message = String(err?.message || err);
    await auditCall(principal, { tool: name, input, ms: Date.now() - started, summary: 'error', error: true, client: clientInfo?.name });
    return toolError(message);
  } finally {
    limits.release(principal.tokenHashHex);
  }
}

// ---- the principal behind a bearer ----

const refreshLocks = new Map(); // token hash hex -> Promise

export class McpAuthError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const BEARER_CHALLENGE = { 'WWW-Authenticate': 'Bearer realm="kaddiya"' };

function bearerFrom(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(String(header));
  return match ? match[1] : null;
}

/**
 * Bearer → row → org → instance → member → client. Repeated on every request:
 * there is no cached principal, so a member blocked between two calls is
 * refused on the second.
 */
export async function resolvePrincipal(req, cfg) {
  const bearer = bearerFrom(req);
  if (!bearer) throw new McpAuthError(401, 'an MCP bearer token is required', BEARER_CHALLENGE);

  const row = await sessions.lookupMcpToken(bearer);
  if (!row) throw new McpAuthError(401, 'this MCP token is not valid', BEARER_CHALLENGE);

  const org = await tenancy.getOrg(row.orgId);

  if (row.revoked) {
    // Revoke-on-next-presentation (ADR 0014 D3): the pair exists nowhere else,
    // so this is the moment to expire it at the issuer too. Best effort, as
    // getSession() does for cookies — the ciphertext is already gone.
    try {
      const ctx = org ? tenancy.contextFor(org) : null;
      const instanceCfg = ctx ? await tenancy.instanceConfig(ctx, row.instanceId, cfg.baseUrl) : null;
      if (instanceCfg) {
        await Promise.allSettled([
          revokeToken(instanceCfg, row.tokens?.accessToken),
          revokeToken(instanceCfg, row.tokens?.refreshToken),
        ]);
      }
    } catch { /* deletion-only is still safe */ }
    throw new McpAuthError(401, 'this MCP token has been revoked', BEARER_CHALLENGE);
  }

  if (!org || org.status !== 'active') throw new McpAuthError(403, 'this workspace is not active');
  if (org.mcp_enabled !== true) throw new McpAuthError(403, 'MCP access is turned off for this workspace');
  const ctx = tenancy.contextFor(org);

  const [instance, member] = await Promise.all([
    tenancy.getInstance(ctx, row.instanceId),
    tenancy.getMember(ctx, row.memberId),
  ]);
  if (!instance || instance.status !== 'verified') throw new McpAuthError(403, 'this instance is not verified');
  if (!member || member.status !== 'active') throw new McpAuthError(403, 'membership is not active');

  const instanceCfg = await tenancy.instanceConfig(ctx, row.instanceId, cfg.baseUrl);
  if (!instanceCfg) throw new McpAuthError(403, 'this instance is no longer configured');

  const sn = new SnClient(
    instanceCfg,
    row.tokens,
    (tokens) => { row.saveTokens(tokens).catch((err) => console.error('mcp token save failed:', err.message)); },
    // The same userKey the browser uses, so withSlot() keys both surfaces
    // together and the documented two-in-flight ceiling holds across them.
    { org: org.slug || org.name, userKey: row.userSysId, surface: 'mcp' },
  );

  await proactiveRefresh(row, sn);

  return {
    tokenId: row.id,
    tokenHashHex: row.tokenHash.toString('hex'),
    label: row.label,
    // Where this console answers. A tool result that names a file has to name
    // it absolutely: an MCP host has no page it is "on".
    consoleUrl: cfg.baseUrl,
    user: row.user || { user_name: row.userSysId },
    org,
    ctx,
    instance,
    member,
    cfg: instanceCfg,
    sn,
    scope: {
      ctx,
      instanceId: instance.id,
      userSysId: row.userSysId,
      readOnly: true,
      actionsTiers: org.actions_tiers,
    },
  };
}

/**
 * Run `work` for the bearer on this request, under the same bounds a
 * tools/call gets (ADR 0014 D9).
 *
 * This exists because one deliverable on this surface is a file. A packaged
 * update set is hundreds of kilobytes to megabytes; a tool result caps at
 * MCP_MAX_RESULT_CHARS and truncates past it, and a truncated update set is
 * the one failure this feature must not have — it loads, it previews clean,
 * and it silently omits half the work. So the tool names a URL and the bytes
 * come from a GET, authenticated by the same bearer.
 *
 * It grants no data the token could not already read: `sn_query` can select
 * `payload` from `sys_update_xml` today, and a package is that data formatted.
 * What it adds is one more door, and the door has the same locks — the row
 * lookup, revoke-on-present, the org switch, the member check, the rate limit,
 * and an audit row naming the token.
 */
export async function withBearer(req, cfg, work) {
  const principal = await resolvePrincipal(req, cfg);
  const limited = limits.take(principal.tokenHashHex);
  if (limited) throw new McpAuthError(429, limited, { 'Retry-After': '5' });
  try {
    return await work(principal);
  } finally {
    limits.release(principal.tokenHashHex);
  }
}

/** An audit row for a bearer request; `action` in `entry` names what it was. */
export function auditBearer(principal, entry) {
  return auditCall(principal, entry);
}

/**
 * A host that fires eight calls at once would otherwise send eight requests
 * carrying the same nearly-expired access token and refresh through send()'s
 * per-call 401 path several times over. One lock per token: the first request
 * refreshes and re-seals, the rest wait and take the pair it produced.
 */
async function proactiveRefresh(row, sn) {
  const expiresAt = Number(row.tokens?.expiresAt) || 0;
  if (!row.tokens?.refreshToken || expiresAt - Date.now() >= REFRESH_MARGIN_MS) return;
  const key = row.tokenHash.toString('hex');
  let lock = refreshLocks.get(key);
  if (!lock) {
    // refresh() re-seals through onTokensRefreshed → row.saveTokens.
    lock = sn.refresh().then(() => sn.tokens).finally(() => refreshLocks.delete(key));
    refreshLocks.set(key, lock);
  }
  // A failed refresh is not fatal: the call proceeds on the old access token
  // and the instance's own 401 is the authority, as on the browser surface.
  const fresh = await lock.catch(() => null);
  // A waiter holds its own row and its own client, neither of which saw the
  // winner's re-seal — hand it the pair the winner produced.
  if (fresh) sn.tokens = fresh;
}

// ---- the Express handler ----

/**
 * Streamable HTTP at POST /mcp, stateless, JSON responses, both protocol eras
 * served by the pinned SDK (ADR 0014 D4). The SDK owns the protocol plumbing —
 * two handshakes, header/body mirroring, version negotiation, server/discover —
 * none of which carries security content of ours. What is ours is above it:
 * the Origin check, the bearer, the tenant resolution, the allow-list, the
 * bounds and the audit row.
 */
export function handler(cfg) {
  const expectedOrigin = new URL(cfg.baseUrl).origin;

  return async function mcpRequest(req, res) {
    // The 2026-07-28 spec requires this. Non-browser hosts send no Origin at
    // all; /mcp never reads cookies, so a cross-site browser POST carries no
    // credential either way and this is belt on top of braces.
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin) {
      return json(res, 403, { error: 'cross-origin request refused' });
    }

    let principal;
    try {
      principal = await resolvePrincipal(req, cfg);
    } catch (err) {
      if (err instanceof McpAuthError) return json(res, err.status, { error: err.message }, err.headers);
      console.error('mcp principal failed:', err.message);
      return json(res, 500, { error: 'could not resolve this token' });
    }

    const mcpHandler = createMcpHandler(() => buildServer(principal), {
      responseMode: 'json',
      legacy: 'stateless',
      onerror: (err) => { if (process.env.KADDIYA_MCP_DEBUG) console.error('mcp:', err.message); },
    });
    try {
      // Mounted before express.json(), so the raw stream is still unread and
      // the adapter reads the body itself. Express passes `next` third; the
      // adapter ignores a function there rather than treating it as a body.
      await toNodeHandler(mcpHandler)(req, res);
    } finally {
      await mcpHandler.close().catch(() => {});
    }
  };
}

function buildServer(principal) {
  const host = principal.instance.host;
  const server = new Server(
    {
      name: 'kaddiya',
      version: VERSION,
      // Two connected instances are two servers to a person reading a host's
      // list; the title is how they tell them apart. The tool names do not
      // change — namespacing is the host's job and it does it.
      title: `Kaddiya · ${host}`,
    },
    {
      capabilities: { tools: {} },
      instructions: instructionsFor(host, principal.user?.user_name),
      cacheHints: {
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
        'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: listTools() }));
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const params = request.params || {};
    return callTool(principal, params.name, params.arguments, clientInfoFrom(server, ctx));
  });

  return server;
}

/**
 * Which host is calling, for the audit row. A 2026-07-28 client declares it on
 * every request, in the envelope. A 2025-era client declares it once, on the
 * `initialize` handshake — and stateless serving builds a fresh instance per
 * request, so by the time it calls a tool the name is gone. The field is
 * therefore absent for legacy clients rather than guessed at; the token label
 * is the identifier that is always there.
 */
function clientInfoFrom(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  return envelope?.[CLIENT_INFO_META_KEY] || server.getClientVersion() || undefined;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
