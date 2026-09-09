// Official ServiceNow documentation, pinned to the release family the
// signed-in instance is actually running. Answers grounded here cite a topic
// for the user's version — not the model's memory of some other release.
//
// Docs live in per-family sparse clones of github.com/ServiceNow/ServiceNowDocs
// under docs-cache/<family>/ (same recipe as scaffold/Makefile.template).
// Search shells out to `git grep`, which is what beats the incomplete TOCs.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.join(__dirname, '..', 'docs-cache');
// The ServiceNow SDK's own Fluent documentation, captured from `now-sdk
// explain` by scripts/fluent-docs.mjs and committed (ADR 0010 D4). It is a
// knowledge source, not a write path; the console never runs the SDK.
const FLUENT_ROOT = path.join(__dirname, '..', 'docs-fluent');
const FLUENT_PUBLICATION = 'fluent-sdk';
const DOCS_REPO = 'https://github.com/ServiceNow/ServiceNowDocs.git';
const RAW_BASE = 'https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs';

// The support window: the current family and the two before it. Newest first.
export const SUPPORTED_FAMILIES = ['australia', 'zurich', 'yokohama'];

// Older families we can recognize and clamp to the oldest supported branch.
const OLDER_FAMILIES = ['xanadu', 'washingtondc', 'vancouver', 'utah', 'tokyo'];

// Publications worth carrying (mirrors scaffold/Makefile.template).
const PUBLICATIONS = [
  'application-development',
  'intelligent-experiences',
  'employee-service-management',
  'it-service-management',
  'governance-risk-compliance',
  'platform-user-interface',
  'platform-security',
  'platform-administration',
  'api-reference',
  // virtual: served from docs-fluent/, not the ServiceNowDocs clone
  FLUENT_PUBLICATION,
];

// Keyed per instance host: two instances on different releases must not share
// a detection result (ADR 0008 D7 — the process-global cache was a latent
// multi-tenant bug, and sub-prods routinely run a different family than prod).
const releaseCache = new Map(); // instance host -> { family, buildname, source, note? }
const syncPromises = new Map(); // family -> Promise<void>

function hostOf(instanceUrl) {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return String(instanceUrl || 'unknown');
  }
}

/**
 * Which release family THIS instance runs. Tries the instance itself
 * (glide.buildname, readable by admins; many users are ACL-denied), then the
 * SN_DOCS_RELEASE env override, then defaults to the newest supported family.
 */
export async function detectRelease(sn) {
  const key = hostOf(sn?.cfg?.instanceUrl);
  const cached = releaseCache.get(key);
  if (cached) return cached;
  let buildname = '';
  let source = 'default';
  try {
    const data = await sn.get('/api/now/table/sys_properties', {
      sysparm_query: 'name=glide.buildname',
      sysparm_fields: 'value',
      sysparm_limit: 1,
    });
    buildname = data.result?.[0]?.value || '';
    if (buildname) source = 'instance';
  } catch { /* non-admins usually cannot read sys_properties */ }

  if (!buildname && process.env.SN_DOCS_RELEASE) {
    buildname = process.env.SN_DOCS_RELEASE;
    source = 'config';
  }

  const { family, note } = normalizeFamily(buildname);
  const release = { family, buildname: buildname || family, source, ...(note ? { note } : {}) };
  releaseCache.set(key, release);
  return release;
}

/** Forget one instance's detected release (used after a re-verification). */
export function forgetRelease(instanceUrl) {
  releaseCache.delete(hostOf(instanceUrl));
}

function normalizeFamily(buildname) {
  const name = String(buildname || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!name) return { family: SUPPORTED_FAMILIES[0] };
  if (SUPPORTED_FAMILIES.includes(name)) return { family: name };
  if (OLDER_FAMILIES.includes(name)) {
    const oldest = SUPPORTED_FAMILIES[SUPPORTED_FAMILIES.length - 1];
    return {
      family: oldest,
      note: `Instance reports "${buildname}", older than the supported window (current or minus 2) — using ${oldest} docs; treat version-sensitive answers with care.`,
    };
  }
  return {
    family: SUPPORTED_FAMILIES[0],
    note: `Unrecognized release "${buildname}" — using ${SUPPORTED_FAMILIES[0]} docs.`,
  };
}

