/**
 * Preview a historical-application import from the Jobbing sheets.
 *
 * The command writes nothing. Tracker rows and the scanner stay as they are
 * until the preview is accepted. See career-ops/docs/PERSONAL_CAREER_PIPELINE.md
 * section 12.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCareerOpsRoot, resolveTrackerPathForWrite } from './path-resolver.mjs';
import { acquireTrackerLockForCli, writeFileAtomic } from './tracker-utils.mjs';

const SCORE = '—';
const REPORT = '—';
const PDF = '❌';

const COMMENT_NOTES = [
  { test: (comment) => comment === 'both entry and experienced tracks', note: 'both tracks' },
  { test: (comment) => comment.startsWith('entry level requirements'), note: 'entry-level' },
  { test: (comment) => comment.includes('asks for 5 yrs experience'), note: "five years' experience" },
  { test: (comment) => comment === 'fraud detection & ai solutions', note: 'fraud detection and AI' },
  { test: (comment) => comment === 'similar to a previous application', note: 'a related earlier application' },
  { test: (comment) => comment === 'barselsvikariat', note: 'barselsvikariat' },
  { test: (comment) => comment === 'apply to both schools', note: 'both schools' },
  { test: (comment) => comment === 'pipeline for any related jobs', note: 'a pipeline for related jobs' },
  { test: (comment) => comment === '7-month position', note: 'a 7-month cover' },
  { test: (comment) => comment === '1 year contract', note: 'a 1-year contract' },
  { test: (comment) => comment.includes('fremtidens energisystemer'), note: 'the energy-systems topic' },
  { test: (comment) => comment.startsWith('possibly already has a candidate'), note: 'a candidate possibly already chosen' },
  { test: (comment) => comment === 'near farum', note: 'Near Farum' },
];

/**
 * Parse a CSV string into objects keyed by the header row.
 *
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((record) => record.some((value) => value.trim() !== ''))
    .map((record) => {
      const object = {};
      header.forEach((name, index) => {
        object[name.trim()] = (record[index] ?? '').trim();
      });
      return object;
    });
}

/**
 * Fold a company or title for an exact collision check.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function identityKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9æøå]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read month/day/year into YYYY-MM-DD.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function parseSheetDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param {string} markdown
 * @returns {Array<{num: number, date: string, company: string, role: string, score: string, status: string, notes: string}>}
 */
export function parseTracker(markdown) {
  const rows = [];
  for (const line of String(markdown ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!/^\d+$/.test(cells[0] ?? '')) continue;
    rows.push({
      num: Number(cells[0]),
      date: cells[1] ?? '',
      company: cells[2] ?? '',
      role: cells[3] ?? '',
      score: cells[4] ?? '',
      status: cells[5] ?? '',
      notes: cells[8] ?? '',
    });
  }
  return rows;
}

/**
 * Plan tracker rows from the prior-application sheets.
 *
 * @param {{ sheets: Array<{source: string, csv: string}>, trackerMarkdown: string }} input
 */
export function planHistoricalImport({ sheets, trackerMarkdown }) {
  const tracker = parseTracker(trackerMarkdown);
  const nextNum = tracker.reduce((max, row) => Math.max(max, row.num), 0) + 1;
  const halfspace = tracker.find((row) => identityKey(row.company).includes('accenture') && identityKey(row.role).includes('halfspace'));
  const trackerByKey = new Map(tracker.map((row) => [`${identityKey(row.company)}::${identityKey(row.role)}`, row]));
  const excluded = { notApplied: 0, joke: 0, unknownStatus: 0, undated: 0 };
  const pending = [];
  const conflicts = [];

  sheets.forEach((sheet, sheetIndex) => {
    parseCsv(sheet.csv).forEach((record, rowIndex) => {
      const decision = classify(record);
      if (decision.action === 'exclude') {
        excluded[decision.reason] += 1;
        return;
      }
      const date = parseSheetDate(record.DoA) ?? parseSheetDate(record['Date Added']);
      if (!date) {
        excluded.undated += 1;
        return;
      }
      const company = displayCompany(record.Company);
      const role = record['Job position'].trim();
      const notes = composeNotes({
        outcome: decision.outcome,
        source: sheet.source,
        location: record.Location,
        company,
        url: httpUrl(record.Link),
        comment: decision.comment,
        halfspaceNum: decision.mentionHalfspace ? halfspace?.num : null,
      });
      const key = `${identityKey(company)}::${identityKey(role)}`;
      const existing = trackerByKey.get(key);
      if (existing) {
        conflicts.push({
          num: existing.num,
          company: existing.company,
          role: existing.role,
          score: existing.score,
          status: existing.status,
          notes: joinNotes(existing.notes, withSheetDate(notes, date)),
        });
        return;
      }
      pending.push({
        date,
        company,
        role,
        score: SCORE,
        status: decision.status,
        pdf: PDF,
        report: REPORT,
        notes,
        sheetIndex,
        rowIndex,
      });
    });
  });

  pending.sort((a, b) => a.date.localeCompare(b.date) || a.sheetIndex - b.sheetIndex || a.rowIndex - b.rowIndex);
  const rows = pending.map((row, index) => ({
    num: nextNum + index,
    date: row.date,
    company: row.company,
    role: row.role,
    score: row.score,
    status: row.status,
    pdf: row.pdf,
    report: row.report,
    notes: row.notes,
  }));
  return { rows, conflicts, excluded };
}

