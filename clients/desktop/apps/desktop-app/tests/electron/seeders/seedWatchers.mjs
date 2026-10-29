import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Harness primitive H6 — seed the App Advisor / pipeline watcher persistence
 * file so the watcher-management UI renders rows from seeded state.
 *
 * On-disk path: `app-advisor-watchers.json` at the data-dir root
 * (`apps/desktop-app/src/main/lib/paths.ts` `getAppAdvisorWatchersFilePath` →
 * `join(getDataDir(), 'app-advisor-watchers.json')`).
 *
 * File shape: `AppAdvisorWatchersFile` (private to
 * `apps/desktop-app/src/main/app-advisor/watchers.ts`):
 *   { version: 1, updatedAt: string, watchers: AppAdvisorWatcher[] }
 * The reader (`AppAdvisorWatcherScheduler.readFile`) requires
 * `version === 1` and an array `watchers`, then filters each entry through
 * `isPersistedWatcher` and runs `normalizePersistedWatcher`.
 *
 * `isPersistedWatcher` (same file) requires, per watcher:
 *   { version: 1, id: string,
 *     trigger: 'worktree_chat_completion' | 'standalone_chat_completion' |
 *       'worktree_pipeline_completion',
 *     status: 'active' | 'firing' | 'fired' | 'delivery_failed',
 *     label: string,
 *     target: { kind: string, ... },
 *     destination: { projectId: string, worktreeId: string, chatId: string, ... },
 *     createdAt: string, updatedAt: string, dedupeKey: string }
 * `AppAdvisorWatcher` / `AppAdvisorWatcherTarget` /
 * `AppAdvisorWatcherDestination` are defined in
 * `packages/desktop-shared/src/types.ts`.
 *
 * Visibility note: renderer surfaces only display `active` and
 * `delivery_failed` watchers (`VISIBLE_STATUSES` in `watchers.ts`; the summary
 * is documented as `active | delivery_failed`). The `firing` status is also
 * special-cased on read: a `firing` watcher older than the delivery-ack
 * timeout, or persisted by a prior process, is rewritten to `delivery_failed`.
 * To keep seeded rows deterministic, default to `active`.
 *
 * This seeder writes watchers verbatim (it does not synthesize targets or
 * destinations) so callers control the exact persisted shape; it only fills in
 * the required scalar fields a caller omits (`version`, `status`, `createdAt`,
 * `updatedAt`, `dedupeKey`, and a generated `id`/`label`). Each resulting entry
 * must already carry a valid `target`/`destination`.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {Array<Partial<import('@canopy/desktop-shared/types').AppAdvisorWatcher>>} options.watchers
 *   watcher definitions; each must supply at least `trigger`, `target`, and
 *   `destination`.
 * @param {string} [options.updatedAt] file-level ISO timestamp; defaults to now
 * @returns {{ filePath: string, file: object }}
 */
export function seedWatchers(options) {
  const { userDataDir, watchers = [], updatedAt } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedWatchers requires userDataDir');
  }
  if (!Array.isArray(watchers)) {
    throw new Error('seedWatchers requires a watchers array');
  }

  const normalizedWatchers = watchers.map((watcher, index) =>
    normalizeWatcher(watcher, index),
  );

  const file = {
    version: 1,
    updatedAt: updatedAt ?? new Date().toISOString(),
    watchers: normalizedWatchers,
  };

  const filePath = path.join(userDataDir, 'app-advisor-watchers.json');
  writeJson(filePath, file);
  return { filePath, file };
}

/**
 * Fill in the required scalar fields the reader's `isPersistedWatcher` guard
 * checks, leaving caller-supplied `target`/`destination`/optional fields
 * untouched.
 *
 * @param {Partial<import('@canopy/desktop-shared/types').AppAdvisorWatcher>} watcher
 * @param {number} index
 * @returns {import('@canopy/desktop-shared/types').AppAdvisorWatcher}
 */
function normalizeWatcher(watcher, index) {
  if (!watcher.trigger) {
    throw new Error('seedWatchers: each watcher requires a trigger');
  }
  if (!watcher.target) {
    throw new Error('seedWatchers: each watcher requires a target');
  }
  if (!watcher.destination) {
    throw new Error('seedWatchers: each watcher requires a destination');
  }

  const id = watcher.id ?? `seeded-watcher-${index + 1}`;
  const createdAt = watcher.createdAt ?? '2026-04-10T12:00:00.000Z';

  return {
    version: 1,
    status: 'active',
    label: `Seeded Watcher ${index + 1}`,
    ...watcher,
    id,
    createdAt,
    updatedAt: watcher.updatedAt ?? createdAt,
    // `dedupeKey` is opaque to consumers; the reader only checks it is a
    // string. A deterministic seeded value keeps re-seeds stable.
    dedupeKey: watcher.dedupeKey ?? `seeded-dedupe-${id}`,
  };
}
