#!/usr/bin/env node

/**
 * On-demand LinkedIn inlet. Calls a loopback linkedin-mcp-server and appends
 * Pending rows. The only tools used are search_jobs, get_job_details, and
 * get_job_apply_url. Search location is Denmark. Easy Apply is not submitted.
 *
 *   node linkedin-inlet.mjs --query "data engineer" --dry-run
 *
 * Start the server separately, on loopback:
 *   uvx mcp-server-linkedin@latest --transport streamable-http --host 127.0.0.1 --port 8089 --path /mcp
 *
 * Sign-in is a separate human step: uvx mcp-server-linkedin@latest --login
 * The daily timer is scripts/linkedin-inlet-timer.sh. It does not evaluate.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseScanHistoryLine } from './lib/scan-history-columns.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { appendToPipeline, appendToScanHistory, formatPipelineOffer, normalizeUrlForDedup, PIPELINE_PATH, PORTALS_PATH, SCAN_HISTORY_PATH } from './scan.mjs';
import { loadTitleFilter, runScheduledInlet, scheduleQueries, selectByTitle, selectUnseenOffers } from './job-agent-inlet.mjs';

const PERMITTED_TOOLS = new Set(['search_jobs', 'get_job_details', 'get_job_apply_url']);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8089/mcp';

export function assertPermittedLinkedInTool(name) {
  if (!PERMITTED_TOOLS.has(name)) throw new Error(`LinkedIn tool is not permitted: ${name}`);
  return name;
}

export function assertLoopbackLinkedIn(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`LinkedIn endpoint must be a loopback URL, got ${endpoint}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error(`LinkedIn endpoint must be a loopback URL, got ${endpoint}`);
  }
  return url.href;
}

export function linkedInSearchArguments({ keywords } = {}) {
  const query = String(keywords ?? '').trim();
  if (query.length < 2 || query.length > 200) throw new Error('query must be 2–200 characters');
  return {
    keywords: query,
    location: 'Denmark',
    max_pages: 2,
    date_posted: 'past_week',
    job_type: 'full_time',
    experience_level: 'mid_senior',
    sort_by: 'date',
    easy_apply: false,
  };
}

const CARD_NOISE = [
  /^\d+\+?\s+results$/i,
  /^denmark$/i,
  /^how promoted jobs are ranked$/i,
  /^how ai search works$/i,
  /^viewed$/i,
  /^promoted$/i,
  /^be an early applicant$/i,
  /^posted\b/i,
  /^\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago$/i,
  /alumni works? here$/i,
  /^\d+ connections? works? here$/i,
  /^saved$/i,
  /^easy apply$/i,
  /^actively reviewing applicants$/i,
  /^are these results helpful\??$/i,
  /^your feedback helps us improve search results\.?$/i,
  /^see jobs where you[’']re a top applicant$/i,
  /^reactivate premium$/i,
  /^we found more results\b/i,
  /^previous$/i,
  /^next$/i,
  /^\d{1,2}$/,
  /^---+$/,
  /^[·•]$/,
  /^is this information helpful\??$/i,
];

function isCardNoise(line) {
  return CARD_NOISE.some(pattern => pattern.test(line));
}

function cleanCardTitle(line) {
  return line.replace(/^Selected,\s*/i, '').replace(/\s*\(Verified job\)\s*$/i, '').trim();
}

function isTitlePair(lines, index) {
  if (index + 1 >= lines.length) return false;
  const title = cleanCardTitle(lines[index]);
  return title.length > 0 && title === cleanCardTitle(lines[index + 1]);
}

export function cardsFromSearchResults(text, jobIds = []) {
  const lines = String(text ?? '')
    .split(/\n/)
    .map(line => line.trim())
    .filter(line => line && !isCardNoise(line));
  const cards = [];
  let index = 0;
  while (index + 1 < lines.length) {
    let title = '';
    if (isTitlePair(lines, index)) {
      title = cleanCardTitle(lines[index + 1]);
      index += 2;
    } else {
      title = cleanCardTitle(lines[index]);
      index += 1;
    }
    if (index + 1 >= lines.length) break;
    const company = lines[index];
    const location = lines[index + 1];
    index += 2;
    if (!title || isCardNoise(company)) continue;
    cards.push({ title, company, location });
  }
  return cards
    .slice(0, jobIds.length)
    .map((card, cardIndex) => ({ jobId: String(jobIds[cardIndex]), ...card }))
    .filter(card => /^\d+$/.test(card.jobId) && card.title);
}

export function offerFromLinkedInJob({ jobId, card = {}, apply = {} } = {}) {
  const id = String(jobId ?? '').trim();
  if (!/^\d+$/.test(id)) return null;
  const applyType = apply?.apply?.type || '';
  if (applyType === 'closed' || applyType === 'applied') return null;
  const title = textField(card, 'title');
  if (!title) return null;
  const linkedinUrl = `https://www.linkedin.com/jobs/view/${id}`;
  const employerUrl = applyType === 'external' ? employerHttps(apply?.apply?.url) : '';
  const offer = {
    url: employerUrl || linkedinUrl,
    company: textField(card, 'company'),
    title,
    source: 'linkedin',
    note: applyType === 'easy_apply'
      ? `linkedin easy-apply ${linkedinUrl}`
      : `linkedin ${linkedinUrl}`,
  };
  const location = textField(card, 'location');
  if (location) offer.location = location;
  return offer;
}