export function defaultFamily() {
  return normalizeFamily(process.env.SN_DOCS_RELEASE || '').family;
}

function familyDir(family) {
  return path.join(CACHE_ROOT, family);
}

/** The captured Fluent corpus for the SDK version recorded in docs-fluent/VERSION, if present. */
function fluentDir() {
  try {
    const version = fs.readFileSync(path.join(FLUENT_ROOT, 'VERSION'), 'utf8').trim();
    const dir = path.join(FLUENT_ROOT, version);
    return fs.existsSync(dir) ? { dir, version } : null;
  } catch {
    return null;
  }
}

/** Plain grep over the Fluent corpus (it is not a git clone, so git grep cannot see it). */
async function grepFluent(terms, allMatch) {
  const f = fluentDir();
  if (!f) return [];
  const args = ['-r', '-i', '-l', ...(allMatch ? [] : []), ...terms.flatMap((t) => ['-e', t]), '--', f.dir];
  let files;
  try {
    const { stdout } = await run('grep', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    files = stdout.split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 1) return [];
    throw err;
  }
  if (allMatch && terms.length > 1) {
    // grep -e is OR; require every term by reading the candidates.
    files = files.filter((file) => {
      const lower = fs.readFileSync(file, 'utf8').toLowerCase();
      return terms.every((t) => lower.includes(t));
    });
  }
  return files.filter((file) => file.endsWith('.md') && !file.endsWith('index.md'));
}

/** Clone the family's docs branch if we don't have it yet. Concurrency-safe. */
export function syncDocs(family) {
  if (!SUPPORTED_FAMILIES.includes(family)) {
    return Promise.reject(new Error(`Unsupported docs family "${family}". Supported: ${SUPPORTED_FAMILIES.join(', ')}`));
  }
  const dir = familyDir(family);
  if (fs.existsSync(path.join(dir, 'markdown'))) return Promise.resolve();
  if (syncPromises.has(family)) return syncPromises.get(family);

  const promise = (async () => {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true }); // half-finished clone from a crash
    await run('git', [
      'clone', '--depth', '1', '--branch', family, '--filter=blob:none', '--sparse',
      DOCS_REPO, dir,
    ], { timeout: 10 * 60 * 1000 });
    await run('git', [
      '-C', dir, 'sparse-checkout', 'set', ...PUBLICATIONS.map((p) => `markdown/${p}`),
    ], { timeout: 10 * 60 * 1000 });
  })().finally(() => syncPromises.delete(family));

  syncPromises.set(family, promise);
  return promise;
}

/** Kick off a background sync at boot so the first docs question doesn't wait. */
export function warmDocs(family = defaultFamily()) {
  syncDocs(family)
    .then(() => console.log(`Docs ready: ${family} (${familyDir(family)})`))
    .catch((err) => console.warn(`⚠️  Docs sync for ${family} failed (docs tools will retry on use): ${err.message}`));
}

/**
 * Full-text search over the family's docs. Requires every term by default,
 * falls back to any-term when that finds nothing.
 */
