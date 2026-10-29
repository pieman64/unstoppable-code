import type { StatusBadgeVariant } from '@canopy/ui-shared';

/**
 * Friendly-label and badge-variant helpers for the raw UPPERCASE telemetry
 * enum values carried on {@link import('@canopy/protocol/telemetry').TelemetryExpensiveRun}.
 *
 * The wire contract intentionally passes the Postgres enum strings through
 * unchanged (see `getMostExpensiveRuns`), so the display layer owns the mapping
 * to human-readable text. All helpers are pure and fall back gracefully when an
 * unknown value is encountered.
 */

/** Title-case a snake/UPPER enum string, e.g. `WORKTREE_CHAT` → "Worktree Chat". */
function titleCaseEnum(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

const EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  WORKTREE_CHAT: 'Worktree chat',
  STANDALONE_CHAT: 'Standalone chat',
  APP_ADVISOR: 'App Advisor',
  PIPELINE_EDITOR: 'Pipeline editor',
  PIPELINE_AGENT_TURN: 'Pipeline',
  PIPELINE_ADVISOR: 'Pipeline Advisor',
  PR_GENERATION: 'PR generation',
  COMMIT_MESSAGE_GENERATION: 'Commit message',
  BRANCH_NAMING: 'Branch naming',
  CRON_GENERATION: 'Cron generation',
  AUTOMATION_IF_COMMAND_GENERATION: 'Automation command',
  WORKTREE_SUMMARY: 'Worktree summary',
  CHAT_SUMMARY: 'Chat summary',
  ARCHIVE_SUMMARY: 'Archive summary',
  WORKTREE_PLAN_CHAT: 'Plan chat',
  WORKTREE_PLAN_DIAGRAM: 'Plan diagram',
};

/** Human-readable label for a telemetry event-type enum value. */
export function formatEventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? titleCaseEnum(eventType);
}

const TURN_STATUS_LABELS: Readonly<Record<string, string>> = {
  RUNNING: 'Running',
  SUCCESS: 'Success',
  FAILURE: 'Failure',
  CANCELLED: 'Cancelled',
  INTERRUPTED: 'Interrupted',
};

/** Human-readable label for a telemetry turn-status enum value. */
export function formatTurnStatusLabel(status: string): string {
  return TURN_STATUS_LABELS[status] ?? titleCaseEnum(status);
}

/** Map a telemetry turn-status enum value to a {@link StatusBadgeVariant}. */
export function turnStatusBadgeVariant(status: string): StatusBadgeVariant {
  switch (status) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'destructive';
    case 'CANCELLED':
    case 'INTERRUPTED':
      return 'warning';
    case 'RUNNING':
      return 'active';
    default:
      return 'muted';
  }
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
};

/** Human-readable label for an agent provider id. */
export function formatProviderLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider.toLowerCase()];
  if (known) {
    return known;
  }
  if (provider.length === 0) {
    return provider;
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
