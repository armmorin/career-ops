import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertLoopbackJobAgent,
  inletFromSearch,
  offersFromDanishSearch,
  runScheduledInlet,
  scheduleQueries,
  selectByTitle,
  selectUnseenOffers,
} from './job-agent-inlet.mjs';

const SEARCH = {
  jobs: [
    {
      provider: 'jobnet',
      providerJobId: '1',
      title: 'Dataanalytiker',
      company: 'Acme A/S',
      location: 'Aarhus',
      postedDate: '2026-09-01',
      deadline: null,
      canonicalUrl: 'https://jobnet.dk/find-job/1',
      alsoFoundOn: ['jobindex'],
    },
    {
      provider: 'jobbank',
      providerJobId: '10',
      title: 'Analytiker',
      company: null,
      location: null,
      postedDate: null,
      deadline: null,
      canonicalUrl: 'https://jobbank.dk/job/10/test',
      alsoFoundOn: [],
    },
    {
      provider: 'jobindex',
      providerJobId: 'closed',
      title: 'Should not enter',
      company: 'Closed',
      location: 'København',
      postedDate: null,
      deadline: null,
      canonicalUrl: 'https://www.stepstone.dk/job/closed',
      alsoFoundOn: [],
    },
  ],
  failures: [{ provider: 'jobdanmark', error: 'temporarily unavailable' }],
  rawCount: 3,
  uniqueCount: 3,
};

test('offersFromDanishSearch keeps a successful portal when another fails and leaves unknown fields unknown', () => {
  const { offers, failures, skipped } = offersFromDanishSearch(SEARCH);

  assert.deepEqual(failures, [{ provider: 'jobdanmark', error: 'temporarily unavailable' }]);
  assert.deepEqual(skipped, [{ url: 'https://www.stepstone.dk/job/closed', reason: 'closed-source' }]);
  assert.deepEqual(offers, [
    {
      url: 'https://jobnet.dk/find-job/1',
      company: 'Acme A/S',
      title: 'Dataanalytiker',
      location: 'Aarhus',
      postedAt: Date.parse('2026-09-01T00:00:00.000Z'),
      note: 'jobnet; also jobindex',
    },
    {
      url: 'https://jobbank.dk/job/10/test',
      company: '',
      title: 'Analytiker',
      note: 'jobbank',
    },
  ]);
  assert.equal('score' in offers[0], false);
});

test('scheduleQueries uses each confirmed title once and keeps going when one search fails', async () => {
  assert.deepEqual(
    scheduleQueries({ positive: ['Data Engineer', 'data engineer', 'AI', 'x', 'word:intern', 3] }),
    ['Data Engineer', 'AI', 'intern'],
  );
  const calls = [];
  const results = await runScheduledInlet({
    queries: ['Data Engineer', 'ML'],
    pauseMs: 0,
    runOne: async (query) => {
      calls.push(query);
      if (query === 'ML') throw new Error('portal down');
      return { added: 1 };
    },
  });
  assert.deepEqual(calls, ['Data Engineer', 'ML']);
  assert.equal(results[0].result.added, 1);
  assert.equal(results[1].error, 'portal down');
});

test('selectByTitle keeps titles on the confirmed list and drops the rest', () => {
  const { kept, rejected } = selectByTitle(
    [
      { url: 'https://jobnet.dk/find-job/1', title: 'Senior Data Engineer' },
      { url: 'https://jobnet.dk/find-job/2', title: 'AI Engineer' },
      { url: 'https://jobnet.dk/find-job/3', title: 'Dataingeniør' },
      { url: 'https://jobnet.dk/find-job/4', title: 'Juridisk forretningskonsulent' },
      { url: 'https://jobnet.dk/find-job/5', title: 'Email coordinator' },
    ],
    { positive: ['Data Engineer', 'AI', 'Dataingeniør'] },
  );
  assert.deepEqual(kept.map(offer => offer.url), [
    'https://jobnet.dk/find-job/1',
    'https://jobnet.dk/find-job/2',
    'https://jobnet.dk/find-job/3',
  ]);
  assert.deepEqual(rejected.map(row => row.reason), ['title', 'title']);
});

test('selectUnseenOffers drops a URL already in the pipeline or a report', () => {
  const { offers } = offersFromDanishSearch(SEARCH);
  const { kept } = selectUnseenOffers(offers, {
    pipelineText: '- [x] #001 | https://jobnet.dk/find-job/1 | Acme A/S | Dataanalytiker | 4.0/5 | PDF ❌\n',
    reportText: '**URL:** https://jobbank.dk/job/10/test\n',
  });
  assert.deepEqual(kept, []);
});