/**
 * Render the plan as a markdown preview. This is not the tracker.
 *
 * @param {{ rows: Array<Record<string, string|number>>, conflicts: Array<Record<string, string|number>>, excluded: Record<string, number> }} plan
 * @returns {string}
 */
export function renderPreview(plan) {
  const lines = [
    '# Historical import preview',
    '',
    'Generated by `node historical-import.mjs`. This file is not the tracker. `data/applications.md` and the scanner are unchanged.',
    '',
    '## Counts',
    '',
    `- New rows: ${plan.rows.length}`,
    `- Conflicts: ${plan.conflicts.length}`,
    `- Excluded, not applied: ${plan.excluded.notApplied}`,
    `- Excluded, joke: ${plan.excluded.joke}`,
    `- Excluded, unknown status: ${plan.excluded.unknownStatus}`,
    `- Excluded, no date: ${plan.excluded.undated}`,
    '',
    '## Conflicts',
    '',
  ];
  if (plan.conflicts.length === 0) {
    lines.push('None.', '');
  }
  for (const conflict of plan.conflicts) {
    lines.push(`Tracker #${conflict.num} stays ${conflict.status} at ${conflict.score}.`);
    lines.push(`Company: ${conflict.company}`);
    lines.push(`Role: ${conflict.role}`);
    lines.push(`Note becomes: ${conflict.notes}`);
    lines.push('');
  }
  lines.push('## Proposed rows', '');
  lines.push('| # | Date | Company | Role | Score | Status | PDF | Report | Notes |');
  lines.push('|---|------|---------|------|-------|--------|-----|--------|-------|');
  for (const row of plan.rows) {
    lines.push(`| ${[
      row.num,
      row.date,
      cell(row.company),
      cell(row.role),
      row.score,
      row.status,
      row.pdf,
      row.report,
      cell(row.notes),
    ].join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * @param {Record<string, string>} record
 */
function classify(record) {
  const status = (record.Status ?? '').trim();
  const title = record['Job position'] ?? '';
  const company = record.Company ?? '';
  if (/googooli/i.test(title) || /googooli/i.test(company)) return { action: 'exclude', reason: 'joke' };
  if (status === 'Not applied') return { action: 'exclude', reason: 'notApplied' };
  if (status === 'Screening') return { action: 'keep', status: 'Rejected', outcome: 'last stage: screening', comment: keptComment(record.Comment) };
  if (status === 'Applied') return { action: 'keep', status: 'Rejected', outcome: 'applied but never heard back', comment: keptComment(record.Comment) };
  if (status === '1st interview') {
    return {
      action: 'keep',
      status: 'Rejected',
      outcome: 'last stage: 1st interview',
      comment: keptComment(record.Comment),
      mentionHalfspace: identityKey(company) === 'halfspace',
    };
  }
  if (status === 'Accepted' && identityKey(company) === 'paytjek') {
    return { action: 'keep', status: 'Applied', outcome: 'sheet status Accepted, unpaid internship', comment: '' };
  }
  return { action: 'exclude', reason: 'unknownStatus' };
}

/**
 * @param {unknown} comment
 * @returns {string}
 */
function keptComment(comment) {
  const text = String(comment ?? '').trim().toLowerCase();
  if (!text) return '';
  const match = COMMENT_NOTES.find((rule) => rule.test(text));
  return match ? match.note : '';
}

/**
 * @param {unknown} company
 * @returns {string}
 */
function displayCompany(company) {
  const trimmed = String(company ?? '').trim();
  if (identityKey(trimmed) === 'aleksandra instittutet') return 'Alexandra Instituttet';
  return trimmed;
}

/**
 * @param {unknown} link
 * @returns {string}
 */
function httpUrl(link) {
  const value = String(link ?? '').trim();
  return /^https?:\/\//i.test(value) ? value : '';
}

/**
 * @param {{ outcome: string, source: string, location: string, company: string, url: string, comment: string, halfspaceNum: number|null }} parts
 * @returns {string}
 */
function composeNotes(parts) {
  const segments = [parts.outcome, `source: ${parts.source}`];
  const location = String(parts.location ?? '').trim();
  if (location && identityKey(location) !== identityKey(parts.company)) segments.push(`location: ${location}`);
  if (parts.url) segments.push(`url: ${parts.url}`);
  if (parts.comment) segments.push(parts.comment);
  if (parts.halfspaceNum) segments.push(`tracker #${parts.halfspaceNum}`);
  return segments.join('; ');
}

/**
 * @param {string} notes
 * @param {string} date
 * @returns {string}
 */
function withSheetDate(notes, date) {
  const marker = '; source:';
  const index = notes.indexOf(marker);
  if (index === -1) return `${notes}; sheet date: ${date}`;
  return `${notes.slice(0, index)}; sheet date: ${date}${notes.slice(index)}`;
}

/**
 * @param {string} existing
 * @param {string} addition
 * @returns {string}
 */
function joinNotes(existing, addition) {
  const base = String(existing ?? '').trim();
  return base ? `${base}; ${addition}` : addition;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
}

/**
 * Append the planned rows to a tracker markdown string.
 *
 * A second call sees those rows as existing company-and-title matches, plans
 * no new rows, and returns the markdown unchanged.
 *
 * @param {{ sheets: Array<{source: string, csv: string}>, trackerMarkdown: string }} input
 * @returns {{ markdown: string, applied: boolean, plan: ReturnType<typeof planHistoricalImport> }}
 */
export function applyHistoricalImport({ sheets, trackerMarkdown }) {
  const plan = planHistoricalImport({ sheets, trackerMarkdown });
  if (plan.rows.length === 0) return { markdown: trackerMarkdown, applied: false, plan };
  const lines = String(trackerMarkdown).split('\n');
  let lastData = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/^\|\s*\d+\s*\|/.test(lines[index])) lastData = index;
  }
  if (lastData === -1) throw new Error('Tracker has no data rows');
  const conflict = plan.conflicts[0];
  const head = lines.slice(0, lastData + 1).map((line) => {
    if (conflict && /^\|\s*9\s*\|/.test(line) && Number(line.split('|')[1]) === conflict.num) {
      return replaceLastCell(line, conflict.notes);
    }
    return line;
  });
  const markdown = [...head, ...plan.rows.map(trackerLine), ...lines.slice(lastData + 1)].join('\n');
  return { markdown: markdown.endsWith('\n') ? markdown : `${markdown}\n`, applied: true, plan };
}

