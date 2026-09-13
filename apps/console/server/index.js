import './env.js'; // must stay first — populates process.env before other modules load
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SnClient, exchangeCode, revokeToken, ARTIFACT_TABLES } from './sn.js';
import { TASK_TABLES, TASK_FIELDS, CHANGE_TYPES, CHANGE_FIELDS, actionById, enabledActions } from './actions.js';
import { keepNote, discardNote } from './notebook.js';
import { runAgentTurn, smokeTestModel } from './agent.js';
import { modelInfo, resolveEffort } from './models.js';
import { warmDocs, defaultFamily } from './docs.js';
import { migrate, close as closeDatabase, localStorage } from './db.js';
import * as store from './store.js';
import * as tenancy from './tenancy.js';
import * as sessions from './sessions.js';
import * as billing from './billing.js';
import { audit, listAudit } from './audit.js';
import { commit, CommitError } from './commits.js';
import * as runs from './runs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const cfg = {
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  port: Number(process.env.PORT || 3000),
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  effort: process.env.ANTHROPIC_EFFORT || '',
  // Legacy operator seed. New installs register through the browser guide.
  selfHosted: process.env.SN_INSTANCE_URL
    ? {
      instanceUrl: process.env.SN_INSTANCE_URL.replace(/\/+$/, ''),
      clientId: process.env.SN_CLIENT_ID || '',
      clientSecret: process.env.SN_CLIENT_SECRET || '',
      name: process.env.KADDIYA_ORG || 'Self-hosted',
    }
    : null,
};
cfg.mode = 'self-hosted';
cfg.callbackUrl = `${cfg.baseUrl}/auth/callback`;

if (cfg.selfHosted && !cfg.selfHosted.clientId) {
  console.error('SN_INSTANCE_URL is set but SN_CLIENT_ID is not. Set both, or neither for the multi-tenant shape.');
  process.exit(1);
}
if (cfg.selfHosted && !cfg.selfHosted.clientSecret) {
  console.warn('⚠️  SN_CLIENT_SECRET is empty — the login page will render, but the OAuth callback will fail until you set it.');
}
if (cfg.selfHosted && cfg.selfHosted.clientSecret && cfg.selfHosted.clientSecret.length < 16) {
  console.warn(`⚠️  SN_CLIENT_SECRET is only ${cfg.selfHosted.clientSecret.length} characters — suspiciously short. If your .env value is unquoted, wrap it in single quotes and restart.`);
}

// `__Host-` requires Secure + Path=/ + no Domain, so it only exists over
// HTTPS; a plain-http dev origin falls back to the bare name and says so at
// boot. Production is HTTPS and gets the prefixed cookie (ADR 0008 D8).
const SECURE_COOKIES = cfg.baseUrl.startsWith('https://');
const SID_COOKIE = SECURE_COOKIES ? '__Host-sid' : 'sid';
const OAUTH_COOKIE = SECURE_COOKIES ? '__Host-kd_oauth' : 'kd_oauth';
const DRAFT_COOKIE = SECURE_COOKIES ? '__Host-kd_draft' : 'kd_draft';
const DRAFT_COOKIE_TTL_S = 14 * 24 * 60 * 60;

if (!SECURE_COOKIES) {
  console.warn(`⚠️  BASE_URL is ${cfg.baseUrl} — session cookies cannot be Secure or \`__Host-\` prefixed over plain HTTP. Fine for local development; serve the console over HTTPS anywhere else (ADR 0008 D8).`);
}

function cookieAttrs(maxAge) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(SECURE_COOKIES ? ['Secure'] : []),
    ...(maxAge != null ? [`Max-Age=${maxAge}`] : []),
  ].join('; ');
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('base64url');

function readCookie(req, name) {
  return (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

// ---- boot: migrations, then the self-hosted seed ----

try { await migrate(); }
catch (err) {
  console.error(`Could not open the workspace: ${err.message}`);
  await closeDatabase().catch(() => {});
  process.exit(1);
}
if (cfg.selfHosted) await tenancy.seedSelfHosted(cfg.selfHosted);
const setupRequiredAtBoot = !(await tenancy.selfHostedDeployment());

setInterval(() => sessions.purgeExpired().catch(() => {}), 60_000).unref();

const app = express();

app.use(express.json({ limit: '1mb' }));  // attachments on /api/chat ride in the body (capped there)

// Strict CSP + the usual hardening (ADR 0008 D8). No inline script or style
// anywhere in public/ — that is what makes `'self'` sufficient, and it is
// enforced by keeping every script and stylesheet in its own file. Google
// Fonts is the one external origin the design system needs.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (SECURE_COOKIES) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CSRF (ADR 0008 D8): every state-changing API call must come from this
// origin. Browsers send Origin on cross-site POSTs, so a foreign page cannot
// drive a signed-in browser; SameSite=Lax on the cookie is the second layer.
const ORIGIN = new URL(cfg.baseUrl).origin;
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/') && req.path !== '/auth/logout') return next();
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) {
    return res.status(403).json({ error: 'cross-origin request refused' });
  }
  if (!origin && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    return res.status(403).json({ error: 'cross-site request refused' });
  }
  next();
});

// ---- session resolution ----

/**
 * The cookie names a session row; the row names the org, the instance and
 * the member. Everything downstream derives its tenant from here and from
 * nothing the client sends (ADR 0008 D6).
 */
async function getSession(req) {
  const sid = readCookie(req, SID_COOKIE);
  if (!sid) return undefined;
  const session = await sessions.lookupSession(sid);
  if (!session) return undefined;

  const org = await tenancy.getOrg(session.orgId);
  if (!org || org.status !== 'active') return undefined;
  const ctx = tenancy.contextFor(org);

  if (session.revoked) {
    // Revoke-on-next-presentation (D8): the tokens exist nowhere else, so
    // this is the moment to expire them at the issuer too.
    try {
      const instanceCfg = await tenancy.instanceConfig(ctx, session.instanceId, cfg.baseUrl);
      if (instanceCfg) await revokeToken(instanceCfg, session.tokens?.accessToken);
    } catch { /* deletion-only is still safe: the ciphertext is gone */ }
    return undefined;
  }

  const [instance, member] = await Promise.all([
    tenancy.getInstance(ctx, session.instanceId),
    session.memberId ? tenancy.getMember(ctx, session.memberId) : null,
  ]);
  if (!instance || instance.status !== 'verified') return undefined;

  return {
    ...session,
    org,
    ctx,
    instance,
    member,
    scope: { ctx, instanceId: instance.id, userSysId: session.userSysId },
  };
}