test('selectUnseenOffers drops a different URL for the same employer and title', () => {
  const history = [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
    'https://jobdanmark.dk/job/postdoc\t2026-10-16\tjobdanmark\tPostdoc in Peatland Hydrology\tGEUS Hovedkontor\tadded',
  ].join('\n');
  const offers = [
    {
      url: 'https://www.jobindex.dk/vis-job/geus',
      company: 'GEUS Hovedkontor',
      title: 'postdoc in peatland hydrology',
      note: 'jobindex',
    },
    {
      url: 'https://www.jobindex.dk/vis-job/other',
      company: 'acme a/s',
      title: 'Dataanalytiker',
      note: 'jobindex',
    },
    {
      url: 'https://jobbank.dk/job/blank-a',
      company: '',
      title: 'Analytiker',
      note: 'jobbank',
    },
    {
      url: 'https://jobbank.dk/job/blank-b',
      company: '',
      title: 'Analytiker',
      note: 'jobbank',
    },
  ];
  const { kept, duplicates } = selectUnseenOffers(offers, {
    scanHistoryText: history,
    pipelineText: '- [ ] https://jobnet.dk/find-job/9 | Acme A/S | Dataanalytiker | Aarhus\n',
  });
  assert.deepEqual(kept.map(offer => offer.url), [
    'https://jobbank.dk/job/blank-a',
    'https://jobbank.dk/job/blank-b',
  ]);
  assert.deepEqual(duplicates.map(row => row.reason), ['role', 'role']);
});

test('assertLoopbackJobAgent refuses the hosted endpoint before any request', () => {
  assert.throws(
    () => assertLoopbackJobAgent('https://job-agent.dk/mcp'),
    /loopback/,
  );
  assert.equal(
    assertLoopbackJobAgent('http://127.0.0.1:43104/mcp'),
    'http://127.0.0.1:43104/mcp',
  );
});

test('inletFromSearch appends Pending rows and does not write on a dry run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-agent-inlet-'));
  const pipelinePath = join(dir, 'pipeline.md');
  const historyPath = join(dir, 'scan-history.tsv');
  await writeFile(pipelinePath, '# Pipeline — Pending URLs\n\n## Pending\n\n## Processed\n');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const request = JSON.parse(init.body);
    if (request.method !== 'tools/call') {
      return jsonRpc(request.id ?? null, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } });
    }
    assert.equal(request.params.name, 'search_danish_jobs');
    assert.deepEqual(request.params.arguments.providers, ['jobnet', 'jobbank', 'jobindex', 'jobdanmark']);
    assert.equal(request.params.arguments.limitPerProvider, 10);
    return jsonRpc(request.id, {
      isError: false,
      structuredContent: SEARCH,
    });
  };

  const dry = await inletFromSearch({
    endpoint: 'http://127.0.0.1:43104/mcp',
    query: 'data engineer',
    pipelinePath,
    historyPath,
    fetchImpl,
    dryRun: true,
  });
  assert.equal(dry.added, 2);
  assert.equal(await readFile(pipelinePath, 'utf8'), '# Pipeline — Pending URLs\n\n## Pending\n\n## Processed\n');
  assert.equal(await readFile(historyPath, 'utf8').catch(() => ''), '');

  const written = await inletFromSearch({
    endpoint: 'http://127.0.0.1:43104/mcp',
    query: 'data engineer',
    pipelinePath,
    historyPath,
    fetchImpl,
    dryRun: false,
  });
  assert.equal(written.added, 2);
  const text = await readFile(pipelinePath, 'utf8');
  assert.match(text, /^- \[ \] https:\/\/jobnet\.dk\/find-job\/1 \| Acme A\/S \| Dataanalytiker \| Aarhus \| posted: 2026-09-01 \| note: jobnet; also jobindex$/m);
  assert.match(text, /^- \[ \] https:\/\/jobbank\.dk\/job\/10\/test \| {2}\| Analytiker \| note: jobbank$/m);
  const history = await readFile(historyPath, 'utf8');
  assert.match(history, /^https:\/\/jobnet\.dk\/find-job\/1\t\d{4}-\d{2}-\d{2}\tjobnet\tDataanalytiker\tAcme A\/S\tadded\t/m);
  assert.doesNotMatch(history, /^https:\/\/www\.stepstone\.dk/m);
  assert.doesNotMatch(text, /stepstone/i);
  assert.equal(calls.every(call => call.url === 'http://127.0.0.1:43104/mcp'), true);

  await assert.rejects(
    () => inletFromSearch({
      endpoint: 'https://job-agent.dk/mcp',
      query: 'data engineer',
      pipelinePath,
      fetchImpl,
    }),
    /loopback/,
  );
});

function jsonRpc(id, result) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}
