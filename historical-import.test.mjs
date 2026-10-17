import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyHistoricalImport, planHistoricalImport } from './historical-import.mjs';

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 9 | 2026-10-15 | proprty.ai | Data Engineer / Backend Developer | 3.5/5 | Evaluated | ❌ | reports/009.md | Consider |
| 41 | 2026-10-16 | Accenture Nordics | Join Halfspace’s Engineering Team | 3.5/5 | Evaluated | ❌ | reports/041.md | Consider |
`;

const SHEET_25 = `Job position,Status,Company,Date Posted,Date Added,DoA,Deadline,Link,Location,Contact,Comment
Intern Backend Engineer (AI),Accepted,PayTjek,9/1/2025,9/11/2025,9/11/2025,asap!,PayTjek,CPH,Anton anton@paytjek.io,Unpaid Internship
Senior Googooli Baazist,Accepted,GoojeAndOsito,always,forever,everyday,never,www.googoolibaazi.com,home,,The best job
Data Scientist,Not applied,Planday,7/28/2025,8/12/2025,,asap!,Planday,CPH,,
Data Engineer,Applied,Everllence,,7/5/2025,7/17/2025,7/31/2025,Everllence,CPH,secret@example.com,APPLY!
"Senior Specialist, Data and Analytics",Applied,Circle K,7/29/2025,7/31/2025,7/31/2025,8/12/2025,Circle K,,,
Data Engineering Consultant,1st interview,Devoteam,,,6/11/2025,asap!,Devoteam,Aarhus,,
AI Specialist,Screening,Aasted,3/13/2026,3/13/2026,3/16/2026,ASAP,Aasted,Aasted,,Near Farum
Patent Attorney,Watching,Zacco,,7/1/2025,,asap!,Zacco,Aarhus,,
`;

const SHEET_26 = `Priority,Job position,Status,Company,Date Posted,Date Added,DoA,Deadline,Link,Location,Contact,Comment
,Data Engineer / Backend Developer,Screening,proprty.ai,3/13/2026,3/13/2026,,ASAP,https://thehub.io/jobs/abc,CPH,mj@proprty.ai,
,AI Specialist,Screening,Aleksandra Instittutet,3/13/2026,3/13/2026,3/16/2026,ASAP,https://alexandra.example/job,CPH,Mie 20639958,Near Farum
3,AI & Advanced Analytics,1st interview,Halfspace,recurring,3/13/2026,,ASAP,https://www.accenture.com/job,CPH,,
`;

function plan() {
  return planHistoricalImport({
    sheets: [
      { source: 'Jobbing25', csv: SHEET_25 },
      { source: 'Jobbing26', csv: SHEET_26 },
    ],
    trackerMarkdown: TRACKER,
  });
}

test('historical import plans rejected outcomes and leaves the tracker numbers alone', () => {
  const result = plan();
  const titles = result.rows.map((row) => row.role);

  assert.deepEqual(titles, [
    'Data Engineering Consultant',
    'Data Engineer',
    'Senior Specialist, Data and Analytics',
    'Intern Backend Engineer (AI)',
    'AI & Advanced Analytics',
    'AI Specialist',
    'AI Specialist',
  ]);
  assert.equal(result.rows[0].num, 42);
  assert.equal(result.rows[0].date, '2025-06-11');
  assert.equal(result.rows[0].status, 'Rejected');
  assert.equal(result.rows[0].score, '—');
  assert.equal(result.rows[0].pdf, '❌');
  assert.equal(result.rows[0].report, '—');
  assert.equal(result.rows[0].notes, 'last stage: 1st interview; source: Jobbing25; location: Aarhus');

  const everllence = result.rows[1];
  assert.equal(everllence.date, '2025-07-17');
  assert.equal(everllence.notes, 'applied but never heard back; source: Jobbing25; location: CPH');
  assert.equal(everllence.notes.includes('secret@example.com'), false);
  assert.equal(everllence.notes.includes('APPLY'), false);

  const paytjek = result.rows[3];
  assert.equal(paytjek.status, 'Applied');
  assert.equal(paytjek.company, 'PayTjek');
  assert.equal(paytjek.notes, 'sheet status Accepted, unpaid internship; source: Jobbing25; location: CPH');
  assert.equal(paytjek.notes.includes('anton@'), false);

  const halfspace = result.rows[4];
  assert.equal(halfspace.date, '2026-03-13');
  assert.equal(halfspace.status, 'Rejected');
  assert.match(halfspace.notes, /last stage: 1st interview/);
  assert.match(halfspace.notes, /tracker #41/);
  assert.match(halfspace.notes, /https:\/\/www\.accenture\.com\/job/);

  const aasted = result.rows[5];
  assert.equal(aasted.company, 'Aasted');
  assert.equal(aasted.notes, 'last stage: screening; source: Jobbing25; Near Farum');

  const alexandra = result.rows[6];
  assert.equal(alexandra.company, 'Alexandra Instituttet');
  assert.equal(alexandra.date, '2026-03-16');
  assert.match(alexandra.notes, /location: CPH/);
  assert.match(alexandra.notes, /Near Farum/);
  assert.match(alexandra.notes, /https:\/\/alexandra\.example\/job/);
  assert.equal(alexandra.notes.includes('20639958'), false);

  assert.equal(titles.includes('Senior Googooli Baazist'), false);
  assert.equal(titles.includes('Data Scientist'), false);
  assert.equal(titles.includes('Patent Attorney'), false);
  assert.equal(titles.includes('Data Engineer / Backend Developer'), false);
  assert.equal(result.excluded.notApplied, 1);
  assert.equal(result.excluded.joke, 1);
  assert.equal(result.excluded.unknownStatus, 1);
});

test('a repeated company and title stays on the evaluated row', () => {
  const result = plan();
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.equal(conflict.num, 9);
  assert.equal(conflict.status, 'Evaluated');
  assert.equal(conflict.score, '3.5/5');
  assert.equal(conflict.company, 'proprty.ai');
  assert.equal(conflict.role, 'Data Engineer / Backend Developer');
  assert.equal(
    conflict.notes,
    'Consider; last stage: screening; sheet date: 2026-03-13; source: Jobbing26; location: CPH; url: https://thehub.io/jobs/abc',
  );
  assert.equal(conflict.notes.includes('mj@proprty.ai'), false);
});

test('apply appends the planned rows once', () => {
  const input = {
    sheets: [
      { source: 'Jobbing25', csv: SHEET_25 },
      { source: 'Jobbing26', csv: SHEET_26 },
    ],
    trackerMarkdown: TRACKER,
  };
  const first = applyHistoricalImport(input);
  assert.equal(first.applied, true);
  assert.match(first.markdown, /\| 42 \| 2025-06-11 \| Devoteam \|/);
  assert.match(first.markdown, /Consider; last stage: screening; sheet date: 2026-03-13/);
  assert.equal(first.markdown.includes('| 9 |'), true);
  const second = applyHistoricalImport({ ...input, trackerMarkdown: first.markdown });
  assert.equal(second.applied, false);
  assert.equal(second.markdown, first.markdown);
});

test('the previous sheets yield 119 new rows and the proprty.ai conflict', () => {
  const root = new URL('.', import.meta.url);
  const result = planHistoricalImport({
    sheets: [
      { source: 'Jobbing25', csv: readFileSync(new URL('./documents/previous/Jobbing25 - Applications.csv', root), 'utf8') },
      { source: 'Jobbing26', csv: readFileSync(new URL('./documents/previous/Jobbing26 - Applications.csv', root), 'utf8') },
    ],
    trackerMarkdown: readFileSync(new URL('./data/applications.md', root), 'utf8'),
  });

  assert.equal(result.rows.length, 119);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].num, 9);
  assert.equal(result.excluded.notApplied, 19);
  assert.equal(result.excluded.joke, 0);
  assert.equal(result.rows.filter((row) => row.status === 'Applied').length, 1);
  assert.equal(result.rows.filter((row) => row.status === 'Rejected').length, 118);
  assert.equal(result.rows[0].num, 57);
  assert.equal(result.rows.at(-1).num, 175);
});
