import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphQueueEntry,
} from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCodeGraphQueueEntry(value: unknown): value is CodeGraphQueueEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.scope === 'worktree' || value.scope === 'workspace-shadow') &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((id) => typeof id === 'string') &&
    isOptionalString(value.workspaceLabel) &&
    isOptionalString(value.worktreeId) &&
    isOptionalString(value.repositoryId) &&
    isOptionalString(value.label) &&
    typeof value.trigger === 'string' &&
    typeof value.queuedAt === 'number' &&
    Number.isFinite(value.queuedAt) &&
    (value.startedAt === null ||
      (typeof value.startedAt === 'number' &&
        Number.isFinite(value.startedAt))) &&
    (value.status === 'queued' || value.status === 'running') &&
    typeof value.reorderable === 'boolean'
  );
}

export function isCodeGraphGenerationQueueSnapshot(
  value: unknown,
): value is CodeGraphGenerationQueueSnapshot {
  return (
    isRecord(value) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    Array.isArray(value.entries) &&
    value.entries.every(isCodeGraphQueueEntry)
  );
}
