import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ingestAlertPostings, postingsFromAlertEml, postingsFromAlertPlain, postingsFromGmail } from './linkedin-alert-mail.mjs';

const DIGEST = `
Your job alert for Back End Developer in Copenhagen

Vil du være med til at forme vores nye AI-enhed som AI-native udvikler?
Trafikstyrelsen
Copenhagen Municipality

19 school alumni
View job: https://www.linkedin.com/comm/jobs/view/4477669707/?trackingId=abc

---------------------------------------------------------

Software Engineer (AI-focused)
TWIND SOLUTIONS
Copenhagen

Apply with resume & profile
View job: https://www.linkedin.com/comm/jobs/view/4477195086/?trackingId=def

---------------------------------------------------------

See all jobs on LinkedIn: https://www.linkedin.com/comm/jobs/search-results/?keywords=Back+End
`;

test('a digest yields one posting per block, not the subject', () => {
  const { postings, skipped } = postingsFromAlertPlain(DIGEST);
  assert.deepEqual(postings.map(row => ({
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
  })), [
    {
      title: 'Vil du være med til at forme vores nye AI-enhed som AI-native udvikler?',
      company: 'Trafikstyrelsen',
      location: 'Copenhagen Municipality',
      url: 'https://www.linkedin.com/jobs/view/4477669707',
    },
    {
      title: 'Software Engineer (AI-focused)',
      company: 'TWIND SOLUTIONS',
      location: 'Copenhagen',
      url: 'https://www.linkedin.com/jobs/view/4477195086',
    },
  ]);
  assert.deepEqual(skipped, []);
});

test('an insight line stays out of the place, and a short block is skipped', () => {
  const text = `
Senior Software Developer
Getinge
Copenhagen

This company is actively hiring
View job: https://www.linkedin.com/comm/jobs/view/4466273265/?trackingId=x

---------------------------------------------------------

Only A Title
Only A Company
View job: https://www.linkedin.com/jobs/view/1111111
`;
  const { postings, skipped } = postingsFromAlertPlain(text);
  assert.deepEqual(postings, [{
    title: 'Senior Software Developer',
    company: 'Getinge',
    location: 'Copenhagen',
    url: 'https://www.linkedin.com/jobs/view/4466273265',
  }]);
  assert.deepEqual(skipped, [{ url: 'https://www.linkedin.com/jobs/view/1111111', reason: 'incomplete' }]);
});

test('an alum variant and a heading still leave the posting', () => {
  const text = `
Software Engineer
Estaid.com
Copenhagen
1 school alum
View job: https://www.linkedin.com/comm/jobs/view/4480135021

---------------------------------------------------------

Jobs similar to Data Engineer at Nordea
Data Engineer til Dansk Boldspil-Union
Dansk Boldspil-Union (DBU)
Brøndby Municipality
View job: https://www.linkedin.com/comm/jobs/view/4472934079
`;
  const { postings, skipped } = postingsFromAlertPlain(text);
  assert.deepEqual(postings.map(row => [row.title, row.company, row.location]), [
    ['Software Engineer', 'Estaid.com', 'Copenhagen'],
    ['Data Engineer til Dansk Boldspil-Union', 'Dansk Boldspil-Union (DBU)', 'Brøndby Municipality'],
  ]);
  assert.deepEqual(skipped, []);
});

test('the saved samples keep each posting title', { skip: !existsSync(new URL('./data/linkedin-alert-samples/jobalerts-noreply.eml', import.meta.url)) }, () => {
  const alert = postingsFromAlertEml(readFileSync(new URL('./data/linkedin-alert-samples/jobalerts-noreply.eml', import.meta.url)));
  const jobs = postingsFromAlertEml(readFileSync(new URL('./data/linkedin-alert-samples/jobs-noreply.eml', import.meta.url)));
  assert.equal(alert.sender, 'jobalerts-noreply@linkedin.com');
  assert.equal(jobs.sender, 'jobs-noreply@linkedin.com');
  assert.deepEqual(alert.postings.map(row => row.title), [
    'Vil du være med til at forme vores nye AI-enhed som AI-native udvikler?',
    'Software Engineer (AI-focused)',
    'Senior Engineer - Financial Services',
    'Junior Software Developer',
    'Senior Software Developer',
    'PHP-udvikler til fremtidens AI-drevne e-commerce-løsninger',
  ]);
  assert.deepEqual(jobs.postings.map(row => row.company), [
    'Laerdal Copenhagen',
    'Trafikstyrelsen',
    'Novonesis',
    'DTU - Technical University of Denmark',
    'Lundbeck',
    'Apylon',
  ]);
  assert.equal(alert.postings[0].note, 'linkedin jobalerts-noreply@linkedin.com https://www.linkedin.com/jobs/view/4477669707');
  assert.equal(jobs.postings[4].location, 'Copenhagen');
  assert.equal(jobs.postings[4].title, 'Data/ML Engineer');
});

