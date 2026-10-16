import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const CHECKOUT = dirname(fileURLToPath(import.meta.url));
const PEOPLE = join(CHECKOUT, 'people.mjs');

function run(args, peopleDir, extra = {}) {
  return spawnSync(process.execPath, [PEOPLE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_PEOPLE_DIR: peopleDir, ...extra },
  });
}

function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('add creates an empty person and leaves the checkout pipeline untouched', async () => {
  const peopleDir = await mkdtemp(join(tmpdir(), 'career-people-'));
  const before = await readFile(join(CHECKOUT, 'data/pipeline.md'), 'utf8');
  try {
    const result = run(['add', 'Ada'], peopleDir);
    assert.equal(result.status, 0, result.stderr);
    const root = join(peopleDir, 'Ada');
    assert.match(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const summary = await readFile(join(root, 'documents/summary/Structured Profile Knowledge Base.md'), 'utf8');
    assert.equal(summary, '# Structured Profile Knowledge Base\n');
    assert.equal(await readFile(join(root, 'cv.md'), 'utf8'), '');
    assert.equal(
      await readFile(join(root, 'config/profile.yml'), 'utf8'),
      'candidate:\n  full_name: ""\n',
    );
    assert.equal(
      await readFile(join(root, 'rules.md'), 'utf8'),
      '# Rules\n\nOnboarding is not accepted. Do not scan, evaluate, or write application text.\n',
    );
    assert.equal(
      await readFile(join(root, 'data/pipeline.md'), 'utf8'),
      '# Pipeline — Pending URLs\n\nPaste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.\n\n## Pending\n',
    );
    assert.equal(
      await readFile(join(root, 'data/applications.md'), 'utf8'),
      '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n',
    );
    assert.equal(
      await readFile(join(root, 'portals.yml'), 'utf8'),
      'title_filter:\n  positive: []\ntracked_companies: []\njob_boards: []\n',
    );
    assert.equal(await readFile(join(root, '.career-ops-person'), 'utf8'), 'Ada\n');
    assert.equal((await stat(join(root, 'reports'))).isDirectory(), true);
    assert.equal((await stat(join(root, 'linkedin-browser-profile'))).isDirectory(), true);
    assert.equal((await stat(join(root, 'job-agent'))).isDirectory(), true);
    assert.equal(await readFile(join(CHECKOUT, 'data/pipeline.md'), 'utf8'), before);
  } finally {
    await rm(peopleDir, { recursive: true, force: true });
  }
});

test('add refuses a second copy, Armando, and a name that leaves the people directory', async () => {
  const peopleDir = await mkdtemp(join(tmpdir(), 'career-people-'));
  const escaped = join(tmpdir(), 'career-people-escape');
  try {
    assert.equal(run(['add', 'Ada'], peopleDir).status, 0);
    const again = run(['add', 'Ada'], peopleDir);
    assert.equal(again.status, 1, again.stdout);
    assert.match(again.stderr, /already exists/);
    assert.equal(
      await readFile(join(peopleDir, 'Ada/documents/summary/Structured Profile Knowledge Base.md'), 'utf8'),
      '# Structured Profile Knowledge Base\n',
    );

    for (const name of ['armando', 'Armando', 'Ada/Bob', 'Ada Bob', '', '.']) {
      const result = run(['add', name], peopleDir);
      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      assert.match(result.stderr, /not a person name/);
    }

    const outside = run(['add', `../${escaped.split('/').pop()}`], peopleDir);
    assert.equal(outside.status, 1);
    assert.equal(existsSync(escaped), false);
  } finally {
    await rm(peopleDir, { recursive: true, force: true });
    await rm(escaped, { recursive: true, force: true });
  }
});

test('launch dry-run keeps a taken port and binds the next free one for that person', async () => {
  const peopleDir = await mkdtemp(join(tmpdir(), 'career-people-'));
  const holder = await holdPort(0);
  const taken = holder.address().port;
  try {
    assert.equal(run(['add', 'Ada'], peopleDir).status, 0);
    const result = run(['launch', 'Ada', '--dry-run'], peopleDir, {
      CAREER_OPS_PORT_FIRST: String(taken),
      CAREER_OPS_PORT_LAST: String(taken + 5),
      CAREER_OPS_ROOT: '/tmp/not-ada',
      CAREER_OPS_TRACKER: '/tmp/not-ada/data/applications.md',
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.person, 'Ada');
    assert.equal(plan.root, join(peopleDir, 'Ada'));
    assert.equal(plan.port, taken + 1);
    assert.equal(plan.replace, false);
    assert.equal(plan.env.CAREER_OPS_ROOT, join(peopleDir, 'Ada'));
    assert.equal(plan.env.CAREER_OPS_CODE_ROOT, CHECKOUT);
    assert.equal(plan.env.CAREER_OPS_PERSON, 'Ada');
    assert.equal(plan.env.CAREER_OPS_WEB_PORT, String(taken + 1));
    assert.equal(plan.env.LINKEDIN_BROWSER_PROFILE, join(peopleDir, 'Ada/linkedin-browser-profile'));
    assert.equal(plan.env.JOB_AGENT_CONFIG, join(peopleDir, 'Ada/job-agent'));
    assert.equal(plan.env.CAREER_OPS_TRACKER, undefined);
    assert.equal(holder.listening, true);
  } finally {
    holder.close();
    await rm(peopleDir, { recursive: true, force: true });
  }
});

test('launch without a name is Armando on this checkout', async () => {
  const peopleDir = await mkdtemp(join(tmpdir(), 'career-people-'));
  try {
    const result = run(['launch', '--dry-run'], peopleDir, {
      CAREER_OPS_ROOT: '/tmp/not-armando',
      CAREER_OPS_TRACKER: '/tmp/not-armando/data/applications.md',
      LINKEDIN_BROWSER_PROFILE: '/tmp/not-armando/linkedin',
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.person, 'Armando');
    assert.equal(plan.root, CHECKOUT);
    assert.equal(plan.env.CAREER_OPS_ROOT, undefined);
    assert.equal(plan.env.CAREER_OPS_TRACKER, undefined);
    assert.equal(plan.env.LINKEDIN_BROWSER_PROFILE, undefined);
    assert.equal(plan.env.JOB_AGENT_CONFIG, undefined);
    assert.equal(plan.env.CAREER_OPS_PERSON, 'Armando');
    assert.equal(plan.env.CAREER_OPS_CODE_ROOT, CHECKOUT);
  } finally {
    await rm(peopleDir, { recursive: true, force: true });
  }
});

test('a full port range replaces only the requested port', async () => {
  const peopleDir = await mkdtemp(join(tmpdir(), 'career-people-'));
  const marker = join(peopleDir, 'started.json');
  const stub = join(peopleDir, 'stub-server.mjs');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.STUB_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  root: process.env.CAREER_OPS_ROOT ?? null,
  person: process.env.CAREER_OPS_PERSON,
  port: process.env.CAREER_OPS_WEB_PORT,
  linkedin: process.env.LINKEDIN_BROWSER_PROFILE,
}));
`);
  const base = 46000 + (process.pid % 500) * 3;
  const children = [];
  for (let port = base; port < base + 3; port += 1) {
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    children.push(child);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    assert.equal(run(['add', 'Ada'], peopleDir).status, 0);
    const preview = run(['launch', 'Ada', '--dry-run'], peopleDir, {
      CAREER_OPS_PORT_FIRST: String(base),
      CAREER_OPS_PORT_LAST: String(base + 2),
    });
    assert.equal(preview.status, 0, preview.stderr);
    const plan = JSON.parse(preview.stdout);
    assert.equal(plan.replace, true);
    assert.equal(plan.port, base);
    assert.equal(children.every((child) => child.exitCode === null), true);

    const started = run(['launch', 'Ada', '--accept-defaults'], peopleDir, {
      CAREER_OPS_PORT_FIRST: String(base),
      CAREER_OPS_PORT_LAST: String(base + 2),
      CAREER_OPS_WEB_SERVER: stub,
      STUB_OUT: marker,
    });
    assert.equal(started.status, 0, started.stderr);
    await new Promise((resolve) => {
      if (children[0].exitCode !== null) resolve();
      else children[0].once('exit', resolve);
    });
    assert.equal(children[1].exitCode, null);
    assert.equal(children[2].exitCode, null);
    const recorded = JSON.parse(await readFile(marker, 'utf8'));
    assert.deepEqual(recorded.argv, ['dev', '-p', String(base)]);
    assert.equal(recorded.root, join(peopleDir, 'Ada'));
    assert.equal(recorded.person, 'Ada');
    assert.equal(recorded.port, String(base));
    assert.equal(recorded.linkedin, join(peopleDir, 'Ada/linkedin-browser-profile'));
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await rm(peopleDir, { recursive: true, force: true });
  }
});

test('a new person cannot launch or scan until onboarding is accepted', async () => {
  const peopleDir = await mkdtemp(join(tmpdir(), 'career-people-'));
  const marker = join(peopleDir, 'started.json');
  const stub = join(peopleDir, 'stub-server.mjs');
  writeFileSync(stub, 'process.exit(0);\n');
  const root = join(peopleDir, 'Ada');
  try {
    assert.equal(run(['add', 'Ada'], peopleDir).status, 0);
    const blocked = run(['launch', 'Ada'], peopleDir, {
      CAREER_OPS_WEB_SERVER: stub,
      STUB_OUT: marker,
      CAREER_OPS_PORT_FIRST: '49111',
      CAREER_OPS_PORT_LAST: '49113',
    });
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stderr, /Onboarding is not accepted/);
    assert.match(blocked.stderr, /Denmark/);
    assert.match(blocked.stderr, /PhD/);
    assert.equal(existsSync(marker), false);

    const scan = spawnSync(process.execPath, [join(CHECKOUT, 'scan.mjs'), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 20000,
    });
    assert.equal(scan.status, 1, scan.stderr);
    assert.match(scan.stderr, /Onboarding is not accepted/);
    const inlet = spawnSync(process.execPath, [join(CHECKOUT, 'job-agent-inlet.mjs'), '--dry-run', '--query', 'data engineer'], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 20000,
    });
    assert.equal(inlet.status, 1, inlet.stderr);
    assert.match(inlet.stderr, /Onboarding is not accepted/);
    const linkedin = spawnSync(process.execPath, [join(CHECKOUT, 'linkedin-inlet.mjs'), '--dry-run', '--query', 'data engineer'], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 20000,
    });
    assert.equal(linkedin.status, 1, linkedin.stderr);
    assert.match(linkedin.stderr, /Onboarding is not accepted/);
    const ats = spawnSync(process.execPath, [join(CHECKOUT, 'scan-ats-full.mjs'), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 20000,
    });
    assert.equal(ats.status, 1, ats.stderr);
    assert.match(ats.stderr, /Onboarding is not accepted/);
    const runner = spawnSync(process.execPath, [join(CHECKOUT, 'web/scripts/scheduled-jobs-runner.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 20000,
    });
    assert.equal(runner.status, 1, runner.stderr);
    assert.match(runner.stderr, /Onboarding is not accepted/);
    assert.equal(
      await readFile(join(root, 'data/pipeline.md'), 'utf8'),
      '# Pipeline — Pending URLs\n\nPaste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.\n\n## Pending\n',
    );

    const accepted = run(['launch', 'Ada', '--accept-defaults', '--phd', 'yes', '--dry-run'], peopleDir, {
      CAREER_OPS_PORT_FIRST: '49111',
      CAREER_OPS_PORT_LAST: '49113',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const profile = yaml.load(await readFile(join(root, 'config/profile.yml'), 'utf8'));
    assert.equal(profile.onboarding.accepted, true);
    assert.equal(profile.onboarding.search_location, 'Denmark');
    assert.equal(profile.language.output, 'en');
    assert.equal(profile.onboarding.letter_language, 'en');
    assert.equal(profile.onboarding.phd_rule, true);
    assert.deepEqual(profile.onboarding.stronger_cities, ['Aarhus', 'Odense', 'Aalborg']);
    assert.deepEqual(profile.onboarding.sources, ['hub']);
    const rules = await readFile(join(root, 'rules.md'), 'utf8');
    assert.match(rules, /Search location: Denmark/);
    assert.match(rules, /CV language: English/);
    assert.match(rules, /Omit them from a CV/);
    assert.match(rules, /Discovery sources on: hub/);

    const revised = run(['launch', 'Ada', '--accept-defaults', '--phd', 'no', '--dry-run'], peopleDir, {
      CAREER_OPS_PORT_FIRST: '49111',
      CAREER_OPS_PORT_LAST: '49113',
    });
    assert.equal(revised.status, 0, revised.stderr);
    const revisedProfile = yaml.load(await readFile(join(root, 'config/profile.yml'), 'utf8'));
    assert.equal(revisedProfile.onboarding.phd_rule, false);

    const open = spawnSync(process.execPath, [join(CHECKOUT, 'scan.mjs'), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 20000,
    });
    assert.equal(open.status, 0, open.stderr);
    assert.doesNotMatch(open.stderr, /Onboarding is not accepted/);
  } finally {
    await rm(peopleDir, { recursive: true, force: true });
  }
});
