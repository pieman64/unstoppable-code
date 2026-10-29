import path from 'node:path';
import { isoDay, writeJsonl } from './fsHelpers.mjs';

/**
 * Harness primitive H3 — seed usage-metric events for the Statistics/Usage
 * dashboards.
 *
 * On-disk path:
 *   `agent-observability/usage-events/<day>.jsonl`
 * where `<day>` is the UTC ISO day (`YYYY-MM-DD`) — see
 * `apps/desktop-app/src/main/lib/paths.ts`
 * `getAgentObservabilityUsageEventsDayFilePath` and the service's `toIsoDay`
 * (`apps/desktop-app/src/main/observability/service.ts`).
 *
 * The service reads every `*.jsonl` file in the usage-events dir, splits on
 * `\n`, skips blank lines, parses each as a `UsageMetricEvent`, and applies a
 * retention window keyed off each event's own `timestamp`
 * (`loadUsageEventsInWindow`). So the day in the filename is just a bucket;
 * the event `timestamp` is what's filtered. We default `day` to the most
 * recent event's `timestamp` (or today) so the events fall inside the default
 * retention window.
 *
 * `UsageMetricEvent` shapes live in
 * `packages/desktop-shared/src/types/observability.ts` (discriminated on
 * `type`): `worktree_created`, `worktree_pr_merged`, `worktree_deleted`,
 * `chat_turn_started`/`chat_turn_completed`, `plan_*`,
 * `pipeline_run_started`/`pipeline_run_completed`. Every event shares
 * `{ version: 1, id, type, timestamp, workspaceId, ... }`.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {import('@canopy/desktop-shared/types/observability').UsageMetricEvent[]} options.events
 * @param {string} [options.day] override the `YYYY-MM-DD` bucket filename;
 *   defaults to the latest event timestamp (or today)
 * @returns {{ filePath: string, day: string, events: import('@canopy/desktop-shared/types/observability').UsageMetricEvent[] }}
 */
export function seedUsageEvents(options) {
  const { userDataDir, events, day } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedUsageEvents requires userDataDir');
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('seedUsageEvents requires a non-empty events array');
  }

  const resolvedDay = day ?? deriveDay(events);
  const filePath = path.join(
    userDataDir,
    'agent-observability',
    'usage-events',
    `${resolvedDay}.jsonl`,
  );

  writeJsonl(filePath, events);
  return { filePath, day: resolvedDay, events };
}

function deriveDay(events) {
  let latest = 0;
  for (const event of events) {
    const ms = Date.parse(event?.timestamp ?? '');
    if (Number.isFinite(ms) && ms > latest) {
      latest = ms;
    }
  }
  return isoDay(latest > 0 ? latest : Date.now());
}
