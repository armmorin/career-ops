#!/usr/bin/env node
// people.mjs — add, launch, and onboard a named person on this machine.
// The checkout stays Armando's root when CAREER_OPS_ROOT is unset.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

export const PEOPLE_DIR = process.env.CAREER_OPS_PEOPLE_DIR
  ? resolve(process.env.CAREER_OPS_PEOPLE_DIR)
  : '/home/armando/career-people';

const SUMMARY = '# Structured Profile Knowledge Base\n';
const PROFILE = 'candidate:\n  full_name: ""\n';
const RULES = `# Rules

Onboarding is not accepted. Do not scan, evaluate, or write application text.
`;
const PIPELINE = '# Pipeline — Pending URLs\n\nPaste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.\n\n## Pending\n';
const APPLICATIONS = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n';
const PORTALS = 'title_filter:\n  positive: []\ntracked_companies: []\njob_boards: []\n';
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Create an empty data root for one person. Writes templates only.
 * @param {string} name
 * @param {string} [peopleDir]
 * @returns {string} Absolute path of the new root
 */
export function addPerson(name, peopleDir = PEOPLE_DIR) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.toLowerCase() === 'armando') {
    throw new Error(`"${name}" is not a person name. Use one word of letters, digits, and hyphens.`);
  }
  const root = join(peopleDir, name);
  if (existsSync(root)) {
    throw new Error(`${root} already exists.`);
  }
  mkdirSync(join(root, 'documents/summary'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'linkedin-browser-profile'), { recursive: true });
  mkdirSync(join(root, 'job-agent'), { recursive: true });
  writeFileSync(join(root, 'documents/summary/Structured Profile Knowledge Base.md'), SUMMARY);
  writeFileSync(join(root, 'cv.md'), '');
  writeFileSync(join(root, 'config/profile.yml'), PROFILE);
  writeFileSync(join(root, 'rules.md'), RULES);
  writeFileSync(join(root, 'data/pipeline.md'), PIPELINE);
  writeFileSync(join(root, 'data/applications.md'), APPLICATIONS);
  writeFileSync(join(root, 'portals.yml'), PORTALS);
  writeFileSync(join(root, '.career-ops-person'), `${name}\n`);
  return root;
}

const CLEARED_ENV = [
  'CAREER_OPS_ROOT',
  'CAREER_OPS_DATA_DIR',
  'CAREER_OPS_TRACKER',
  'CAREER_OPS_PORTALS',
  'CAREER_OPS_PROFILE',
  'CAREER_OPS_PIPELINE',
  'CAREER_OPS_SCAN_HISTORY',
  'LINKEDIN_BROWSER_PROFILE',
  'JOB_AGENT_CONFIG',
];

export function portIsTaken(port) {
  const out = execFileSync('ss', ['-H', '-ltn', `sport = :${port}`], { encoding: 'utf8' });
  return out.trim().length > 0;
}

export function selectListenPort({ requested, first, last, isTaken }) {
  if (!Number.isInteger(requested) || requested < first || requested > last) {
    throw new Error(`port ${requested} is outside ${first}-${last}`);
  }
  for (let port = requested; port <= last; port += 1) {
    if (!isTaken(port)) return { port, replace: false };
  }
  return { port: requested, replace: true };
}

const LANGUAGE_NAME = { en: 'English', da: 'Danish' };
const SOURCE_NAMES = new Set(['hub', 'employers', 'job-agent', 'linkedin']);

export function personScanBlock(root) {
  const marker = join(root, '.career-ops-person');
  if (!existsSync(marker)) return null;
  let profile = {};
  try {
    profile = yaml.load(readFileSync(join(root, 'config/profile.yml'), 'utf8')) || {};
  } catch {
    profile = {};
  }
  if (profile?.onboarding?.accepted === true) return null;
  const name = readFileSync(marker, 'utf8').trim() || 'this person';
  return `Onboarding is not accepted for ${name}. Do not scan or evaluate.`;
}

