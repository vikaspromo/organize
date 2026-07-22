#!/usr/bin/env node
// Incremental, read-only fetch of the `!organize` Gmail label into corpus/store/.
// Zero-dep (node built-ins only). First run = full backfill; later runs = only mail
// newer than the last sync. Dedupes by Gmail message id. Writes raw RFC822 (.eml).
//
//   node corpus/sync-corpus.mjs
//
// Requires corpus/credentials.json + corpus/token.json (run auth.mjs first).

import https from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRED_PATH = join(HERE, 'credentials.json');
const TOKEN_PATH = join(HERE, 'token.json');
const STORE = join(HERE, 'store');
const STATE_PATH = join(HERE, '.sync-state.json');
// Pull all emails with the !organize Gmail label from the last 3 years, including Trash and Spam
// (in:anywhere ensures deleted/spam-filtered messages are not silently absent)
const CORPUS_QUERY = 'label:!organize after:2023/7/22 in:anywhere';

for (const p of [CRED_PATH, TOKEN_PATH]) {
  if (!existsSync(p)) { console.error(`Missing ${p}. Run setup (SETUP.md) and node corpus/auth.mjs first.`); process.exit(1); }
}
if (!existsSync(STORE)) mkdirSync(STORE, { recursive: true });

const conf = (() => { const c = JSON.parse(readFileSync(CRED_PATH, 'utf8')); return c.installed || c.web; })();
const { refresh_token } = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};

// --- tiny HTTPS helpers (retry on transient network errors / 429 / 5xx) ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };

function reqOnce(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: parse(d) })); });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('request timeout')));
    if (body) r.write(body);
    r.end();
  });
}

async function req(opts, body, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await reqOnce(opts, body);
      if ([429, 500, 502, 503, 504].includes(res.status)) { await sleep(Math.min(2 ** i * 500, 16000)); continue; }
      return res;
    } catch (e) {                 // ECONNRESET, timeout, etc.
      lastErr = e;
      await sleep(Math.min(2 ** i * 500, 16000));
    }
  }
  if (lastErr) throw lastErr;
  return { status: 0, json: { error: 'exhausted retries' } };
}

const get = (path, token) => req({ host: 'gmail.googleapis.com', path, method: 'GET', headers: { Authorization: `Bearer ${token}` } });

async function accessToken() {
  const body = new URLSearchParams({ client_id: conf.client_id, client_secret: conf.client_secret, refresh_token, grant_type: 'refresh_token' }).toString();
  const { status, json } = await req({ host: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
  if (status !== 200 || !json.access_token) {
    console.error('Token refresh failed:', status, json);
    console.error('If this says invalid_grant, the refresh token expired (is the OAuth app in *Production*, not Testing?). Re-run auth.mjs.');
    process.exit(1);
  }
  return json.access_token;
}

(async () => {
  let token = await accessToken();

  // Build query. Incremental uses Gmail `after:` (epoch seconds) from last sync, minus a 1-day safety overlap.
  let q = CORPUS_QUERY;
  if (state.maxInternalSec) q += ` after:${Math.max(0, state.maxInternalSec - 86400)}`;

  // Page through message ids.
  const ids = [];
  let pageToken = '';
  do {
    const path = `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const { status, json } = await get(path, token);
    if (status !== 200) { console.error('list failed:', status, json); process.exit(1); }
    (json.messages || []).forEach((m) => ids.push(m.id));
    pageToken = json.nextPageToken || '';
  } while (pageToken);

  const have = new Set(readdirSync(STORE).filter((f) => f.endsWith('.eml')).map((f) => f.replace(/\.eml$/, '')));
  const todo = ids.filter((id) => !have.has(id));

  let fetched = 0, failed = 0, maxSec = state.maxInternalSec || 0;
  for (let i = 0; i < todo.length; i++) {
    const id = todo[i];
    try {
      let r = await get(`/gmail/v1/users/me/messages/${id}?format=raw`, token);
      if (r.status === 401) { token = await accessToken(); r = await get(`/gmail/v1/users/me/messages/${id}?format=raw`, token); } // token expired mid-run
      if (r.status !== 200 || !r.json.raw) { console.error(`get ${id} failed:`, r.status, r.json.error?.message || ''); failed++; continue; }
      writeFileSync(join(STORE, `${id}.eml`), Buffer.from(r.json.raw, 'base64url').toString('utf8'));
      fetched++;
      const sec = Math.floor(Number(r.json.internalDate || 0) / 1000);
      if (sec > maxSec) maxSec = sec;
    } catch (e) {
      console.error(`get ${id} error: ${e.message}`); failed++;
    }
    if ((i + 1) % 250 === 0) console.log(`  …${i + 1}/${todo.length}`);
  }

  const total = readdirSync(STORE).filter((f) => f.endsWith('.eml')).length;
  writeFileSync(STATE_PATH, JSON.stringify({
    lastSync: new Date().toISOString(), maxInternalSec: maxSec, lastFetched: fetched, totalInStore: total,
  }, null, 2));

  console.log(`✓ Sync complete. Fetched ${fetched} new message(s)${failed ? `, ${failed} failed (re-run to retry)` : ''}; ${total} total in store/.`);
  if (fetched === 0 && !state.maxInternalSec) console.log('Note: 0 fetched on first run — check the !organize label has emails in it.');
})();
