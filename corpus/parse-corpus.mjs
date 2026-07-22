#!/usr/bin/env node
// Parse corpus/store/*.eml → classified, chronological index.
// Zero-dep. Reads raw RFC822, extracts headers + the text/plain part (decoding
// quoted-printable / base64), classifies each message, and writes:
//   index/corpus-index.json  (data of record)
//   index/corpus-index.md    (browsable chronological table)
// Prints a counts summary (nothing is silently dropped).
//
//   node corpus/parse-corpus.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, 'store');
const INDEX = join(HERE, 'index');
if (!existsSync(STORE)) { console.error('No store/ — run sync-corpus.mjs first.'); process.exit(1); }
if (!existsSync(INDEX)) mkdirSync(INDEX, { recursive: true });

// --- header parsing (unfold continuation lines) ---
function splitHeadersBody(raw) {
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx === -1) return { head: raw, body: '' };
  const sep = raw.slice(idx).match(/^\r?\n\r?\n/) ? (raw[idx] === '\r' ? 4 : 2) : 2;
  return { head: raw.slice(0, idx), body: raw.slice(idx + sep) };
}
function parseHeaders(head) {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const h = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (m) { const k = m[1].toLowerCase(); h[k] = h[k] ? h[k] + ', ' + m[2] : m[2]; }
  }
  return h;
}

// --- body decoding ---
function decodeQP(s) {
  s = s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}
function decodeBody(content, cte) {
  const enc = (cte || '').toLowerCase();
  if (enc.includes('base64')) return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (enc.includes('quoted-printable')) return decodeQP(content);
  return content;
}
// Pull the text/plain part out of a (possibly multipart) message.
function textPlain(headers, body) {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary="?([^";]+)"?/i);
  if (/multipart\//i.test(ct) && bm) {
    const parts = body.split('--' + bm[1]);
    for (const part of parts) {
      const { head, body: pbody } = splitHeadersBody(part.replace(/^\r?\n/, ''));
      const ph = parseHeaders(head);
      if (/text\/plain/i.test(ph['content-type'] || '')) return decodeBody(pbody, ph['content-transfer-encoding']);
    }
    // fall back: first part
    const { head, body: pbody } = splitHeadersBody(parts[1] ? parts[1].replace(/^\r?\n/, '') : '');
    return decodeBody(pbody, parseHeaders(head)['content-transfer-encoding']);
  }
  return decodeBody(body, headers['content-transfer-encoding']);
}

// Strip quoted reply chain + signature → short gist of the new content.
function gist(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^>/.test(line)) break;
    if (/^On .+wrote:$/.test(line.trim())) break;
    if (/^On\b.+\b20\d{2}\b/.test(line.trim())) break; // gmail attribution, incl. wrapped "On <date>, 20XX … wrote:"
    if (/^-{2}\s*$/.test(line)) break; // signature delimiter
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function classify(h, subject) {
  const from = (h['from'] || '').toLowerCase();
  const ct = (h['content-type'] || '').toLowerCase();
  if (ct.includes('text/calendar') || from.includes('calendar-notification@google.com') ||
      /^(accepted|declined|tentatively accepted|invitation|updated invitation|canceled event|notification):/i.test(subject)) return 'calendar';
  if (/^(automatic reply|auto:|out of office|autoreply)/i.test(subject) || h['auto-submitted']?.includes('auto')) return 'autoreply';
  return 'substantive';
}

const files = readdirSync(STORE).filter((f) => f.endsWith('.eml'));
const rows = [];
const counts = { substantive: 0, calendar: 0, autoreply: 0 };

for (const f of files) {
  const raw = readFileSync(join(STORE, f), 'utf8');
  const { head, body } = splitHeadersBody(raw);
  const h = parseHeaders(head);
  const subject = h['subject'] || '(no subject)';
  const cls = classify(h, subject);
  counts[cls]++;
  const dateRaw = h['date'] || '';
  const date = dateRaw ? new Date(dateRaw).toISOString() : ''; // tz-safe: RFC822 Date carries an explicit offset
  rows.push({
    id: f.replace(/\.eml$/, ''),
    date, dateRaw,
    from: h['from'] || '', to: h['to'] || '', cc: h['cc'] || '',
    subject,
    threadKey: subject.replace(/^((re|fwd?):\s*)+/i, '').trim().toLowerCase(),
    messageId: h['message-id'] || '',
    class: cls,
    gist: cls === 'substantive' ? gist(textPlain(h, body)) : '',
    file: `store/${f}`,
  });
}

rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
writeFileSync(join(INDEX, 'corpus-index.json'), JSON.stringify({ generated: new Date().toISOString(), counts, total: rows.length, messages: rows }, null, 2));

// Markdown: substantive only, chronological
const sub = rows.filter((r) => r.class === 'substantive');
const md = [
  '# Corpus Index — !organize label emails (substantive)',
  '',
  `Total fetched: **${rows.length}** · substantive (this table): **${sub.length}** · calendar ${counts.calendar} · autoreply ${counts.autoreply}`,
  `Range: ${sub[0]?.date?.slice(0, 10) || '?'} → ${sub[sub.length - 1]?.date?.slice(0, 10) || '?'}`,
  '',
  '| Date | From | Subject | Gist | File |',
  '|------|------|---------|------|------|',
  ...sub.map((r) => `| ${r.date.slice(0, 16).replace('T', ' ')} | ${shortFrom(r.from)} | ${esc(r.subject)} | ${esc(r.gist)} | ${r.file} |`),
].join('\n');
writeFileSync(join(INDEX, 'corpus-index.md'), md);

function shortFrom(f) { const m = f.match(/^"?([^"<]+?)"?\s*</); return esc((m ? m[1] : f).trim()); }
function esc(s) { return (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }

console.log(`Parsed ${rows.length} messages → index/corpus-index.{json,md}`);
console.log(`  substantive ${counts.substantive} (in table) · calendar ${counts.calendar} · autoreply ${counts.autoreply}`);
