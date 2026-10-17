// LinkedIn alert mail. Plain text is the source. A line of dashes separates
// postings. The subject is not a row title.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { localToday } from './lib/local-today.mjs';
import { selectUnseenOffers } from './job-agent-inlet.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { appendToPipeline, appendToScanHistory, PIPELINE_PATH, SCAN_HISTORY_PATH } from './scan.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const INSIGHT = [
  /^\d+ (?:school|company) alum(?:ni|nus)?$/i,
  /^\d+ connections?$/i,
  /^apply with resume & profile$/i,
  /^this company is actively hiring$/i,
];

const PREAMBLE = [
  /^your job alert for /i,
  /^jobs that match your profile$/i,
  /^based on your title/i,
  /^manage your job alerts/i,
  /^manage recommendations/i,
  /^see all jobs/i,
  /^update:$/i,
];

const SENDERS = ['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_LOOKBACK_DAYS = 7;
export const GMAIL_MAX_MESSAGES = 50;

export function postingsFromAlertPlain(text) {
  const chunks = String(text ?? '').split(/\n\s*-{10,}\s*\n/);
  const postings = [];
  const skipped = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const parsed = postingFromChunk(chunk);
    if (!parsed) continue;
    if (parsed.skip) {
      skipped.push(parsed.skip);
      continue;
    }
    if (seen.has(parsed.posting.url)) continue;
    seen.add(parsed.posting.url);
    postings.push(parsed.posting);
  }
  return { postings, skipped };
}