export async function searchDocs({ family, query, publication, limit = 8 }) {
  await syncDocs(family);
  const dir = familyDir(family);

  const terms = [...new Set(
    String(query || '').toLowerCase().split(/[^a-z0-9_.]+/).filter((t) => t.length >= 3),
  )].slice(0, 6);
  if (!terms.length) throw new Error('Give me a few words to search the docs for.');

  if (publication && !PUBLICATIONS.includes(publication)) {
    throw new Error(`Unknown publication "${publication}". Available: ${PUBLICATIONS.join(', ')}`);
  }
  const fluentOnly = publication === FLUENT_PUBLICATION;
  const pathspec = publication && !fluentOnly ? `markdown/${publication}` : 'markdown';

  const grep = async (args) => {
    try {
      const { stdout } = await run(
        'git', ['-C', dir, 'grep', '-i', '-l', ...args, '--', pathspec],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout.split('\n').filter(Boolean);
    } catch (err) {
      if (err.code === 1) return []; // git grep: no matches
      throw err;
    }
  };

  let files = fluentOnly ? [] : await grep(['--all-match', ...terms.flatMap((t) => ['-e', t])]);
  let fluentFiles = publication && !fluentOnly ? [] : await grepFluent(terms, true);
  let mode = 'all terms';
  if (!files.length && !fluentFiles.length && terms.length > 1) {
    files = fluentOnly ? [] : await grep(terms.flatMap((t) => ['-e', t]));
    fluentFiles = publication && !fluentOnly ? [] : await grepFluent(terms, false);
    mode = 'any term';
  }
  // Fluent hits are addressed as fluent-sdk/<topic>.md so getDoc can find them.
  const fluent = fluentDir();
  files = files.concat(fluentFiles.map((f) => `${FLUENT_PUBLICATION}/${path.relative(fluent.dir, f)}`));

  // Filename hits are the strongest relevance signal in this repo.
  const nameScore = (f) => terms.reduce((s, t) => s + (f.toLowerCase().includes(t) ? 1 : 0), 0);
  files.sort((a, b) => nameScore(b) - nameScore(a) || a.length - b.length);

  const results = [];
  for (const file of files.slice(0, Math.min(Number(limit) || 8, 20))) {
    const isFluent = file.startsWith(`${FLUENT_PUBLICATION}/`);
    const full = isFluent ? path.join(fluent.dir, file.slice(FLUENT_PUBLICATION.length + 1)) : path.join(dir, file);
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
      || path.basename(file, '.md').replace(/-/g, ' ');
    const lower = text.toLowerCase();
    const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const snippet = text.slice(Math.max(0, at - 60), at + 200).replace(/\s+/g, ' ').trim();
    results.push({
      title,
      publication: isFluent ? FLUENT_PUBLICATION : (file.split('/')[1] || ''),
      path: file,
      snippet,
      ...(isFluent
        ? { source: `now-sdk explain ${path.basename(file, '.md')} (SDK ${fluent.version})` }
        : { url: `${RAW_BASE}/${family}/${file}` }),
    });
  }

  return {
    family,
    matched: mode,
    total_matches: files.length,
    results,
    note: results.length
      ? 'Read a topic with sn_docs_get before relying on it. Cite the path or url in your answer.'
      : 'No matches — try different words, or drop the publication filter.',
  };
}

const MAX_DOC_CHARS = 24_000;

/** Read one doc topic by the repo-relative path sn_docs_search returned. */
export async function getDoc({ family, path: docPath }) {
  await syncDocs(family);
  const dir = familyDir(family);
  const rel = String(docPath || '').replace(/^\/+/, '');
  let full;
  if (rel.startsWith(`${FLUENT_PUBLICATION}/`)) {
    const f = fluentDir();
    if (!f) throw new Error('The Fluent SDK corpus is not present in this build.');
    full = path.resolve(f.dir, rel.slice(FLUENT_PUBLICATION.length + 1));
    if (!full.startsWith(path.resolve(f.dir) + path.sep) || !rel.endsWith('.md')) {
      throw new Error('path must be a fluent-sdk/<topic>.md path from sn_docs_search.');
    }
  } else {
    full = path.resolve(dir, rel);
    if (!full.startsWith(path.resolve(dir) + path.sep) || !rel.startsWith('markdown/') || !rel.endsWith('.md')) {
      throw new Error('path must be a markdown/**/*.md or fluent-sdk/*.md path from sn_docs_search.');
    }
  }
  let content;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch {
    throw new Error(`No such topic in the ${family} docs: ${rel}`);
  }
  const truncated = content.length > MAX_DOC_CHARS;
  return {
    family,
    path: rel,
    ...(rel.startsWith(`${FLUENT_PUBLICATION}/`)
      ? { source: `now-sdk explain ${path.basename(rel, '.md')}` }
      : { url: `${RAW_BASE}/${family}/${rel}` }),
    chars: content.length,
    ...(truncated ? { truncated: true } : {}),
    content: truncated ? content.slice(0, MAX_DOC_CHARS) + '\n\n[truncated]' : content,
  };
}
