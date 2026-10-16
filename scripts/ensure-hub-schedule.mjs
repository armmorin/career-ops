#!/usr/bin/env node
/**
 * Creates the daily Hub and employer-board scan if it is missing.
 * Leaves an existing job's next run alone, so a timer firing at 07:15
 * still sees that run as due.
 */
import { scheduledStorePath } from '../web/src/lib/scheduled-runner-path.mjs';
import { readScheduledStore, writeScheduledStoreAtomic } from '../web/src/lib/scheduled-jobs-store.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

export const HUB_SCAN_JOB_ID = 'c0ffee00-0715-4a15-8c00-000000000001';
const START_AT = '2026-10-17T05:15:00.000Z';

export function ensureHubSchedule(store, now = new Date().toISOString()) {
  if (store.jobs.some(job => job.id === HUB_SCAN_JOB_ID)) return false;
  store.jobs.push({
    id: HUB_SCAN_JOB_ID,
    name: 'Hub and employer boards',
    status: 'active',
    engine: 'portals',
    every: 1,
    unit: 'days',
    timezone: 'Europe/Copenhagen',
    startAt: START_AT,
    nextRunAt: START_AT,
    createdAt: now,
    updatedAt: now,
    filters: { sinceDays: 7 },
  });
  return true;
}

function main() {
  const storePath = scheduledStorePath(getCareerOpsRoot());
  const store = readScheduledStore(storePath);
  if (!ensureHubSchedule(store)) return;
  writeScheduledStoreAtomic(storePath, store);
}

if (isMainModule(import.meta.url)) main();