function parseList(value) {
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

export function acceptPerson(root, flags) {
  if (!flags.acceptDefaults) {
    throw new Error('pass --accept-defaults, then add any answer you want to change');
  }
  const location = flags.location || 'Denmark';
  const cvLanguage = flags.cvLanguage || 'en';
  const letterLanguage = flags.letterLanguage || 'en';
  if (!location.trim()) throw new Error('search location is empty');
  if (!LANGUAGE_NAME[cvLanguage]) throw new Error('CV language must be en or da');
  if (!LANGUAGE_NAME[letterLanguage]) throw new Error('cover-letter language must be en or da');
  let phd = false;
  if (flags.phd !== undefined) {
    if (flags.phd === 'yes') phd = true;
    else if (flags.phd === 'no') phd = false;
    else throw new Error('--phd must be yes or no');
  }
  const strongerCities = flags.strongerCities === undefined
    ? ['Aarhus', 'Odense', 'Aalborg']
    : flags.strongerCities === 'none' ? [] : parseList(flags.strongerCities);
  const sources = parseList(flags.sources === undefined ? 'hub' : flags.sources).map((source) => source.toLowerCase());
  for (const source of sources) {
    if (!SOURCE_NAMES.has(source)) throw new Error(`unknown discovery source: ${source}`);
  }
  const profilePath = join(root, 'config/profile.yml');
  const current = yaml.load(readFileSync(profilePath, 'utf8')) || {};
  const next = {
    ...current,
    candidate: current.candidate || { full_name: '' },
    location: { ...(current.location || {}), country: location },
    language: { ...(current.language || {}), output: cvLanguage },
    onboarding: {
      accepted: true,
      search_location: location,
      cv_language: cvLanguage,
      letter_language: letterLanguage,
      phd_rule: phd,
      stronger_cities: strongerCities,
      sources,
    },
  };
  writeFileSync(profilePath, yaml.dump(next));
  const phdLine = phd
    ? 'PhD training and postdoctoral training stay in the summary. Omit them from a CV, professional summary, or cover letter unless the posting requires that credential or the user asks.'
    : 'The PhD and postdoctoral rule does not apply.';
  const cityLine = strongerCities.length === 0
    ? 'No stronger-city bar is in force.'
    : `${strongerCities.join(', ')} use the stronger-city bar.`;
  writeFileSync(join(root, 'rules.md'), `# Rules

Onboarding accepted.

- Search location: ${location}.
- CV language: ${LANGUAGE_NAME[cvLanguage]}.
- Cover-letter language: ${LANGUAGE_NAME[letterLanguage]}. When a posting names a language, use that language.
- ${phdLine}
- ${cityLine}
- Discovery sources on: ${sources.join(', ')}.
- This person's summary is the only evidence. Nothing is fabricated. A human submits.
- The tracker is data/applications.md, data/pipeline.md, and reports/.
- Cover letters use the existing cover mode.
`);
}

function onboardingPrompt(name) {
  return `Onboarding is not accepted for ${name}. Answer these before the server starts:
- search location (starting answer: Denmark) --location
- CV language (starting answer: en) --cv-language
- cover-letter language (starting answer: en) --letter-language
- PhD and postdoc rule applies (starting answer: no) --phd yes|no
- stronger-city bar (starting answer: Aarhus,Odense,Aalborg) --stronger-cities
- discovery sources on (starting answer: hub) --sources
Re-run with --accept-defaults to take those starting answers, or add the flags you want to change.`;
}

function listeningPid(port) {
  const out = execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' });
  const match = out.match(/pid=(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Decide the process environment for one person. Does not start the server.
 * @param {object} options
 * @returns {{person: string, root: string, port: number, replace: boolean, env: Record<string, string>, spawnEnv: NodeJS.ProcessEnv, argv: string[]}}
 */
export function planLaunch({
  name,
  peopleDir = PEOPLE_DIR,
  codeRoot = CODE_ROOT,
  requested,
  first,
  last,
  isTaken = portIsTaken,
  parentEnv = process.env,
}) {
  const person = name || 'Armando';
  let root = codeRoot;
  if (person !== 'Armando') {
    if (!NAME_RE.test(person)) {
      throw new Error(`"${person}" is not a person name. Use one word of letters, digits, and hyphens.`);
    }
    root = join(peopleDir, person);
    if (!existsSync(join(root, '.career-ops-person'))) {
      throw new Error(`${root} does not exist. Run: node people.mjs add ${person}`);
    }
  }
  const choice = selectListenPort({ requested, first, last, isTaken });
  const spawnEnv = { ...parentEnv };
  for (const key of CLEARED_ENV) delete spawnEnv[key];
  spawnEnv.CAREER_OPS_CODE_ROOT = codeRoot;
  spawnEnv.CAREER_OPS_PERSON = person;
  spawnEnv.CAREER_OPS_WEB_PORT = String(choice.port);
  if (person !== 'Armando') {
    spawnEnv.CAREER_OPS_ROOT = root;
    spawnEnv.LINKEDIN_BROWSER_PROFILE = join(root, 'linkedin-browser-profile');
    spawnEnv.JOB_AGENT_CONFIG = join(root, 'job-agent');
  }
  const env = {
    CAREER_OPS_CODE_ROOT: spawnEnv.CAREER_OPS_CODE_ROOT,
    CAREER_OPS_PERSON: spawnEnv.CAREER_OPS_PERSON,
    CAREER_OPS_WEB_PORT: spawnEnv.CAREER_OPS_WEB_PORT,
  };
  if (spawnEnv.CAREER_OPS_ROOT) env.CAREER_OPS_ROOT = spawnEnv.CAREER_OPS_ROOT;
  if (spawnEnv.LINKEDIN_BROWSER_PROFILE) env.LINKEDIN_BROWSER_PROFILE = spawnEnv.LINKEDIN_BROWSER_PROFILE;
  if (spawnEnv.JOB_AGENT_CONFIG) env.JOB_AGENT_CONFIG = spawnEnv.JOB_AGENT_CONFIG;
  return {
    person,
    root,
    port: choice.port,
    replace: choice.replace,
    env,
    spawnEnv,
    argv: ['dev', '-p', String(choice.port)],
  };
}

const USAGE = 'Usage: node people.mjs add <name> | launch [name] [--port N] [--dry-run] [--accept-defaults]';

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((arg) => arg !== '--dry-run');
  const command = rest[0];
  const flags = { acceptDefaults: false };
  let name;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--accept-defaults') {
      flags.acceptDefaults = true;
    } else if (arg === '--port') {
      flags.port = Number(rest[++i]);
    } else if (arg === '--location') {
      flags.location = rest[++i];
    } else if (arg === '--cv-language') {
      flags.cvLanguage = rest[++i];
    } else if (arg === '--letter-language') {
      flags.letterLanguage = rest[++i];
    } else if (arg === '--phd') {
      flags.phd = rest[++i];
    } else if (arg === '--stronger-cities') {
      flags.strongerCities = rest[++i];
    } else if (arg === '--sources') {
      flags.sources = rest[++i];
    } else if (!name) {
      name = arg;
    } else {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
  }
  try {
    if (command === 'add') {
      console.log(addPerson(name ?? ''));
      return;
    }
    if (command === 'launch') {
      const first = Number(process.env.CAREER_OPS_PORT_FIRST || 3000);
      const last = Number(process.env.CAREER_OPS_PORT_LAST || 3099);
      const plan = planLaunch({
        name,
        requested: flags.port ?? first,
        first,
        last,
      });
      if (plan.person !== 'Armando') {
        if (flags.acceptDefaults) acceptPerson(plan.root, flags);
        else if (!dryRun && personScanBlock(plan.root)) {
          console.error(onboardingPrompt(plan.person));
          process.exitCode = 1;
          return;
        }
      }
      if (dryRun) {
        console.log(JSON.stringify({
          person: plan.person,
          root: plan.root,
          port: plan.port,
          replace: plan.replace,
          env: plan.env,
        }));
        return;
      }
      if (plan.replace) {
        const pid = listeningPid(plan.port);
        if (!pid) throw new Error(`no process is listening on ${plan.port}`);
        process.kill(pid, 'SIGTERM');
      }
      const server = process.env.CAREER_OPS_WEB_SERVER || join(CODE_ROOT, 'web/server.mjs');
      const child = spawnSync(process.execPath, [server, ...plan.argv], {
        cwd: CODE_ROOT,
        env: plan.spawnEnv,
        stdio: 'inherit',
      });
      process.exitCode = child.status ?? 1;
      return;
    }
    console.error(USAGE);
    process.exitCode = 1;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