async function requireSession(req, res) {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return null;
  }
  return session;
}

/** A signed-in *active* member. Pending and blocked members see 403 with their status. */
async function requireActive(req, res) {
  const session = await requireSession(req, res);
  if (!session) return null;
  if (session.member?.status !== 'active') {
    res.status(403).json({ error: 'membership is not active', status: session.member?.status || 'none', reason: session.member?.pending_reason || null });
    return null;
  }
  return session;
}

function isAdmin(session) {
  return ['owner', 'admin'].includes(session?.member?.role);
}

async function requireAdmin(req, res) {
  const session = await requireActive(req, res);
  if (!session) return null;
  if (!isAdmin(session)) {
    res.status(403).json({ error: 'org admins only' });
    return null;
  }
  return session;
}

async function snFor(session) {
  if (!session._instanceCfg) {
    session._instanceCfg = await tenancy.instanceConfig(session.ctx, session.instanceId, cfg.baseUrl);
  }
  return new SnClient(
    session._instanceCfg,
    session.tokens,
    (tokens) => { session.saveTokens(tokens).catch((err) => console.error('token save failed:', err.message)); },
    { org: session.org.slug || session.org.name, userKey: session.userSysId || session.user?.sys_id || 'pre-auth' },
  );
}

// ---- auth ----

/**
 * PKCE (RFC 7636, S256) on the authorization-code flow, plus a state that is
 * bound to THIS browser: the callback only completes for the browser that
 * started it, so a pasted or emailed callback URL cannot land a session on
 * someone else's console (ADR 0008 D2 — this closes login-CSRF too).
 */