test('a hand run appends unseen Pending rows and leaves a dry run unwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linkedin-alert-'));
  const pipelinePath = join(dir, 'pipeline.md');
  const historyPath = join(dir, 'scan-history.tsv');
  await writeFile(pipelinePath, [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '- [ ] https://www.linkedin.com/jobs/view/4477669707 | Trafikstyrelsen | Vil du være med til at forme vores nye AI-enhed som AI-native udvikler? | Copenhagen Municipality',
    '',
    '## Processed',
    '',
  ].join('\n'));
  const postings = [
    {
      title: 'Vil du være med til at forme vores nye AI-enhed som AI-native udvikler?',
      company: 'Trafikstyrelsen',
      location: 'Copenhagen Municipality',
      url: 'https://www.linkedin.com/jobs/view/4477669707',
      source: 'linkedin-mail',
      note: 'linkedin jobalerts-noreply@linkedin.com https://www.linkedin.com/jobs/view/4477669707',
    },
    {
      title: 'Junior Software Developer',
      company: 'Playback CPH',
      location: 'Copenhagen',
      url: 'https://www.linkedin.com/jobs/view/4477802497',
      source: 'linkedin-mail',
      note: 'linkedin jobalerts-noreply@linkedin.com https://www.linkedin.com/jobs/view/4477802497',
    },
    {
      title: 'Data/ML Engineer',
      company: 'Lundbeck',
      location: 'Copenhagen',
      url: 'https://www.linkedin.com/jobs/view/4477198386',
      source: 'linkedin-mail',
      note: 'linkedin jobs-noreply@linkedin.com https://www.linkedin.com/jobs/view/4477198386',
    },
  ];

  const dry = await ingestAlertPostings(postings, {
    pipelinePath,
    historyPath,
    retired: ['junior'],
    dryRun: true,
  });
  assert.equal(dry.added, 1);
  assert.equal(dry.duplicates.length, 1);
  assert.equal(dry.retired.length, 1);
  assert.equal(await readFile(pipelinePath, 'utf8'), [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '- [ ] https://www.linkedin.com/jobs/view/4477669707 | Trafikstyrelsen | Vil du være med til at forme vores nye AI-enhed som AI-native udvikler? | Copenhagen Municipality',
    '',
    '## Processed',
    '',
  ].join('\n'));

  const written = await ingestAlertPostings(postings, { pipelinePath, historyPath, retired: ['junior'] });
  assert.equal(written.added, 1);
  const text = await readFile(pipelinePath, 'utf8');
  assert.match(text, /^- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/4477198386 \| Lundbeck \| Data\/ML Engineer \| Copenhagen \| note: linkedin jobs-noreply@linkedin\.com https:\/\/www\.linkedin\.com\/jobs\/view\/4477198386$/m);
  assert.doesNotMatch(text, /Junior Software Developer/);
  const history = await readFile(historyPath, 'utf8');
  assert.match(history, /4477198386/);
  assert.doesNotMatch(history, /4477802497/);
});

test('gmail reads both senders and keeps the raw message off the token request', async () => {
  const emlFor = (sender) => [
    `From: LinkedIn <${sender}>`,
    'Subject: Example',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Data Engineer',
    'Acme',
    'Copenhagen',
    'View job: https://www.linkedin.com/jobs/view/4477198386',
    '',
  ].join('\r\n');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url: String(url), body });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
    }
    if (String(url).includes('/messages?')) {
      const query = new URL(String(url)).searchParams.get('q');
      const id = query.includes('jobalerts-noreply') ? 'alert-1' : 'jobs-1';
      return { ok: true, status: 200, json: async () => ({ messages: [{ id }] }), text: async () => '' };
    }
    const sender = String(url).includes('/messages/jobs-1')
      ? 'jobs-noreply@linkedin.com'
      : 'jobalerts-noreply@linkedin.com';
    return { ok: true, status: 200, json: async () => ({ raw: Buffer.from(emlFor(sender)).toString('base64url') }), text: async () => '' };
  };

  const result = await postingsFromGmail({
    fetchImpl,
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh-token',
    days: 7,
    maxResults: 50,
  });

  assert.equal(result.postings.length, 2);
  assert.equal(result.postings[0].title, 'Data Engineer');
  assert.equal(result.postings[0].company, 'Acme');
  assert.equal(result.postings[1].note, 'linkedin jobs-noreply@linkedin.com https://www.linkedin.com/jobs/view/4477198386');
  const queries = calls
    .filter(call => call.url.includes('/messages?'))
    .map(call => new URL(call.url).searchParams.get('q'))
    .sort();
  assert.deepEqual(queries, [
    'from:jobalerts-noreply@linkedin.com newer_than:7d',
    'from:jobs-noreply@linkedin.com newer_than:7d',
  ]);
  assert.equal(calls.filter(call => call.url.includes('/messages?')).every(call => new URL(call.url).searchParams.get('maxResults') === '50'), true);
  const tokenCall = calls.find(call => call.url.includes('oauth2.googleapis.com/token'));
  assert.match(tokenCall.body, /refresh_token=refresh-token/);
  assert.equal(tokenCall.url.includes('refresh-token'), false);
});