function textField(source, key) {
  const value = source?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function employerHttps(value) {
  if (typeof value !== 'string') return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  if (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) return '';
  return url.href;
}

export async function inletFromLinkedIn({
  endpoint = DEFAULT_ENDPOINT,
  query,
  pipelinePath = PIPELINE_PATH,
  historyPath = SCAN_HISTORY_PATH,
  reportText = '',
  titleFilter,
  fetchImpl = globalThis.fetch,
  dryRun = false,
} = {}) {
  const args = linkedInSearchArguments({ keywords: query });
  const search = await callLinkedIn(endpoint, 'search_jobs', args, fetchImpl);
  const cards = cardsFromSearchResults(search?.sections?.search_results, search?.job_ids);
  const matching = [];
  const skipped = [];
  for (const card of cards) {
    if (titleFilter && selectByTitle([card], titleFilter).kept.length === 0) {
      skipped.push({ url: `https://www.linkedin.com/jobs/view/${card.jobId}`, title: card.title, reason: 'title' });
      continue;
    }
    matching.push(card);
  }
  const offers = [];
  for (const card of matching) {
    const apply = await callLinkedIn(endpoint, 'get_job_apply_url', { job_id: card.jobId }, fetchImpl);
    const offer = offerFromLinkedInJob({ jobId: card.jobId, card, apply });
    if (offer) offers.push(offer);
  }
  const pipelineText = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  const scanHistoryText = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  const { kept, duplicates } = selectUnseenOffers(offers, { pipelineText, reportText, scanHistoryText });
  if (!dryRun && kept.length > 0) {
    await appendToPipeline(kept, { pipelinePath });
    await appendToScanHistory(kept, localToday(), 'added', { historyPath });
  }
  const recordedUrls = new Set();
  for (const line of scanHistoryText.split('\n')) {
    const row = parseScanHistoryLine(line);
    if (row.url) recordedUrls.add(normalizeUrlForDedup(row.url));
  }
  const freshDuplicates = duplicates.filter(row => row.reason === 'role' && !recordedUrls.has(normalizeUrlForDedup(row.url)));
  if (!dryRun && freshDuplicates.length > 0) {
    await appendToScanHistory(freshDuplicates.map(row => ({ ...row, source: 'linkedin' })), localToday(), 'duplicate', { historyPath });
  }
  return {
    added: kept.length,
    lines: kept.map(offer => formatPipelineOffer(offer)),
    duplicates,
    skipped,
    dryRun,
  };
}

export async function callLinkedIn(endpoint, name, args, fetchImpl = globalThis.fetch) {
  assertPermittedLinkedInTool(name);
  const url = assertLoopbackLinkedIn(endpoint);
  const init = await postRpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'career-ops-linkedin-inlet', version: '1' } },
  }, fetchImpl);
  await postRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, fetchImpl, init.session, { allowEmpty: true });
  const response = await postRpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  }, fetchImpl, init.session);
  if (response.rpc?.error) throw new Error(response.rpc.error.message || 'LinkedIn rejected the call');
  const result = response.rpc?.result;
  if (!result || result.isError) {
    const message = Array.isArray(result?.content) ? result.content.map(part => part?.text).filter(Boolean).join(' ') : '';
    throw new Error(message || 'LinkedIn call failed');
  }
  return result.structuredContent ?? payloadFromText(result.content) ?? {};
}

async function postRpc(url, body, fetchImpl, session, { allowEmpty = false } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (session) headers['mcp-session-id'] = session;
  const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const header = (headerName) => response.headers?.get?.(headerName) ?? '';
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!text.trim()) {
    if (allowEmpty) return { session: header('mcp-session-id') || session || null, rpc: null };
    throw new Error('LinkedIn returned an empty response');
  }
  const rpc = header('content-type').includes('text/event-stream') || text.includes('\ndata:')
    ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(line => line && line !== '[DONE]').at(-1))
    : JSON.parse(text);
  return { session: header('mcp-session-id') || session || null, rpc };
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

function readReportText(root) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter(name => name.endsWith('.md')).map(name => readFileSync(join(dir, name), 'utf8')).join('\n');
}

function parseArgs(argv) {
  const args = { dryRun: false, fromTitles: false, endpoint: process.env.LINKEDIN_MCP || DEFAULT_ENDPOINT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--from-titles') args.fromTitles = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--query') args.query = argv[++i];
    else if (arg === '--endpoint') args.endpoint = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printResult(result, { dryRun, query }) {
  const verb = dryRun ? 'would append' : 'appended';
  const prefix = query ? `${query}: ` : '';
  console.log(`${prefix}${verb} ${result.added} Pending row(s)`);
  for (const line of result.lines) console.log(line);
  for (const row of result.duplicates) console.log(`already recorded: ${row.url}`);
  for (const skip of result.skipped) console.log(`skipped ${skip.reason}: ${skip.url}`);
}

function printHelp() {
  console.log(`Usage: node linkedin-inlet.mjs --query "data engineer" [--dry-run]
       node linkedin-inlet.mjs --from-titles [--dry-run]

Searches LinkedIn in Denmark for the past week: full-time, mid-senior, two pages.
Reads the title, employer, and place from the search cards. A card with no
title is skipped. Uses search_jobs and get_job_apply_url. An employer
application URL becomes the Pending row. The LinkedIn URL stays in the note.
Easy Apply is not submitted. --from-titles runs each positive title, with a
pause between queries. It does not evaluate or submit.`);
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
    await runScheduledInlet({
      queries,
      runOne: async (query) => {
        const result = await inletFromLinkedIn({
          endpoint: args.endpoint,
          query,
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
  const result = await inletFromLinkedIn({
    endpoint: args.endpoint,
    query: args.query,
    titleFilter,
    reportText: readReportText(getCareerOpsRoot()),
    dryRun: args.dryRun,
  });
  printResult(result, { dryRun: args.dryRun });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