function postingFromChunk(chunk) {
  const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
  let rawUrl = '';
  const content = [];
  for (const line of lines) {
    const view = line.match(/^view job:\s*(https?:\/\/\S+)/i);
    if (view) {
      rawUrl = view[1];
      break;
    }
    if (INSIGHT.some(pattern => pattern.test(line))) continue;
    if (PREAMBLE.some(pattern => pattern.test(line))) continue;
    if (/^https?:\/\//i.test(line)) continue;
    content.push(line);
  }
  const url = canonicalJobUrl(rawUrl);
  if (!url) return null;
  if (content.length < 3) {
    return { skip: { url, reason: 'incomplete' } };
  }
  const [title, company, location] = content.slice(-3);
  return { posting: { title, company, location, url } };
}

export function canonicalJobUrl(raw) {
  const match = String(raw ?? '').match(/\/jobs\/view\/(\d{6,})/);
  if (!match) return '';
  return `https://www.linkedin.com/jobs/view/${match[1]}`;
}

export function postingsFromAlertEml(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const sender = senderFromEml(source);
  const { postings, skipped } = postingsFromAlertPlain(plainTextFromEml(source));
  return {
    sender,
    skipped,
    postings: postings.map(row => ({
      ...row,
      source: 'linkedin-mail',
      note: sender ? `linkedin ${sender} ${row.url}` : `linkedin ${row.url}`,
    })),
  };
}

export async function postingsFromGmail({
  fetchImpl = globalThis.fetch,
  clientId,
  clientSecret,
  refreshToken,
  senders = SENDERS,
  days = GMAIL_LOOKBACK_DAYS,
  maxResults = GMAIL_MAX_MESSAGES,
} = {}) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env');
  }
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
  if (!Number.isInteger(maxResults) || maxResults < 1) throw new Error('maxResults must be a positive integer');
  const token = await refreshAccessToken(fetchImpl, { clientId, clientSecret, refreshToken });
  const postings = [];
  const skipped = [];
  for (const sender of senders) {
    const query = `from:${sender} newer_than:${days}d`;
    const listed = await gmailJson(fetchImpl, token, `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    for (const message of listed.messages ?? []) {
      const full = await gmailJson(fetchImpl, token, `/messages/${encodeURIComponent(message.id)}?format=raw`);
      const parsed = postingsFromAlertEml(decodeGmailRaw(full.raw));
      postings.push(...parsed.postings);
      skipped.push(...parsed.skipped);
    }
  }
  return { postings, skipped };
}

async function refreshAccessToken(fetchImpl, { clientId, clientSecret, refreshToken }) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!response.ok) {
    const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 180) : '';
    throw new Error(`Gmail token refresh failed: ${response.status} ${detail}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('Gmail token refresh returned no access_token');
  return data.access_token;
}

async function gmailJson(fetchImpl, token, pathAndQuery) {
  const response = await fetchImpl(`${GMAIL_API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 180) : '';
    throw new Error(`Gmail API ${response.status}: ${detail}`);
  }
  return response.json();
}

function decodeGmailRaw(raw) {
  return Buffer.from(String(raw ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function ingestAlertPostings(postings, {
  pipelinePath = PIPELINE_PATH,
  historyPath = SCAN_HISTORY_PATH,
  reportText = '',
  retired = [],
  dryRun = false,
} = {}) {
  const blocks = Array.isArray(retired) ? retired.filter(keyword => String(keyword ?? '').trim()) : [];
  const retiredFilter = blocks.length > 0 ? buildTitleFilter({ negative: blocks }) : null;
  const eligible = [];
  const retiredRows = [];
  for (const row of postings) {
    if (retiredFilter && !retiredFilter(row.title)) retiredRows.push(row);
    else eligible.push(row);
  }
  const pipelineText = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  const scanHistoryText = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  const { kept, duplicates } = selectUnseenOffers(eligible, { pipelineText, reportText, scanHistoryText });
  if (!dryRun && kept.length > 0) {
    await appendToPipeline(kept, { pipelinePath });
    await appendToScanHistory(kept, localToday(), 'added', { historyPath });
  }
  return { added: kept.length, kept, duplicates, retired: retiredRows };
}

function senderFromEml(source) {
  const headers = unfold(source.split(/\r?\n\r?\n/, 1)[0]);
  const from = headers.match(/^from:.*$/im)?.[0] ?? '';
  const found = SENDERS.find(address => from.toLowerCase().includes(address));
  return found ?? '';
}

function plainTextFromEml(source) {
  const headers = unfold(source.split(/\r?\n\r?\n/, 1)[0]);
  const boundary = headers.match(/boundary="?([^";\s]+)"?/i)?.[1];
  if (!boundary) return decodeBody(headers, source.split(/\r?\n\r?\n/).slice(1).join('\n\n'));
  const marker = `--${boundary}`;
  for (const part of source.split(marker)) {
    const splitAt = part.search(/\r?\n\r?\n/);
    if (splitAt < 0) continue;
    const partHeaders = unfold(part.slice(0, splitAt));
    if (!/^content-type:\s*text\/plain\b/im.test(partHeaders)) continue;
    return decodeBody(partHeaders, part.slice(splitAt).replace(/^\r?\n\r?\n/, ''));
  }
  return '';
}

function decodeBody(headers, body) {
  const encoding = headers.match(/content-transfer-encoding:\s*(\S+)/i)?.[1] ?? '';
  const trimmed = body.replace(/\r?\n--\s*$/, '').replace(/\s+$/, '');
  if (/quoted-printable/i.test(encoding)) return decodeQuotedPrintable(trimmed);
  if (/base64/i.test(encoding)) return Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf8');
  return Buffer.from(trimmed, 'latin1').toString('utf8');
}

function decodeQuotedPrintable(input) {
  const soft = input.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < soft.length; index += 1) {
    if (soft[index] === '=' && /^[0-9A-Fa-f]{2}/.test(soft.slice(index + 1, index + 3))) {
      bytes.push(parseInt(soft.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(soft.charCodeAt(index) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

function unfold(headers) {
  return headers.replace(/\r?\n[ \t]+/g, ' ');
}

function readReportText(root) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter(name => name.endsWith('.md')).map(name => readFileSync(join(dir, name), 'utf8')).join('\n');
}

function samplePaths(root) {
  return SENDERS.map(address => join(root, 'data', 'linkedin-alert-samples', `${address.split('@')[0]}.eml`));
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return '';
  return argv[index + 1] ?? '';
}

async function loadGmailEnv(root) {
  try {
    const { config } = await import('dotenv');
    config({ path: join(root, '.env'), quiet: true });
  } catch {
    // dotenv is optional. The process environment still counts.
  }
  return {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
  };
}

function upsertEnv(file, key, value) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const pattern = new RegExp(`^${key}=`);
  let found = false;
  const next = lines.map(line => {
    if (!pattern.test(line)) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) next.push(`${key}=${value}`);
  const text = `${next.filter((line, index, all) => line !== '' || index < all.length - 1).join('\n')}\n`;
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function openBrowser(url) {
  const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  });
  child.unref();
}

async function authorizeGmail(root) {
  const { clientId, clientSecret } = await loadGmailEnv(root);
  if (!clientId || !clientSecret) {
    console.error('Put GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.');
    console.error('Create a Desktop client at https://console.cloud.google.com/auth/clients');
    process.exitCode = 1;
    return;
  }
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const redirect = `http://127.0.0.1:${port}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirect);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GMAIL_SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  console.log(authUrl.toString());
  openBrowser(authUrl.toString());
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for Google'));
    }, 180000);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirect);
      if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('Gmail access saved. You can close this tab.');
      clearTimeout(timer);
      server.close();
      if (url.searchParams.get('state') !== state) reject(new Error('state mismatch'));
      else if (url.searchParams.get('error')) reject(new Error(url.searchParams.get('error')));
      else resolve(url.searchParams.get('code') ?? '');
    });
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
    }).toString(),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180);
    throw new Error(`Gmail authorization failed: ${response.status} ${detail}`);
  }
  const data = await response.json();
  if (!data.refresh_token) throw new Error('Google did not return a refresh token');
  upsertEnv(join(root, '.env'), 'GMAIL_REFRESH_TOKEN', data.refresh_token);
  console.log('Saved GMAIL_REFRESH_TOKEN in .env');
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const root = getCareerOpsRoot();
  if (argv.includes('--auth')) {
    await authorizeGmail(root);
    return;
  }
  const postings = [];
  const skipped = [];
  if (argv.includes('--gmail')) {
    const days = Number(flagValue(argv, '--days') || GMAIL_LOOKBACK_DAYS);
    const creds = await loadGmailEnv(root);
    const fetched = await postingsFromGmail({ ...creds, days, maxResults: GMAIL_MAX_MESSAGES });
    postings.push(...fetched.postings);
    skipped.push(...fetched.skipped);
  } else {
    const files = argv.filter(arg => !arg.startsWith('--') && arg !== flagValue(argv, '--days'));
    const paths = files.length > 0 ? files : samplePaths(root);
    for (const file of paths) {
      if (!existsSync(file)) {
        console.error(`missing ${file}`);
        process.exitCode = 1;
        return;
      }
      const parsed = postingsFromAlertEml(readFileSync(file));
      if (!parsed.sender) {
        console.error(`unrecognized sender in ${file}`);
        process.exitCode = 1;
        return;
      }
      postings.push(...parsed.postings);
      skipped.push(...parsed.skipped);
    }
  }
  const result = await ingestAlertPostings(postings, {
    reportText: readReportText(root),
    dryRun: !write,
  });
  const verb = write ? 'appended' : 'would append';
  console.log(`${verb} ${result.added} Pending row(s)`);
  for (const row of result.kept) console.log(`- ${row.title} | ${row.company} | ${row.location}`);
  for (const row of result.duplicates) console.log(`already recorded: ${row.title} | ${row.company}`);
  for (const row of result.retired) console.log(`retired: ${row.title}`);
  for (const row of skipped) console.log(`skipped ${row.reason}: ${row.url}`);
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
