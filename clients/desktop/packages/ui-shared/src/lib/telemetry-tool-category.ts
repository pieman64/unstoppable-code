import type { TelemetryToolCategory } from '@canopy/protocol/telemetry';

/**
 * Brand-neutral display labels for telemetry tool categories.
 *
 * The `canopy` key is retained on the wire for backward compatibility, but it
 * describes first-party tools rather than a product-branded category.
 */
export const TELEMETRY_TOOL_CATEGORY_LABELS = {
  thinking: 'Thinking',
  bash: 'Bash',
  read: 'Read',
  readLines: 'Read lines',
  writeEdit: 'Write/Edit',
  plan: 'Plan',
  fileEdit: 'File edit',
  fileAdd: 'File add',
  fileDelete: 'File delete',
  search: 'Search',
  grep: 'Grep',
  web: 'Web',
  agent: 'Agent',
  workflow: 'Workflow',
  tasks: 'Tasks',
  taskStop: 'Task stop',
  skills: 'Skills',
  monitor: 'Monitor',
  claude: 'Claude',
  scheduleWakeup: 'Schedule wakeup',
  askUser: 'Ask user',
  scriptOutput: 'Script output',
  watcher: 'Watcher',
  canopy: 'Built-in',
  graph: 'Graph',
  appAdvisor: 'App advisor',
  pipelineEditor: 'Pipeline editor',
  mcp: 'MCP',
  other: 'Other',
} as const satisfies Record<TelemetryToolCategory, string>;

function humanizeTelemetryKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeTelemetryToolCategory(category: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(category)) return category;
  return category
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_match, character: string) =>
      character.toUpperCase(),
    );
}

function isTelemetryToolCategory(
  category: string,
): category is TelemetryToolCategory {
  return Object.prototype.hasOwnProperty.call(
    TELEMETRY_TOOL_CATEGORY_LABELS,
    category,
  );
}

/**
 * Return the canonical display label, with a readable fallback for telemetry
 * produced by a newer client.
 */
export function getTelemetryToolCategoryLabel(category: string): string {
  const normalizedCategory = normalizeTelemetryToolCategory(category);
  if (isTelemetryToolCategory(normalizedCategory)) {
    return TELEMETRY_TOOL_CATEGORY_LABELS[normalizedCategory];
  }
  return humanizeTelemetryKey(normalizedCategory);
}