async function beginOAuth(res, { org, ctx, instanceId, purpose }) {
  const instanceCfg = await tenancy.instanceConfig(ctx, instanceId, cfg.baseUrl);
  if (!instanceCfg) throw new Error('unknown instance');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const binding = crypto.randomBytes(32).toString('base64url');
  const state = await sessions.createOAuthState({ orgId: org.id, instanceId, purpose, verifier, binding: sha256(binding) });

  const url = new URL(`${instanceCfg.instanceUrl}/oauth_auth.do`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', instanceCfg.clientId);
  url.searchParams.set('redirect_uri', cfg.callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', sha256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  res.setHeader('Set-Cookie', `${OAUTH_COOKIE}=${binding}; ${cookieAttrs(sessions.OAUTH_STATE_TTL_MS / 1000)}`);
  res.redirect(url.toString());
}

function loginRedirect(res, message) {
  const url = new URL('/signin', cfg.baseUrl);
  if (message) url.searchParams.set('notice', message);
  res.redirect(url.pathname + url.search);
}

app.get('/auth/login', async (req, res) => {
  try {
    const deployment = await tenancy.selfHostedDeployment();
    if (!deployment) return res.redirect('/start');
    const resolved = { ...deployment, ctx: tenancy.contextFor(deployment.org) };
    await beginOAuth(res, { org: resolved.org, ctx: resolved.ctx, instanceId: resolved.instance.id, purpose: 'signin' });
  } catch (err) {
    loginRedirect(res, err.message);
  }
});

/** Start the verification OAuth for a draft instance: from the setup wizard (draft cookie) or from an admin session. */
app.get('/auth/verify', async (req, res) => {
  const instanceId = String(req.query.instance || '');
  try {
    let org = await tenancy.orgForDraft(readCookie(req, DRAFT_COOKIE));
    if (!org) {
      const session = await getSession(req);
      if (session && isAdmin(session)) org = session.org;
    }
    if (!org) return res.redirect('/start?error=' + encodeURIComponent('That setup has expired or belongs to another browser. Start again.'));
    const ctx = tenancy.contextFor(org);
    const instance = await tenancy.getInstance(ctx, instanceId);
    if (!instance || instance.status === 'disconnected') return res.redirect('/start?error=' + encodeURIComponent('Unknown instance.'));
    await beginOAuth(res, { org, ctx, instanceId: instance.id, purpose: 'verify' });
  } catch (err) {
    res.redirect('/start?error=' + encodeURIComponent(err.message));
  }
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clearBinding = `${OAUTH_COOKIE}=; ${cookieAttrs(0)}`;
  if (error) {
    res.setHeader('Set-Cookie', clearBinding);
    return res.status(400).send(`ServiceNow returned an error: ${String(error)}`);
  }

  const pending = await sessions.consumeOAuthState(state ? String(state) : '');
  const binding = readCookie(req, OAUTH_COOKIE);
  // Exact redirect: the URI sent to the token endpoint is the configured one,
  // never anything derived from this request's Host header.
  if (!code || !pending || !binding || sha256(binding) !== pending.binding) {
    res.setHeader('Set-Cookie', clearBinding);
    return res.status(400).send('Invalid or foreign OAuth callback. Start again from the login page.');
  }

  try {
    const org = await tenancy.getOrg(pending.org_id);
    if (!org) throw new Error('the org this sign-in started for no longer exists');
    const ctx = tenancy.contextFor(org);
    const instanceCfg = await tenancy.instanceConfig(ctx, pending.instance_id, cfg.baseUrl);
    if (!instanceCfg) throw new Error('the instance this sign-in started for no longer exists');

    const tokens = await exchangeCode(instanceCfg, String(code), pending.verifier);
    const holder = { tokens };
    const sn = new SnClient(instanceCfg, tokens, (t) => { holder.tokens = t; }, { org: org.slug || org.name, userKey: 'pre-auth' });
    const user = await sn.whoami();
    if (!user?.sys_id) throw new Error('signed in, but could not read your own user record — the instance denied the read');

    let member;
    let next = '/';
    if (pending.purpose === 'verify') {
      await tenancy.verifyInstance(ctx, pending.instance_id, { sn, user, expectedRedirect: cfg.callbackUrl });
      const fresh = await tenancy.getOrg(org.id);
      member = await tenancy.signinMember(tenancy.contextFor(fresh), { org: fresh, instance: { id: pending.instance_id }, user, sn });
      next = '/admin?setup=1';
    } else {
      if (org.status !== 'active') throw new Error('this org is not active');
      member = await tenancy.signinMember(ctx, { org, instance: { id: pending.instance_id }, user, sn });
    }

    const ttl = tenancy.sessionTtlFor(org);
    const sid = await sessions.createSession({
      orgId: org.id,
      instanceId: pending.instance_id,
      memberId: member.id,
      userSysId: user.sys_id,
      user,
      tokens: holder.tokens,
      ttlMs: ttl,
    });
    res.setHeader('Set-Cookie', [
      clearBinding,
      `${SID_COOKIE}=${sid}; ${cookieAttrs(ttl / 1000)}`,
      ...(pending.purpose === 'verify' ? [`${DRAFT_COOKIE}=; ${cookieAttrs(0)}`] : []),
    ]);
    res.redirect(next);
  } catch (err) {
    console.error('OAuth callback failed:', err.message);
    res.setHeader('Set-Cookie', clearBinding);
    if (pending.purpose === 'verify') {
      return res.redirect('/start?step=verify&error=' + encodeURIComponent(err.message));
    }
    res.status(502).send(`Could not complete sign-in: ${err.message}`);
  }
});

app.post('/auth/logout', async (req, res) => {
  const sid = readCookie(req, SID_COOKIE);
  res.setHeader('Set-Cookie', `${SID_COOKIE}=; ${cookieAttrs(0)}`);
  if (!sid) return res.json({ ok: true });
  try {
    // Logout path of the revocation matrix (D8): the cookie is present, so
    // the tokens can be decrypted and revoked at the issuer before deletion.
    const session = await getSession(req);
    const tokens = await sessions.destroySession(sid);
    if (session && tokens) {
      const instanceCfg = await tenancy.instanceConfig(session.ctx, session.instanceId, cfg.baseUrl);
      await Promise.allSettled([revokeToken(instanceCfg, tokens.accessToken), revokeToken(instanceCfg, tokens.refreshToken)]);
    }
  } catch (err) {
    console.error('logout revocation failed:', err.message);
  }
  res.json({ ok: true });
});

// ---- first-run setup: one workspace, one verified anchor instance ----

app.post('/api/org', async (req, res) => {
  try {
    const expected = process.env.KADDIYA_SETUP_TOKEN;
    const supplied = req.body?.setup_token;
    if (!expected || typeof supplied !== 'string' || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(expected).digest(),
      crypto.createHash('sha256').update(supplied).digest(),
    )) return res.status(403).json({ error: 'Enter the setup code printed by npm run setup. For a manual installation, use KADDIYA_SETUP_TOKEN.' });
    const { org, draftSecret } = await tenancy.createSelfHostedDraft({ name: req.body?.name });
    res.setHeader('Set-Cookie', `${DRAFT_COOKIE}=${draftSecret}; ${cookieAttrs(DRAFT_COOKIE_TTL_S)}`);
    res.json({ org: tenancy.publicOrg(org), instances: await tenancy.listInstances(tenancy.contextFor(org)), callback_url: cfg.callbackUrl });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.get('/api/org/draft', async (req, res) => {
  const org = await tenancy.orgForDraft(readCookie(req, DRAFT_COOKIE));
  if (!org) return res.status(404).json({ error: 'no draft in this browser' });
  const ctx = tenancy.contextFor(org);
  res.json({ org: tenancy.publicOrg(org), instances: await tenancy.listInstances(ctx), callback_url: cfg.callbackUrl });
});

app.post('/api/org/draft/instance', async (req, res) => {
  const org = await tenancy.orgForDraft(readCookie(req, DRAFT_COOKIE));
  if (!org) return res.status(404).json({ error: 'no draft in this browser' });
  const ctx = tenancy.contextFor(org);
  const { host, client_id, client_secret, label } = req.body || {};
  try {
    const existing = (await tenancy.listInstances(ctx)).find((i) => i.status === 'draft');
    const instance = existing
      ? await tenancy.updateInstanceCredentials(ctx, existing.id, { host, clientId: client_id, clientSecret: client_secret })
      : await tenancy.addInstanceDraft(ctx, { host, clientId: client_id, clientSecret: client_secret, label });
    res.json({ instance, verify_url: `/auth/verify?instance=${instance.id}` });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

// ---- api ----

// Public, unauthenticated: the login page needs to know which shape this is.
app.get('/api/config', async (req, res) => {
  const deployment = await tenancy.selfHostedDeployment();
  res.json({
    mode: 'self-hosted',
    instance_host: deployment?.instance.host || null,
    setup_required: !deployment,
    signup: false,
  });
});

async function meFor(session) {
  const gate = await billing.gateTurn(session.org, session.ctx, { orgModelKey: tenancy.orgModelKey, connectionKey: tenancy.modelConnectionKey });
  const info = modelInfo(gate.model.model);
  return {
    user: session.user,
    instance: `https://${session.instance.host}`,
    instance_label: session.instance.label,
    org: { id: session.org.id, name: session.org.name, edition: session.org.edition },
    member: { role: session.member?.role, status: session.member?.status },
    admin: isAdmin(session),
    model: info.label || gate.model.model,
    model_id: gate.model.model,
    model_kind: gate.model.kind,
    model_provider: gate.model.provider,
    model_provider_label: gate.model.label,
    // Per-turn choice (ADR 0009 D4): what /api/chat accepts as `model`, and
    // what a turn runs on when it names nothing.
    models: billing.availableModels(session.org),
    default_model: billing.availableModels(session.org)[0]?.id || gate.model.model,
    autonomous_available: session.org.autonomous_mode === true,
    instance_non_production: session.instance.non_production === true,
    effort: billing.availableModels(session.org)[0]?.default_effort || '',
    plan: gate.plan,
    usage: gate.usage,
    gate: gate.ok ? { ok: true } : { ok: false, reason: gate.reason, message: gate.message },
    session: { expires_at: session.expiresAt },
  };
}

app.get('/api/me', async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.member?.status !== 'active') {
    return res.status(403).json({
      error: 'membership is not active',
      status: session.member?.status || 'none',
      reason: session.member?.pending_reason || null,
      org: { name: session.org.name },
      user: session.user,
    });
  }
  try {
    res.json(await meFor(session));
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

app.get('/api/profile', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  try {
    const sn = await snFor(session);
    const profile = await sn.profile();
    const me = await meFor(session);
    res.json({
      ...profile,
      instance: me.instance,
      org: me.org,
      member: me.member,
      admin: me.admin,
      model: { id: me.model_id, label: me.model, effort: me.effort, provider: me.model_provider_label },
      // The ceiling is the honest number: the access token refreshes silently,
      // the session does not survive its absolute cap (ADR 0008 D8).
      session: {
        expires_at: session.expiresAt,
        token_expires_at: session.tokens.expiresAt,
      },
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

// ---- conversations ----

app.get('/api/conversations', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  res.json({ conversations: await store.listConversations(session.scope) });
});

app.post('/api/conversations', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const conv = await store.createConversation(session.scope);
  res.json({ id: conv.id, title: conv.title, pinned: false, updated: conv.updated });
});

app.get('/api/conversations/:id', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const conv = await store.getConversation(session.scope, req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json({ ...conv, run: conv.run ? runs.describe(conv.run) : null });
});

app.patch('/api/conversations/:id', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const conv = await store.updateConversation(session.scope, req.params.id, req.body || {});
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json({ id: conv.id, title: conv.title, pinned: conv.pinned, updated: conv.updated });
});

app.delete('/api/conversations/:id', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  res.json({ ok: await store.deleteConversation(session.scope, req.params.id) });
});

// One staged execution per signed-in person/instance prevents concurrent writes
// from racing each other (notably ServiceNow's current update set).
const activeStages = new Map();
const executionKey = session => `${session.orgId}:${session.instanceId}:${session.userSysId}`;

app.post('/api/chat', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  if (activeStages.has(executionKey(session))) return res.status(409).json({ error: 'Stop the active task before starting another message.' });
  let userText = String(req.body?.message || '').slice(0, 8000).trim();
  // Attachments (text files the person dropped on the composer) travel as
  // fenced blocks after the message, so the model reads them in place and
  // the stored conversation keeps them. Bounded: four files, 150 KB each.
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 4) : [];
  for (const a of attachments) {
    const name = String(a?.name || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    const text = String(a?.text || '').slice(0, 150_000);
    if (!text) continue;
    const fence = /```/.test(text) ? '````' : '```';
    userText += `\n\n---\nAttached file: ${name} (${text.length} chars)\n${fence}\n${text}\n${fence}`;
  }
  if (!userText) return res.status(400).json({ error: 'empty message' });

  // The turn may name a model, but only one of the configured connections.
  const requestedModel = req.body?.model ? String(req.body.model).slice(0, 160) : null;
  if (requestedModel && !billing.availableModels(session.org).some((m) => m.id === requestedModel)) {
    return res.status(400).json({ error: `${requestedModel} is not a model this org can run a turn on` });
  }

  const choice = billing.availableModels(session.org).find(m => m.id === requestedModel) || billing.availableModels(session.org)[0];
  try { resolveEffort(choice?.model_id, { kind: choice?.kind, requested: req.body?.effort }); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const conv = req.body?.conversation_id
    ? await store.getConversation(session.scope, req.body.conversation_id)
    : await store.createConversation(session.scope);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Tell the client which conversation this turn belongs to (it may be new).
  emit('conversation', { id: conv.id });

  // The plan gate runs before the model is called, never after (the meter is
  // the contract): a turn that would exceed the allowance is a paywall card.
  let gate;
  try {
    gate = await billing.gateTurn(session.org, session.ctx, { orgModelKey: tenancy.orgModelKey, connectionKey: tenancy.modelConnectionKey, modelId: requestedModel, effort: req.body?.effort });
  } catch (err) {
    emit('error', { message: `Could not check this org's plan: ${err.message}` });
    return res.end();
  }
  if (!gate.ok) {
    emit('paywall', { reason: gate.reason, message: gate.message, plan: gate.plan, usage: gate.usage, admin: isAdmin(session) });
    return res.end();
  }

  // Keep what we send the model bounded; the row keeps the whole history.
  const messages = conv.messages.slice(-40);
  const scope = { ...session.scope, actionsTiers: session.org.actions_tiers };

  let result;
  try {
    result = await runAgentTurn({
      cfg,
      sn: await snFor(session),
      user: session.user,
      messages,
      userText,
      emit,
      conversationId: conv.id,
      scope,
      model: gate.model,
      audit: (entry) => audit(session.scope, { user: session.user?.user_name, conversation: conv.id, ...entry }),
    });
  } catch (err) {
    console.error('Agent turn failed:', err);
    emit('error', { message: String(err?.message || err) });
  }

  try {
    conv.messages = messages;
    await store.saveConversation(session.scope, conv);
  } catch (err) {
    console.error('Could not save conversation:', err.message);
  }
  if (result) {
    billing.recordUsage(session.ctx, {
      instanceId: session.instance.id,
      userSysId: session.userSysId,
      conversationId: conv.id,
      model: result.model,
      provider: gate.model.provider,
      usage: result.usage,
      cost: result.cost,
    }).catch((err) => console.error('usage record failed:', err.message));
  }
  res.end();
});

// Refuses a click on an action this org has not enabled (ADR 0010 D2, per-org
// toggles per ADR 0008 D12). The tool is absent from the agent's list too, so
// this only fires on a stale card or a hand-made request.
function requireAction(session, id, res) {
  const action = actionById(id);
  if (!action) throw new Error(`unknown action ${id}`);
  if (!enabledActions(session.org.actions_tiers).includes(action)) {
    res.status(403).json({ error: `${action.label} (tier ${action.tier}) is not enabled for this org — an org admin can change that under Admin → Actions` });
    return false;
  }
  return true;
}

const auditFor = (session, entry) => audit(session.scope, { user: session.user?.user_name, ...entry });

// ---- the action catalog: every instance write lives here ----
//
// Every endpoint here is reachable only by a human clicking a button on a
// card that showed the exact payload; none of them is callable by the agent.
// Each runs on the approving user's own OAuth token, so ServiceNow's ACLs
// remain the authority (a 403 here is the platform refusing), and each is
// audited with approved_by_user. The invariant is ADR 0009 D2; the
// enumerability is the point — this list IS the security story.
//
// The commit itself lives in commits.js, shared with plan-approved runs
// (ADR 0011 D3); the endpoint owns the session, the org's action toggles and
// the HTTP shape. The paths are the catalog's `endpoint` field, so
// The public write list is intentionally kept small and explicit.
function commitRoute(actionId) {
  return async (req, res) => {
    const session = await requireActive(req, res);
    if (!session) return;
    if (!requireAction(session, actionId, res)) return;
    if (activeStages.has(executionKey(session))) return res.status(409).json({ error: 'Wait for the active task to finish or stop it before applying a manual change.' });
    try {
      const sn = await snFor(session);
      res.json(await commit(actionId, { sn, actionsTiers: session.org.actions_tiers, audit: (entry) => auditFor(session, entry) }, req.body || {}));
    } catch (err) {
      const status = err instanceof CommitError ? err.status : 502;
      res.status(status).json({ error: String(err.message) });
    }
  };
}
app.post('/api/dynamic/apply', commitRoute('dynamic.apply'));       // Create or Apply, on a schema-discovered record card
app.post('/api/record/comment', commitRoute('journal.append'));      // Send, on a draft reply
app.post('/api/artifact/create', commitRoute('config.create'));      // Create, on a proposed change
app.post('/api/update-set/create', commitRoute('update_set.create')); // Create, on a proposed update set
app.post('/api/record/update', commitRoute('task.update'));          // Apply, on a proposed record update
app.post('/api/approval/decide', commitRoute('approval.decide'));    // Approve or Reject, on a proposed decision
app.post('/api/artifact/update', commitRoute('config.update'));      // Apply, on a proposed change to an existing record
app.post('/api/catalog/order', commitRoute('catalog.order'));        // Order, on a proposed order
app.post('/api/change/create', commitRoute('change.create'));        // Create, on a proposed change request

// ---- runs (ADR 0011): longer work in stages, from a plan the person approved ----
//
// A run is a conversation carrying a `run` object. The browser asks for one
// stage at a time; each stage is a streamed agent turn like /api/chat, with
// the stage instruction as the user text. Plan-approved commits happen only
// inside the build stage, only when every condition in runs.planModeBlocked
// holds, through the same commit() the endpoints above call.

app.get('/api/runs/options', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  res.json({
    templates: Object.values(runs.TEMPLATES).map(({ id, label, hint }) => ({ id, label, hint })),
    policies: Object.values(runs.POLICIES),
    autonomous_available: session.org.autonomous_mode === true,
    plan_mode: {
      org_enabled: !!session.org.runs_plan_mode,
      instance_non_production: !!session.instance.non_production,
      available: !!session.org.runs_plan_mode && !!session.instance.non_production,
    },
  });
});

app.post('/api/runs', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const goal = String(req.body?.goal || '').trim();
  if (goal.length > 2000) return res.status(400).json({ error: 'Keep the task goal under 2,000 characters.' });
  if (req.body?.attachments?.length) return res.status(400).json({ error: 'Send attachments in a normal message first, then start a task in that conversation.' });
  if (goal.length < 8) return res.status(400).json({ error: 'Say what the run should achieve, in a sentence or two.' });
  const policy = ['plan', 'autonomous'].includes(req.body?.policy) ? req.body.policy : 'each';
  if (policy === 'autonomous' && (!session.org.autonomous_mode || req.body?.acknowledged !== true)) return res.status(403).json({ error: 'Autonomous mode needs admin enablement and your acknowledgment for this task.' });
  if (policy === 'plan' && !(session.org.runs_plan_mode && session.instance.non_production)) {
    return res.status(400).json({ error: 'Plan-approved runs are not available here: an org admin must turn them on, and the instance must be marked non-production.' });
  }
  if (activeStages.has(executionKey(session))) return res.status(409).json({ error: 'Another task is active on this instance.' });
  const model = req.body?.model || billing.availableModels(session.org)[0]?.id;
  if (model && !billing.availableModels(session.org).some(m => m.id === model)) return res.status(400).json({ error: 'Choose an available model.' });
  const choice = billing.availableModels(session.org).find(m => m.id === model);
  let effort;
  try { effort = resolveEffort(choice?.model_id, { kind: choice?.kind, requested: req.body?.effort, configured: choice?.default_effort }); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const conv = req.body?.conversation_id ? await store.getConversation(session.scope, req.body.conversation_id) : await store.createConversation(session.scope);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  if (conv.run?.status === 'active') return res.status(409).json({ error: 'Finish or stop the current task first.' });
  conv.run = runs.newRun({ goal, template: req.body?.template, policy });
  conv.run.model = model;
  conv.run.effort = effort;
  if (policy === 'autonomous') conv.run.authorization = { user: session.userSysId, session: session.sidHash.toString('hex'), instance: session.instanceId, at: new Date().toISOString() };
  await store.saveConversation(session.scope, conv);
  await auditFor(session, { action: 'run_start', conversation: conv.id, run: conv.run.id, template: conv.run.template, policy, approved_by_user: policy === 'autonomous', approval: policy === 'autonomous' ? `autonomous:${conv.run.id}` : undefined });
  res.json({ conversation_id: conv.id, run: runs.describe(conv.run) });
});

// The person's decision on the plan: approve (with an optional note for the
// builder) or send it back (the note becomes findings for a revision).
app.post('/api/runs/:id/plan', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const conv = await store.getConversation(session.scope, req.params.id);
  if (!conv?.run) return res.status(404).json({ error: 'run not found' });
  if (conv.run.stage !== 'approve') return res.status(409).json({ error: `the run is at ${conv.run.stage}, not waiting for approval` });
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  if (req.body?.approved === true) {
    conv.run.stage = 'build';
    conv.run.plan_approved_by = session.userSysId;
    conv.run.plan_approved_at = new Date().toISOString();
    conv.run.plan_note = note || null;
    await auditFor(session, { action: 'run_plan_approved', conversation: conv.id, run: conv.run.id, policy: conv.run.policy, approved_by_user: true });
  } else {
    conv.run.stage = 'spec';
    conv.run.findings = note ? `## Findings\n1. From the approver: ${note}` : conv.run.findings || '## Findings\n1. The approver sent the plan back without a note; make it tighter and more specific.';
    conv.run.revisions += 1;
    await auditFor(session, { action: 'run_plan_returned', conversation: conv.id, run: conv.run.id });
  }
  await store.saveConversation(session.scope, conv);
  res.json({ run: runs.describe(conv.run) });
});

app.post('/api/runs/:id/stop', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const conv = await store.getConversation(session.scope, req.params.id);
  if (!conv?.run) return res.status(404).json({ error: 'run not found' });
  const active = activeStages.get(executionKey(session));
  if (active?.conversationId === conv.id) {
    await auditFor(session, { action: 'run_stopped', conversation: conv.id, run: conv.run.id });
    active.stopped = true;
    active.controller.abort(new Error('Stopped by the user.'));
    // The running request owns the latest transcript and will save stopped state.
    return res.json({ run: runs.describe({ ...conv.run, status: 'stopped' }) });
  }
  conv.run.status = 'stopped';
  await store.saveConversation(session.scope, conv);
  await auditFor(session, { action: 'run_stopped', conversation: conv.id, run: conv.run.id });
  res.json({ run: runs.describe(conv.run) });
});

// Run the next stage. Streams like /api/chat and ends with a `run` event
// carrying the new state, so the browser knows what it may ask for next.
app.post('/api/runs/:id/stage', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const lockKey = executionKey(session);
  if (activeStages.has(lockKey)) return res.status(409).json({ error: 'A task is already running on this instance.' });
  const execution = { controller: new AbortController(), conversationId: req.params.id, stopped: false };
  activeStages.set(lockKey, execution);
  res.on('close', () => { if (!res.writableEnded) execution.controller.abort(new Error('The app disconnected.')); });
  try {

  const conv = await store.getConversation(session.scope, req.params.id);
  if (!conv?.run) return res.status(404).json({ error: 'run not found' });
  if (conv.run.policy === 'autonomous') {
    const blocked = runs.autonomousBlocked({ org: session.org, instance: session.instance, run: conv.run, userSysId: session.userSysId, sessionHash: session.sidHash.toString('hex') });
    if (blocked) return res.status(403).json({ error: blocked });
  }
  if (conv.run.status !== 'active') return res.status(409).json({ error: `this run is ${conv.run.status}` });

  let next;
  try {
    next = runs.nextStage(conv.run, { note: conv.run.plan_note });
  } catch (err) {
    return res.status(409).json({ error: String(err.message) });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const emit = (event, data) => !res.destroyed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('conversation', { id: conv.id });
  emit('run', { ...runs.describe(conv.run), running: next.stage });

  let gate;
  try {
    gate = await billing.gateTurn(session.org, session.ctx, { orgModelKey: tenancy.orgModelKey, connectionKey: tenancy.modelConnectionKey, modelId: conv.run.model, effort: conv.run.effort });
  } catch (err) {
    emit('error', { message: `Could not check this org's plan: ${err.message}` });
    return res.end();
  }
  if (!gate.ok) {
    emit('paywall', { reason: gate.reason, message: gate.message, plan: gate.plan, usage: gate.usage, admin: isAdmin(session) });
    return res.end();
  }

  if (conv.run.effort === '') gate.model.effort = '';

  const messages = conv.messages.slice(-60);
  const scope = { ...session.scope, actionsTiers: session.org.actions_tiers, readOnly: next.stage !== 'build' || conv.run.template === 'audit' };
  scope.checkActive = async () => {
    execution.controller.signal.throwIfAborted();
    const fresh = await getSession(req);
    if (!fresh || fresh.member?.status !== 'active') throw new Error('The signed-in session is no longer active.');
    if (conv.run.policy === 'autonomous') {
      const blocked = runs.autonomousBlocked({ org: fresh.org, instance: fresh.instance, run: conv.run, userSysId: fresh.userSysId, sessionHash: fresh.sidHash.toString('hex') });
      if (blocked) throw new Error(blocked);
    }
    scope.actionsTiers = fresh.org.actions_tiers;
    return fresh;
  };
  let systemExtra = next.systemExtra;

  // Plan mode: every condition checked here, at the moment of use (ADR 0011 D3).
  if (next.stage === 'build' && conv.run.policy === 'plan') {
    const blocked = runs.planModeBlocked({ org: session.org, instance: session.instance, run: conv.run, userSysId: session.userSysId });
    if (blocked) {
      emit('text', { delta: `_(This run cannot commit its plan: ${blocked}. Continuing with cards you approve one by one.)_\n\n` });
      conv.run.policy = 'each';
      next = runs.nextStage(conv.run, { note: conv.run.plan_note });
    } else {
      const sn = await snFor(session);
      const run = conv.run;
      systemExtra = runs.BUILDER_PLAN_ROLE;
      scope.planCommit = async (actionId, body) => {
        const fresh = await scope.checkActive();
        const revoked = runs.planModeBlocked({ org: fresh.org, instance: fresh.instance, run, userSysId: fresh.userSysId });
        if (revoked) throw new Error(revoked);
        const refused = runs.planCommitAllowed(fresh.org, actionId);
        if (refused) throw new Error(refused);
        return commit(actionId, {
          sn, actionsTiers: fresh.org.actions_tiers, automatic: true,
          audit: (entry) => auditFor(session, { ...entry, run: run.id, approval: `plan:${run.id}` }),
        }, body);
      };
    }
  }

  if (conv.run.policy === 'autonomous') {
    systemExtra = `${next.systemExtra || ''}\n\n${runs.AUTONOMOUS_ROLE}`;
    if (next.stage === 'build' && conv.run.template !== 'audit') {
      scope.planCommit = async (actionId, body) => {
        const fresh = await scope.checkActive();
        const blocked = runs.autonomousCommitAllowed(fresh.org, actionId);
        if (blocked) throw new Error(blocked);
        const sn = await snFor(fresh);
        execution.controller.signal.throwIfAborted();
        return commit(actionId, {
          sn, actionsTiers: fresh.org.actions_tiers, automatic: true,
          audit: entry => auditFor(fresh, { ...entry, conversation: conv.id, run: conv.run.id, approval: `autonomous:${conv.run.id}` }),
        }, body);
      };
    }
  }

  let result;
  let text = '';
  try {
    result = await runAgentTurn({
      cfg,
      sn: await snFor(session),
      user: session.user,
      messages,
      userText: next.prompt,
      emit: (event, data) => { if (event === 'text') text += data.delta; emit(event, data); },
      conversationId: conv.id,
      scope,
      model: gate.model,
      systemExtra,
      maxIterations: conv.run.policy === 'autonomous' ? 100 : 24,
      signal: execution.controller.signal,
      audit: (entry) => audit(session.scope, { user: session.user?.user_name, conversation: conv.id, run: conv.run.id, ...entry }),
    });
    if (result.exhausted) {
      conv.run.status = 'needs_attention';
      conv.run.findings = 'The model reached its execution safeguard before finishing. Review the transcript before starting more work.';
    } else runs.advance(conv.run, next.stage, { text, after: next.after });
  } catch (err) {
    result = err.meter;
    conv.run.status = execution.controller.signal.aborted ? 'stopped' : 'needs_attention';
    conv.run.findings = String(err?.message || err);
    console.error('Task stage failed:', err.message);
    emit('error', { message: String(err?.message || err) });
  }

  if (execution.controller.signal.aborted) conv.run.status = 'stopped';
  try {
    conv.messages = messages;
    await store.saveConversation(session.scope, conv);
  } catch (err) {
    console.error('Could not save conversation:', err.message);
  }
  if (result) {
    billing.recordUsage(session.ctx, {
      instanceId: session.instance.id,
      userSysId: session.userSysId,
      conversationId: conv.id,
      model: result.model,
      provider: gate.model.provider,
      usage: result.usage,
      cost: result.cost,
    }).catch((err) => console.error('usage record failed:', err.message));
  }
  emit('run', runs.describe(conv.run));
  res.end();
  } finally { activeStages.delete(lockKey); }
});

// ---- instance notebook (console-local, never an instance write) ----
//
// The notebook is the one write the agent makes without leaving the console,
// so it carries the same approval pattern: a note only becomes eligible for
// injection into other people's conversations once a human keeps it
// (ADR 0008 D5).

app.post('/api/notebook/keep', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const id = String(req.body?.id || '');
  const note = await keepNote(session.scope, id, {
    user: session.user?.user_name,
    conversation: req.body?.conversation_id ? String(req.body.conversation_id) : undefined,
  });
  if (!note) return res.status(404).json({ error: 'note not found' });
  await auditFor(session, { action: 'notebook_keep', note_id: id, chars: note.text.length, approved_by_user: true });
  res.json({ ok: true, note });
});

app.post('/api/notebook/discard', async (req, res) => {
  const session = await requireActive(req, res);
  if (!session) return;
  const id = String(req.body?.id || '');
  const removed = await discardNote(session.scope, id);
  if (!removed) return res.status(404).json({ error: 'note not found' });
  await auditFor(session, { action: 'notebook_discard', note_id: id });
  res.json({ ok: true });
});

// ---- admin: thin and complete (ADR 0008 D17) ----

app.get('/api/admin', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  try {
    const [instances, members, usage, auditRows] = await Promise.all([
      tenancy.listInstances(session.ctx),
      tenancy.listMembers(session.ctx),
      billing.usageSummary(session.ctx),
      listAudit(session.scope, { limit: 50 }),
    ]);
    res.json({
      org: tenancy.publicOrg(session.org),
      me: { member_id: session.member.id, role: session.member.role, user_name: session.user?.user_name },
      instances,
      members,
      plan: billing.planFor(session.org),
      plans: billing.PLANS,
      usage,
      model_connections: session.org.model_connections || [],
      available_models: billing.availableModels(session.org),
      default_model: billing.availableModels(session.org)[0]?.id || null,
      model: {
        provider: session.org.model_provider,
        has_key: !!session.org.has_model_key,
        model_id: session.org.model_id,
        base_url: session.org.model_base_url,
        effort: session.org.model_effort,
      },
      callback_url: cfg.callbackUrl,
      mode: cfg.mode,
      audit: auditRows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

app.post('/api/admin/settings', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  try {
    const org = await tenancy.updateOrgSettings(session.ctx, req.body || {});
    await auditFor(session, { action: 'org_settings', changed: Object.keys(req.body || {}), approved_by_user: true });
    res.json({ org: tenancy.publicOrg(org) });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.post('/api/admin/members/:id', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  const target = await tenancy.getMember(session.ctx, req.params.id);
  if (!target) return res.status(404).json({ error: 'member not found' });
  const { status, role } = req.body || {};
  if (target.id === session.member.id && (status === 'blocked' || (role && role !== target.role))) {
    return res.status(400).json({ error: 'you cannot block or re-role yourself' });
  }
  if ((target.role === 'owner' || role === 'owner') && session.member.role !== 'owner') {
    return res.status(403).json({ error: 'only an owner can change owners' });
  }
  try {
    const member = await tenancy.setMember(session.ctx, target.id, { status, role, actor: session.user?.user_name });
    await auditFor(session, { action: 'member_update', member: target.user_name, status, role, approved_by_user: true });
    res.json({ member });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.post('/api/admin/instances', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  const plan = billing.planFor(session.org);
  const instances = await tenancy.listInstances(session.ctx);
  const live = instances.filter((i) => i.status !== 'disconnected').length;
  if (plan.max_instances != null && live >= plan.max_instances) {
    return res.status(402).json({ error: `The ${plan.label} plan covers ${plan.max_instances} instance${plan.max_instances === 1 ? '' : 's'}. Add your own model connection to register more; no purchase is required.` });
  }
  const { host, client_id, client_secret, label } = req.body || {};
  try {
    const instance = await tenancy.addInstanceDraft(session.ctx, { host, clientId: client_id, clientSecret: client_secret, label });
    await auditFor(session, { action: 'instance_draft', host: instance.host, approved_by_user: true });
    res.json({ instance, verify_url: `/auth/verify?instance=${instance.id}` });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.post('/api/admin/instances/:id/credentials', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  const { host, client_id, client_secret } = req.body || {};
  try {
    const instance = await tenancy.updateInstanceCredentials(session.ctx, req.params.id, { host, clientId: client_id, clientSecret: client_secret });
    if (!instance) return res.status(404).json({ error: 'instance not found' });
    await auditFor(session, { action: 'instance_credentials', host: instance.host, approved_by_user: true });
    res.json({ instance, verify_url: `/auth/verify?instance=${instance.id}` });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.post('/api/admin/instances/:id/environment', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  try {
    const instance = await tenancy.setInstanceEnvironment(session.ctx, req.params.id, req.body?.non_production === true);
    await auditFor(session, { action: 'instance_environment', instance: instance.id, host: instance.host, non_production: instance.non_production, approved_by_user: true });
    res.json({ instance });
  } catch (err) {
    res.status(400).json({ error: String(err.message) });
  }
});

app.post('/api/admin/instances/:id/disconnect', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  if (req.params.id === session.instance.id) return res.status(400).json({ error: 'you are signed in through this instance — disconnect it from another' });
  const instance = await tenancy.getInstance(session.ctx, req.params.id);
  if (!instance) return res.status(404).json({ error: 'instance not found' });
  await tenancy.disconnectInstance(session.ctx, instance.id);
  await auditFor(session, { action: 'instance_disconnect', host: instance.host, approved_by_user: true });
  res.json({ ok: true });
});

// Multiple model connections, all write-only credentials scoped to this org.
app.post('/api/admin/models', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  const { operation = 'save', id, api_key } = req.body || {};
  try {
    let org;
    if (operation === 'remove') {
      org = await tenancy.removeModelConnection(session.ctx, id);
    } else if (operation === 'default') {
      if (!billing.availableModels(session.org).some(m => m.id === id)) throw new Error('Choose an available model.');
      org = await tenancy.setDefaultModelConnection(session.ctx, id);
    } else if (operation === 'save') {
      const clean = tenancy.cleanModelConnection(req.body);
      const existing = id ? session.org.model_connections?.find(m => m.id === id) : null;
      if (id && !existing) throw new Error('Model connection not found.');
      // Never reuse a stored secret against a newly typed endpoint/provider.
      if (!api_key && existing && (existing.provider !== clean.provider || existing.base_url !== clean.base_url)) {
        throw new Error('Enter the API key again when changing provider or endpoint.');
      }
      const key = api_key || (existing ? await tenancy.modelConnectionKey(session.ctx, id) : null);
      if (!key || typeof key !== 'string' || key.length > 8192) throw new Error('Enter an API key for this connection.');
      try { await smokeTestModel({ kind: clean.provider === 'openai' ? 'openai' : 'anthropic', apiKey: key, baseUrl: clean.base_url || undefined, model: clean.model_id, effort: clean.effort }); }
      catch { throw new Error('The model connection test failed. Check the endpoint, model ID and API key.'); }
      org = await tenancy.saveModelConnection(session.ctx, clean, key, id);
    } else throw new Error('Unknown model action.');
    await auditFor(session, { action: 'model_connection_' + operation, connection: id || null, approved_by_user: true });
    res.json({ org: tenancy.publicOrg(org), smoke_test: operation === 'save' ? 'passed' : undefined });
  } catch (err) {
    // The upstream may echo request details in an error; do not expose a key.
    const message = String(err.message).replaceAll(String(api_key || '\0'), '[redacted]');
    res.status(400).json({ error: message });
  }
});

app.get('/api/admin/audit', async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;
  const rows = await listAudit(session.scope, { limit: 26, before: req.query.before });
  res.json({ audit: rows.slice(0, 25), next: rows.length > 25 ? rows[24].id : null });
});

// --- pages ---
app.get('/', async (req, res) => {
  const session = await getSession(req);
  if (!session) return res.redirect(await tenancy.selfHostedDeployment() ? '/signin' : '/start');
  if (session.member?.status !== 'active') return res.sendFile(path.join(PUBLIC_DIR, 'pending.html'));
  if (isAdmin(session) && !billing.availableModels(session.org).length) return res.redirect('/admin?setup=1');
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});
app.get('/signin', async (req, res) => {
  const session = await getSession(req);
  if (session) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/start', async (req, res) => {
  if (await tenancy.selfHostedDeployment()) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'start.html'));
});
app.get('/admin', async (req, res) => {
  const session = await getSession(req);
  if (!session) return res.redirect('/signin');
  if (!isAdmin(session) || session.member?.status !== 'active') return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});
app.get('/pending', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pending.html')));
app.use(express.static(PUBLIC_DIR));

// Bind the unspecified IPv6 address explicitly: Railway's edge (and its private
// network) reach the container over IPv6, and Node only picks "::" on its own
// when it decides IPv6 is available at startup, which it did not there. "::"
// is dual-stack, so IPv4 health checks and localhost still work. Hosts with no
// IPv6 at all (some Docker setups) refuse it, so fall back to 0.0.0.0 then.
// Local storage serves this computer only. Shared hosts explicitly opt into
// a listening address and use a managed PostgreSQL connection.
const bindHost = localStorage() ? '127.0.0.1' : (process.env.HOST || '::');
let server = app.listen(cfg.port, bindHost, onListen);
server.on("error", (err) => {
  if (err.code === 'EAFNOSUPPORT' && bindHost === '::') {
    server = app.listen(cfg.port, '0.0.0.0', onListen);
    server.on('error', failListen);
  } else failListen(err);
});
async function failListen(err) {
  console.error(err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Stop the other app or change PORT and BASE_URL in apps/console/.env.` : err.message);
  await closeDatabase().catch(() => {});
  process.exit(1);
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const execution of activeStages.values()) execution.controller?.abort();
  server.close();
  server.closeAllConnections();
  await closeDatabase();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
function onListen() {
  console.log(`Kaddiya → ${cfg.baseUrl}  (self-hosted · browser setup at /start · bring your own models)`);
  process.send?.({ type: 'ready', baseUrl: cfg.baseUrl, setupRequired: setupRequiredAtBoot });
  const info = modelInfo(cfg.model);
  if (process.env.ANTHROPIC_API_KEY && !info.known) console.warn(`⚠️  Unknown model "${cfg.model}" — sending a plain request (no effort, no fallbacks) and no cost estimate.`);
  if (process.env.ANTHROPIC_API_KEY && cfg.effort && !info.supportsEffort) console.warn(`⚠️  ANTHROPIC_EFFORT is set but ${cfg.model} does not support it — ignoring.`);
  // Background-sync the docs for the default family so the first docs
  // question doesn't pay for the clone. Release detection may upgrade the
  // family later; that family syncs lazily on first use.
  if (process.env.KADDIYA_DOCS_SYNC !== '0') {
    console.log(`Syncing ServiceNow docs (${defaultFamily()}) in the background…`);
    warmDocs();
  }
}
