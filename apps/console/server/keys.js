// Per-org encryption: the second, independent wall (ADR 0008 D6).
//
// KeyProvider  → wraps and unwraps each org's data-encryption key (DEK).
//                Driver `local-keyfile` here: a 256-bit master key from the
//                environment or a file. An `aws-kms` driver slots in behind
//                the same two functions when a deal needs it.
// OrgContext   → the only object that can encrypt or decrypt an org's data.
//                It is built from the org row a *session* resolved to, never
//                from an org_id found on a record, so ciphertext written for
//                org B cannot be opened in org A's request even if a query
//                somehow returned it — the AAD is `org_id:column` and the DEK
//                is B's. test/keys.test.js proves that direction.
//
// Ciphertext layout, versioned: [0x01][12-byte iv][16-byte tag][ciphertext].

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 0x01;
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

let masterKey;

/**
 * The master key: KADDIYA_MASTER_KEY (64 hex chars) or the file at
 * KADDIYA_MASTER_KEY_FILE. With neither set, a development key is generated
 * once at data/master.key and reused — with a warning, because losing it
 * orphans every org's data (which is exactly the crypto-shred property D7
 * wants, aimed at the wrong target).
 */
function master() {
  if (masterKey) return masterKey;
  const hex = process.env.KADDIYA_MASTER_KEY;
  if (hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('KADDIYA_MASTER_KEY must be 64 hex characters (256 bits)');
    masterKey = Buffer.from(hex, 'hex');
    return masterKey;
  }
  const file = process.env.KADDIYA_MASTER_KEY_FILE || path.join(DATA_DIR, 'master.key');
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error(`${file} does not hold a 64-hex-character key`);
    masterKey = Buffer.from(text, 'hex');
    return masterKey;
  } catch (err) {
    if (err.code !== 'ENOENT' || process.env.KADDIYA_MASTER_KEY_FILE) throw err;
  }
  masterKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, masterKey.toString('hex') + '\n', { mode: 0o600 });
  console.warn(`⚠️  Generated a development master key at ${file}. Set KADDIYA_MASTER_KEY (or _FILE) anywhere that matters; losing this file loses every org's data.`);
  return masterKey;
}

function seal(key, aad, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

function open(key, aad, blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < 1 + 12 + 16 || buf[0] !== VERSION) throw new Error('unrecognised ciphertext');
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---- KeyProvider: local-keyfile ----

export const keyProvider = {
  name: 'local-keyfile',
  newDek() {
    return crypto.randomBytes(32);
  },
  wrapDek(orgId, dek) {
    return seal(master(), `kaddiya-dek:${orgId}`, dek);
  },
  unwrapDek(orgId, wrapped) {
    return open(master(), `kaddiya-dek:${orgId}`, wrapped);
  },
};

// ---- OrgContext ----

const dekCache = new Map(); // `${orgId}:${key_version}` -> dek

export class OrgContext {
  /** Build from an org row that a session resolved to. Not from a record's org_id. */
  constructor(orgRow) {
    if (!orgRow?.id || !orgRow.dek_wrapped) throw new Error('OrgContext needs an org row with a wrapped key');
    this.orgId = orgRow.id;
    this.org = orgRow;
    const cacheKey = `${orgRow.id}:${orgRow.key_version || 1}`;
    let dek = dekCache.get(cacheKey);
    if (!dek) {
      dek = keyProvider.unwrapDek(orgRow.id, orgRow.dek_wrapped);
      dekCache.set(cacheKey, dek);
    }
    this.dek = dek;
  }

  encrypt(column, plaintext) {
    const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    return seal(this.dek, `${this.orgId}:${column}`, bytes);
  }

  decrypt(column, blob) {
    return open(this.dek, `${this.orgId}:${column}`, blob).toString('utf8');
  }
}

/** A fresh wrapped DEK for a new org. */
export function newWrappedDek(orgId) {
  return keyProvider.wrapDek(orgId, keyProvider.newDek());
}

/** Session-cookie custody (D8): tokens are sealed under a key derived from the cookie itself. */
export function sessionKey(sidSecret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sidSecret, 'utf8'), 'kaddiya-session', 'session-tokens', 32));
}

export function sealWithKey(key, aad, plaintext) {
  return seal(key, aad, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8'));
}

export function openWithKey(key, aad, blob) {
  return open(key, aad, blob).toString('utf8');
}

/** Only tests call this, to prove a key rotation invalidates the cache. */
export function _resetKeyCache() {
  dekCache.clear();
  masterKey = undefined;
}
