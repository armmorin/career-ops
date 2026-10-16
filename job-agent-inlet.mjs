#!/usr/bin/env node

/**
 * On-demand inlet from a self-hosted job-agent into data/pipeline.md.
 *
 * Queries the combined Danish search tool on loopback, then appends Pending
 * rows. It does not evaluate a role, write a CV or cover letter, or submit
 * an application. The hosted endpoint https://job-agent.dk/mcp is refused.
 *
 *   node job-agent-inlet.mjs --query "data engineer" --dry-run
 *   node job-agent-inlet.mjs --query "data engineer" --location København
 *
 * The server is started separately, bound outside the career-ops web ports:
 *   MCP_HOST=127.0.0.1 MCP_PORT=43104 bun run start:danish:mcp-http
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import * as yaml from 'js-yaml';

import { normalizeCompanyName } from './invite-match.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseScanHistoryLine } from './lib/scan-history-columns.mjs';
import { appendToPipeline, appendToScanHistory, formatPipelineOffer, normalizeUrlForDedup, PIPELINE_PATH, PORTALS_PATH, SCAN_HISTORY_PATH } from './scan.mjs';
import { buildTitleFilter } from './title-keywords.mjs';

const PROVIDERS = ['jobnet', 'jobbank', 'jobindex', 'jobdanmark'];
const ALLOWED_HOSTS = new Set([
  'jobnet.dk',
  'www.jobnet.dk',
  'jobbank.dk',
  'www.jobbank.dk',
  'jobindex.dk',
  'www.jobindex.dk',
  'jobdanmark.dk',
  'www.jobdanmark.dk',
]);
const CLOSED_SUFFIXES = ['workindenmark.dk', 'it-jobbank.dk', 'ofir.dk', 'stepstone.dk', 'job-agent.dk'];
const DEFAULT_ENDPOINT = 'http://127.0.0.1:43104/mcp';
const POSTED_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEDULE_PAUSE_MS = 45_000;

export function scheduleQueries(titleFilter) {
  const list = Array.isArray(titleFilter?.positive) ? titleFilter.positive : [];
  const queries = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    let query = raw.trim();
    if (query.startsWith('word:') || query.startsWith('stem:')) query = query.slice(query.indexOf(':') + 1).trim();
    if (query.length < 2 || query.length > 200) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

export async function runScheduledInlet({ queries, runOne, pauseMs = SCHEDULE_PAUSE_MS }) {
  const results = [];
  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i];
    try {
      results.push({ query, result: await runOne(query) });
    } catch (error) {
      results.push({ query, error: error.message });
    }
    if (pauseMs > 0 && i < queries.length - 1) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return results;
}

export function assertLoopbackJobAgent(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`job-agent endpoint must be a loopback URL, got ${endpoint}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error(`job-agent endpoint must be a loopback URL, got ${endpoint}`);
  }
  return url.href;
}

export function offersFromDanishSearch(payload) {
  const failures = Array.isArray(payload?.failures)
    ? payload.failures
      .filter(failure => failure && typeof failure.provider === 'string')
      .map(failure => ({ provider: failure.provider, error: String(failure.error ?? '') }))
    : [];
  const offers = [];
  const skipped = [];
  const seen = new Set();

  for (const job of Array.isArray(payload?.jobs) ? payload.jobs : []) {
    const rawUrl = typeof job?.canonicalUrl === 'string' ? job.canonicalUrl.trim() : '';
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:') {
      skipped.push({ url: rawUrl, reason: 'missing-url' });
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    const closed = CLOSED_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
    if (closed || !ALLOWED_HOSTS.has(host)) {
      skipped.push({ url: parsed.href, reason: 'closed-source' });
      continue;
    }
    const key = normalizeUrlForDedup(parsed.href);
    if (seen.has(key)) continue;
    seen.add(key);

    const provider = PROVIDERS.includes(job.provider) ? job.provider : 'unknown';
    const also = Array.isArray(job.alsoFoundOn)
      ? job.alsoFoundOn.filter(name => PROVIDERS.includes(name) && name !== provider)
      : [];
    const offer = {
      url: parsed.href,
      company: typeof job.company === 'string' ? job.company.trim() : '',
      title: typeof job.title === 'string' ? job.title.trim() : '',
      note: also.length > 0 ? `${provider}; also ${also.join(', ')}` : provider,
    };
    if (typeof job.location === 'string' && job.location.trim()) offer.location = job.location.trim();
    if (typeof job.postedDate === 'string' && POSTED_DATE.test(job.postedDate)) {
      offer.postedAt = Date.parse(`${job.postedDate}T00:00:00.000Z`);
    }
    offers.push(offer);
  }

  return { offers, failures, skipped };
}

export function selectByTitle(offers, titleFilter) {
  const matches = buildTitleFilter(titleFilter);
  const kept = [];
  const rejected = [];
  for (const offer of offers) {
    if (matches(offer.title)) kept.push(offer);
    else rejected.push({ url: offer.url, title: offer.title ?? '', reason: 'title' });
  }
  return { kept, rejected };
}

export function selectUnseenOffers(offers, { pipelineText = '', reportText = '', scanHistoryText = '' } = {}) {
  const seenUrls = new Set();
  const seenRoles = new Set();
  for (const url of `${pipelineText}\n${reportText}`.matchAll(/https?:\/\/[^\s|<>)\]]+/g)) {
    seenUrls.add(normalizeUrlForDedup(url[0].replace(/[.,;]+$/, '')));
  }
  for (const line of pipelineText.split('\n')) {
    const role = roleKeyFromPipelineLine(line);
    if (role) seenRoles.add(role);
  }
  for (const line of scanHistoryText.split('\n')) {
    if (!line.trim() || line.startsWith('url\t')) continue;
    const row = parseScanHistoryLine(line);
    if (row.url) seenUrls.add(normalizeUrlForDedup(row.url));
    const role = roleKey(row.company, row.title);
    if (role) seenRoles.add(role);
  }

  const kept = [];
  const duplicates = [];
  for (const offer of offers) {
    const urlKey = normalizeUrlForDedup(offer.url);
    if (seenUrls.has(urlKey)) {
      duplicates.push({ url: offer.url, reason: 'url', company: offer.company, title: offer.title, note: offer.note });
      continue;
    }
    const role = roleKey(offer.company, offer.title);
    if (role && seenRoles.has(role)) {
      duplicates.push({ url: offer.url, reason: 'role', company: offer.company, title: offer.title, note: offer.note });
      continue;
    }
    kept.push(offer);
    seenUrls.add(urlKey);
    if (role) seenRoles.add(role);
  }
  return { kept, duplicates };
}

function roleKey(company, title) {
  const companyKey = normalizeCompanyName(company);
  const titleKey = String(title ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!companyKey || !titleKey) return '';
  return `${companyKey}\n${titleKey}`;
}

function roleKeyFromPipelineLine(line) {
  if (!/^\s*- \[[ x]\]\s+/.test(line)) return '';
  const cells = line.replace(/^\s*- \[[ x]\]\s+/, '').replace(/^~~/, '').split(' | ').map(cell => cell.trim());
  const urlAt = cells.findIndex(cell => /^https?:\/\//.test(cell));
  if (urlAt < 0) return '';
  const company = cells[urlAt + 1] ?? '';
  const title = cells[urlAt + 2] ?? '';
  if (/^skipped\b/i.test(company) || /^(?:posted|trust|note|rank):/i.test(title)) return '';
  return roleKey(company, title);
}

function withPortal(offer) {
  const portal = typeof offer.source === 'string' && offer.source
    ? offer.source
    : String(offer.note ?? '').split(';')[0].trim();
  return { ...offer, source: portal };
}

export async function inletFromSearch({
  endpoint = DEFAULT_ENDPOINT,
  query,
  location,
  providers = PROVIDERS,
  limitPerProvider = 10,
  pipelinePath = PIPELINE_PATH,
  historyPath = SCAN_HISTORY_PATH,
  titleFilter,
  reportText = '',
  fetchImpl = globalThis.fetch,
  dryRun = false,
} = {}) {
  const text = String(query ?? '').trim();
  if (text.length < 2 || text.length > 200) {
    throw new Error('query must be 2–200 characters');
  }
  if (!Array.isArray(providers) || providers.length === 0 || providers.some(provider => !PROVIDERS.includes(provider))) {
    throw new Error('providers must be jobnet, jobbank, jobindex, or jobdanmark');
  }
  const limit = Number(limitPerProvider);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('limitPerProvider must be an integer from 1 to 10');
  }

  const args = { query: text, providers, limitPerProvider: limit, radiusKm: 50 };
  if (typeof location === 'string' && location.trim()) args.location = location.trim();

  const payload = await callDanishSearch(endpoint, args, fetchImpl);
  const parsed = offersFromDanishSearch(payload);
  const titled = titleFilter ? selectByTitle(parsed.offers, titleFilter) : { kept: parsed.offers, rejected: [] };
  const pipelineText = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  const scanHistoryText = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  const { kept, duplicates } = selectUnseenOffers(titled.kept, { pipelineText, reportText, scanHistoryText });
  if (!dryRun && kept.length > 0) {
    const today = localToday();
    await appendToPipeline(kept, { pipelinePath });
    await appendToScanHistory(kept.map(withPortal), today, 'added', { historyPath });
  }
  const recordedUrls = new Set();
  for (const line of scanHistoryText.split('\n')) {
    const row = parseScanHistoryLine(line);
    if (row.url) recordedUrls.add(normalizeUrlForDedup(row.url));
  }
  const freshDuplicates = duplicates.filter(row => row.reason === 'role' && !recordedUrls.has(normalizeUrlForDedup(row.url)));
  if (!dryRun && freshDuplicates.length > 0) {
    await appendToScanHistory(freshDuplicates.map(row => withPortal(row)), localToday(), 'duplicate', { historyPath });
  }
  return {
    added: kept.length,
    lines: kept.map(offer => formatPipelineOffer(offer)),
    duplicates,
    failures: parsed.failures,
    skipped: [...parsed.skipped, ...titled.rejected],
    dryRun,
  };
}

export async function callDanishSearch(endpoint, args, fetchImpl = globalThis.fetch) {
  const url = assertLoopbackJobAgent(endpoint);
  const init = await postRpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'career-ops-job-agent-inlet', version: '1' },
    },
  }, fetchImpl);
  await postRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, fetchImpl, init.session, { allowEmpty: true });
  const response = await postRpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'search_danish_jobs', arguments: args },
  }, fetchImpl, init.session);
  const result = response.rpc?.result;
  if (response.rpc?.error) throw new Error(response.rpc.error.message || 'job-agent rejected the search');
  if (!result || result.isError) {
    const message = Array.isArray(result?.content)
      ? result.content.map(part => part?.text).filter(Boolean).join(' ')
      : '';
    throw new Error(message || 'job-agent search failed');
  }
  const payload = result.structuredContent ?? payloadFromText(result.content);
  if (!payload || !Array.isArray(payload.jobs)) throw new Error('job-agent search returned no jobs array');
  return payload;
}

async function postRpc(url, body, fetchImpl, session, { allowEmpty = false } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (session) headers['mcp-session-id'] = session;
  const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const header = (name) => response.headers?.get?.(name) ?? '';
  const nextSession = header('mcp-session-id') || session || null;
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!text.trim()) {
    if (allowEmpty) return { session: nextSession, rpc: null };
    throw new Error('job-agent returned an empty response');
  }
  const contentType = header('content-type');
  const rpc = contentType.includes('text/event-stream') || text.includes('\ndata:')
    ? parseEventStream(text)
    : JSON.parse(text);
  return { session: nextSession, rpc };
}

function parseEventStream(text) {
  const data = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(line => line && line !== '[DONE]');
  const last = data.at(-1);
  if (!last) throw new Error('job-agent event stream had no JSON payload');
  return JSON.parse(last);
}

function payloadFromText(content) {
  const text = Array.isArray(content) ? content.map(part => part?.text).filter(Boolean).join('\n') : '';
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadTitleFilter(portalsPath) {
  if (!existsSync(portalsPath)) return undefined;
  const doc = yaml.load(readFileSync(portalsPath, 'utf8'));
  return doc && typeof doc === 'object' ? doc.title_filter : undefined;
}

function readReportText(root) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    fromTitles: false,
    endpoint: process.env.JOB_AGENT_MCP || DEFAULT_ENDPOINT,
    limit: 10,
    limitSet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--query') args.query = argv[++i];
    else if (arg === '--location') args.location = argv[++i];
    else if (arg === '--endpoint') args.endpoint = argv[++i];
    else if (arg === '--from-titles') args.fromTitles = true;
    else if (arg === '--limit') {
      args.limit = Number(argv[++i]);
      args.limitSet = true;
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node job-agent-inlet.mjs --query "data engineer" [--location København] [--limit 10] [--dry-run]
       node job-agent-inlet.mjs --from-titles [--limit 5] [--dry-run]

Reads Pending vacancies from a self-hosted job-agent on loopback and appends
them to data/pipeline.md when the title matches title_filter in portals.yml. A new row is also recorded in data/scan-history.tsv.
A later listing with the same URL, or the same employer and title, is not
added again. One query, at most 10 listings per portal. --from-titles runs
each positive title as its own query, at most 5 listings per portal, with a
pause between queries. It does not evaluate or submit. Refuses https://job-agent.dk/mcp.`);
}

function printResult(result, { dryRun, query }) {
  const verb = dryRun ? 'would append' : 'appended';
  console.log(`${query}: ${verb} ${result.added} Pending row(s)`);
  for (const line of result.lines) console.log(line);
  if (result.duplicates.length > 0) {
    console.log(`already recorded ${result.duplicates.length}`);
    for (const row of result.duplicates) console.log(`- ${row.url} | ${row.company} | ${row.title} (${row.reason})`);
  }
  for (const failure of result.failures) console.log(`portal failed: ${failure.provider}: ${failure.error}`);
  for (const skip of result.skipped) console.log(`skipped ${skip.reason}: ${skip.url}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const titleFilter = loadTitleFilter(PORTALS_PATH);
  if (args.fromTitles) {
    const queries = scheduleQueries(titleFilter);
    if (queries.length === 0) {
      console.error('title_filter.positive has no usable queries');
      process.exitCode = 1;
      return;
    }
    const limit = args.limitSet ? args.limit : 5;
    await runScheduledInlet({
      queries,
      runOne: async (query) => {
        const result = await inletFromSearch({
          endpoint: args.endpoint,
          query,
          location: args.location,
          limitPerProvider: limit,
          titleFilter,
          pipelinePath: PIPELINE_PATH,
          reportText: readReportText(getCareerOpsRoot()),
          dryRun: args.dryRun,
        });
        printResult(result, { dryRun: args.dryRun, query });
        return result;
      },
    });
    return;
  }
  if (!args.query) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  const result = await inletFromSearch({
    endpoint: args.endpoint,
    query: args.query,
    location: args.location,
    limitPerProvider: args.limit,
    titleFilter,
    pipelinePath: PIPELINE_PATH,
    reportText: readReportText(getCareerOpsRoot()),
    dryRun: args.dryRun,
  });
  printResult(result, { dryRun: args.dryRun, query: args.query });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
