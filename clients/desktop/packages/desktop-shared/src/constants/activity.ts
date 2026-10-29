import type { ActivitySectionId } from '../types';

export const DEFAULT_ACTIVITY_SECTION_ORDER: ActivitySectionId[] = [
  'summary',
  'changed-files',
  'pull-request',
  'background-processes',
  'mcp-servers',
  'plugins',
  'plans',
  'pipeline-runs',
  'cost',
  'scripts',
  'hooks',
  'terminals',
  'todo',
  'memory',
  'notes',
  'prompts',
  'attachments',
];

export function isActivitySectionId(value: string): value is ActivitySectionId {
  return (
    value === 'summary' ||
    value === 'changed-files' ||
    value === 'pull-request' ||
    value === 'background-processes' ||
    value === 'plans' ||
    value === 'pipeline-runs' ||
    value === 'cost' ||
    value === 'scripts' ||
    value === 'hooks' ||
    value === 'terminals' ||
    value === 'todo' ||
    value === 'mcp-servers' ||
    value === 'plugins' ||
    value === 'memory' ||
    value === 'notes' ||
    value === 'prompts' ||
    value === 'attachments'
  );
}

/**
 * Normalizes a persisted section order against the current default set.
 * - Filters out stale IDs that no longer exist in defaults
 * - Appends any new default IDs not present in persisted order
 */
export function resolveActivitySectionOrder(
  persisted: ActivitySectionId[] | undefined,
): ActivitySectionId[] {
  if (!persisted || persisted.length === 0) {
    return [...DEFAULT_ACTIVITY_SECTION_ORDER];
  }

  const validIds: Set<ActivitySectionId> = new Set(
    DEFAULT_ACTIVITY_SECTION_ORDER,
  );
  const seen: Set<ActivitySectionId> = new Set();
  const normalized: ActivitySectionId[] = [];

  for (const id of persisted) {
    if (validIds.has(id) && !seen.has(id)) {
      normalized.push(id);
      seen.add(id);
    }
  }

  for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
    if (id === 'cost') continue;
    if (!seen.has(id)) {
      normalized.push(id);
      seen.add(id);
    }
  }

  // A saved order written before Cost existed gets Cost at its canonical
  // work-block position instead of at the tail of the old order. Preserve an
  // explicit Cost position in custom orders.
  if (!seen.has('cost')) {
    const pipelineRunsIndex = normalized.indexOf('pipeline-runs');
    normalized.splice(
      pipelineRunsIndex < 0 ? normalized.length : pipelineRunsIndex + 1,
      0,
      'cost',
    );
  }

  return normalized;
}