/**
 * @param {string} line
 * @param {string} value
 * @returns {string}
 */
function replaceLastCell(line, value) {
  const parts = line.split('|');
  const trailing = line.trimEnd().endsWith('|');
  const index = trailing ? parts.length - 2 : parts.length - 1;
  parts[index] = ` ${cell(value)} `;
  return parts.join('|');
}

/**
 * @param {Record<string, string|number>} row
 * @returns {string}
 */
function trackerLine(row) {
  const values = [row.num, row.date, row.company, row.role, row.score, row.status, row.pdf, row.report, row.notes];
  return `| ${values.map((value) => cell(value)).join(' | ')} |`;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function loadSheets() {
  return ['Jobbing25', 'Jobbing26'].map((source) => ({
    source,
    csv: readFileSync(path.join(here, 'documents/previous', `${source} - Applications.csv`), 'utf8'),
  }));
}

async function runCli() {
  const sheets = loadSheets();
  const trackerPath = resolveTrackerPathForWrite(getCareerOpsRoot());
  const trackerMarkdown = readFileSync(trackerPath, 'utf8');
  if (process.argv.includes('--write')) {
    const failWith = (_code, _name, message) => {
      console.error(message);
      process.exit(1);
    };
    const lock = await acquireTrackerLockForCli(trackerPath, { dryRun: false, failWith });
    try {
      const current = readFileSync(trackerPath, 'utf8');
      const result = applyHistoricalImport({ sheets, trackerMarkdown: current });
      if (!result.applied) {
        console.log('Already applied. Tracker unchanged.');
        return;
      }
      writeFileAtomic(trackerPath, result.markdown);
      console.log(`Appended ${result.plan.rows.length} rows to ${trackerPath}`);
      for (const conflict of result.plan.conflicts) {
        console.log(`#${conflict.num} ${conflict.company} | ${conflict.role} stays ${conflict.status} ${conflict.score}`);
      }
    } finally {
      lock?.release();
    }
    return;
  }
  const plan = planHistoricalImport({ sheets, trackerMarkdown });
  const preview = renderPreview(plan);
  const previewPath = path.join(here, 'documents/previous/import-preview.md');
  writeFileSync(previewPath, preview);
  console.log(`New rows: ${plan.rows.length}`);
  console.log(`Conflicts: ${plan.conflicts.length}`);
  for (const conflict of plan.conflicts) {
    console.log(`#${conflict.num} ${conflict.company} | ${conflict.role} stays ${conflict.status} ${conflict.score}`);
    console.log(conflict.notes);
  }
  console.log(`Preview: ${previewPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
