import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertPermittedLinkedInTool,
  cardsFromSearchResults,
  linkedInSearchArguments,
  offerFromLinkedInJob,
} from './linkedin-inlet.mjs';

test('offerFromLinkedInJob uses an employer URL and keeps the LinkedIn URL as provenance', () => {
  const offer = offerFromLinkedInJob({
    jobId: '4252026496',
    card: { title: 'Data Engineer', company: 'Tryg', location: 'Ballerup' },
    apply: { apply: { type: 'external', url: 'https://careers.tryg.com/job/1' } },
  });
  assert.equal(offer.url, 'https://careers.tryg.com/job/1');
  assert.equal(offer.title, 'Data Engineer');
  assert.equal(offer.company, 'Tryg');
  assert.equal(offer.location, 'Ballerup');
  assert.equal(offer.note, 'linkedin https://www.linkedin.com/jobs/view/4252026496');
  assert.equal('score' in offer, false);
});

test('offerFromLinkedInJob keeps Easy Apply on the LinkedIn URL', () => {
  const offer = offerFromLinkedInJob({
    jobId: '99',
    card: { title: 'Data Engineer' },
    apply: { apply: { type: 'easy_apply' } },
  });
  assert.equal(offer.url, 'https://www.linkedin.com/jobs/view/99');
  assert.equal(offer.company, '');
  assert.equal(offer.title, 'Data Engineer');
  assert.equal('location' in offer, false);
  assert.match(offer.note, /easy-apply/);
  assert.match(offer.note, /linkedin\.com\/jobs\/view\/99/);
});

test('offerFromLinkedInJob drops a closed posting', () => {
  assert.equal(offerFromLinkedInJob({
    jobId: '99',
    details: {},
    apply: { apply: { type: 'closed' } },
  }), null);
});

test('linkedInSearchArguments uses the locked Denmark search', () => {
  assert.deepEqual(linkedInSearchArguments({ keywords: 'data engineer', location: 'Aarhus', easyApply: true, maxPages: 8 }), {
    keywords: 'data engineer',
    location: 'Denmark',
    max_pages: 2,
    date_posted: 'past_week',
    job_type: 'full_time',
    experience_level: 'mid_senior',
    sort_by: 'date',
    easy_apply: false,
  });
  assert.equal('work_type' in linkedInSearchArguments({ keywords: 'data engineer' }), false);
});

test('cardsFromSearchResults reads title, employer, and place from the card text', () => {
  const text = [
    '99+ results',
    'Denmark',
    'How promoted jobs are ranked',
    'How AI search works',
    'Selected, Data Engineer',
    'Data Engineer',
    'Nordea',
    'Copenhagen (Hybrid)',
    '130 school alumni work here',
    'Posted 2 days ago',
    'Data Platform Engineer – Offshore Wind Industry (Verified job)',
    'Data Platform Engineer – Offshore Wind Industry',
    'Cadeler',
    'Vejle (On-site)',
    'AI & Data Engineer',
    'Accenture Nordics',
    'Copenhagen',
    'Is this information helpful?',
  ].join('\n');
  assert.deepEqual(cardsFromSearchResults(text, ['11', '22', '33', '44']), [
    { jobId: '11', title: 'Data Engineer', company: 'Nordea', location: 'Copenhagen (Hybrid)' },
    { jobId: '22', title: 'Data Platform Engineer – Offshore Wind Industry', company: 'Cadeler', location: 'Vejle (On-site)' },
    { jobId: '33', title: 'AI & Data Engineer', company: 'Accenture Nordics', location: 'Copenhagen' },
  ]);
});

test('cardsFromSearchResults keeps a single title aligned past insights and page chrome', () => {
  const text = [
    'Experienced Data Platform Engineer - Data Foundation - Aarhus or Gdansk',
    'Arla Foods',
    'Aarhus',
    '1 connection works here',
    'Viewed',
    'Application developer with an interest in the green energy transition',
    'Nordic RCC',
    'Copenhagen',
    'Saved',
    'Data Engineer',
    'WPP',
    'Copenhagen (Hybrid)',
    'Easy Apply',
    'Senior Data Engineer',
    'itm8 Danmark',
    'Aalborg (On-site)',
    'Are these results helpful?',
    'Your feedback helps us improve search results.',
    'See jobs where you’re a top applicant',
    'Reactivate Premium',
    '1',
    '2',
    'Next',
    '---',
    '99+ results',
    'Denmark',
    'Selected, Team Lead Data Engineering - Snowflake / AWS',
    'Team Lead Data Engineering - Snowflake / AWS',
    'EPAM Systems',
    'Copenhagen (Hybrid)',
    'Actively reviewing applicants',
  ].join('\n');
  assert.deepEqual(cardsFromSearchResults(text, ['1', '2', '3', '4', '5']), [
    { jobId: '1', title: 'Experienced Data Platform Engineer - Data Foundation - Aarhus or Gdansk', company: 'Arla Foods', location: 'Aarhus' },
    { jobId: '2', title: 'Application developer with an interest in the green energy transition', company: 'Nordic RCC', location: 'Copenhagen' },
    { jobId: '3', title: 'Data Engineer', company: 'WPP', location: 'Copenhagen (Hybrid)' },
    { jobId: '4', title: 'Senior Data Engineer', company: 'itm8 Danmark', location: 'Aalborg (On-site)' },
    { jobId: '5', title: 'Team Lead Data Engineering - Snowflake / AWS', company: 'EPAM Systems', location: 'Copenhagen (Hybrid)' },
  ]);
});

test('offerFromLinkedInJob drops a card with no title', () => {
  assert.equal(offerFromLinkedInJob({
    jobId: '99',
    card: { company: 'Nordea' },
    apply: { apply: { type: 'easy_apply' } },
  }), null);
});

test('assertPermittedLinkedInTool refuses send and inbox tools', () => {
  assert.equal(assertPermittedLinkedInTool('search_jobs'), 'search_jobs');
  assert.throws(() => assertPermittedLinkedInTool('send_message'), /not permitted/);
  assert.throws(() => assertPermittedLinkedInTool('connect_with_person'), /not permitted/);
  assert.throws(() => assertPermittedLinkedInTool('get_inbox'), /not permitted/);
});
