#!/usr/bin/env node
// One-time OAuth authorization for the corpus sync.
// Zero-dep (node built-ins only). Reads corpus/credentials.json (Desktop client,
// downloaded from Google Cloud Console), runs the Authorization Code + PKCE flow
// over a loopback redirect, and writes corpus/token.json with the refresh token.
//
//   node corpus/auth.mjs
//
// Scope is read-only Gmail. Token files are gitignored (default-deny in this dir).

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRED_PATH = join(HERE, 'credentials.json');
const TOKEN_PATH = join(HERE, 'token.json');
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

if (!existsSync(CRED_PATH)) {
  console.error(`Missing ${CRED_PATH}. Download the Desktop OAuth client JSON (SETUP.md step 3) and save it there.`);
  process.exit(1);
}

const cred = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
const conf = cred.installed || cred.web;
if (!conf?.client_id || !conf?.client_secret) {
  console.error('credentials.json does not look like a Desktop OAuth client (no installed.client_id).');
  process.exit(1);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

function postForm(host, path, params) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: tryJSON(d) })); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
const tryJSON = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch { /* fall back to printing */ }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) { res.end('waiting...'); return; }

  if (url.searchParams.has('error')) {
    res.end('Authorization failed: ' + url.searchParams.get('error'));
    console.error('Authorization denied:', url.searchParams.get('error'));
    server.close(); process.exit(1);
  }

  const code = url.searchParams.get('code');
  const port = server.address().port;
  const { status, json } = await postForm('oauth2.googleapis.com', '/token', {
    code, client_id: conf.client_id, client_secret: conf.client_secret,
    redirect_uri: `http://localhost:${port}`, grant_type: 'authorization_code', code_verifier: verifier,
  });

  if (status !== 200 || !json.refresh_token) {
    res.end('Token exchange failed — see terminal.');
    console.error('Token exchange failed:', status, json);
    server.close(); process.exit(1);
  }

  writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: json.refresh_token, obtained: new Date().toISOString() }, null, 2));
  res.end('✓ Authorized. Refresh token saved. You can close this tab and return to the terminal.');
  console.log(`✓ Refresh token saved to ${TOKEN_PATH}`);
  server.close(); process.exit(0);
});

server.listen(0, 'localhost', () => {
  const port = server.address().port;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: conf.client_id, redirect_uri: `http://localhost:${port}`, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
    code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  console.log('\nOpening your browser to authorize (read-only Gmail).');
  console.log('If it does not open, paste this URL:\n\n' + authUrl + '\n');
  openBrowser(authUrl);
});
