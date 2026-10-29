import path from 'node:path';
import { writeJson, writeJsonl } from './fsHelpers.mjs';

/**
 * Seed the automations store.
 *
 * On-disk path: `automations.json` at the data-dir root
 * (`apps/desktop-app/src/main/lib/paths.ts` `getAutomationsFilePath`).
 *
 * Shape (`AutomationsFile`, defined in
 * `apps/desktop-app/src/main/automations/service.ts`):
 *   { version: 1, updatedAt: string, activities: ScheduledActivity[],
 *     recentRuns: ScheduledActivityRun[] }
 *
 * The service's `readFile` requires `version === 1`, then filters
 * `activities` through `isPersistedActivity` and `recentRuns` through
 * `isPersistedRun`. A valid `ScheduledActivity` needs
 * `{ version: 1, id, name (non-empty), enabled, schedule, action, createdAt,
 *   updatedAt, failureCount }` with valid ISO date strings; `ScheduledActivity`
 * / `ScheduledActivityRun` / `AutomationTrigger` / `AutomationAction` are
 * defined in `packages/desktop-shared/src/types.ts`.
 *
 * This seeder writes the activities/runs verbatim (it does not synthesize
 * schedules/actions) so callers stay in control of the exact persisted shape;
 * each activity must already be a valid `ScheduledActivity`.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {import('@canopy/desktop-shared/types').ScheduledActivity[]} options.activities
 * @param {import('@canopy/desktop-shared/types').ScheduledActivityRun[]} [options.recentRuns]
 * @param {Record<string, import('@canopy/desktop-shared/types').ScheduledActivityRun[]>} [options.archivedRunsByActivity]
 *   durable history keyed by activity id. This writes the per-activity JSONL
 *   files directly so fixtures can exceed the 100-row global hot window.
 * @param {string} [options.updatedAt] ISO timestamp; defaults to now
 * @returns {{ filePath: string, file: object }}
 */
export function seedAutomations(options) {
  const {
    userDataDir,
    activities = [],
    recentRuns = [],
    archivedRunsByActivity = {},
    updatedAt,
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedAutomations requires userDataDir');
  }
  if (!Array.isArray(activities)) {
    throw new Error('seedAutomations requires an activities array');
  }

  const file = {
    version: 1,
    updatedAt: updatedAt ?? new Date().toISOString(),
    activities,
    recentRuns,
  };

  const filePath = path.join(userDataDir, 'automations.json');
  writeJson(filePath, file);
  const archiveFilePaths = {};
  for (const [activityId, runs] of Object.entries(archivedRunsByActivity)) {
    if (!/^[A-Za-z0-9_-]+$/.test(activityId)) {
      throw new Error(`Invalid automation archive activity id: ${activityId}`);
    }
    if (!Array.isArray(runs)) {
      throw new Error(`Archive runs for ${activityId} must be an array`);
    }
    const archiveFilePath = path.join(
      userDataDir,
      'automation-runs',
      `${activityId}.jsonl`,
    );
    writeJsonl(archiveFilePath, runs);
    archiveFilePaths[activityId] = archiveFilePath;
  }
  return { filePath, file, archiveFilePaths };
}
