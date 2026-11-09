import type { CloudProjectSetupProgress } from '../types';

const STATES: ReadonlySet<unknown> = new Set(['running', 'done', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `cloud-projects:setup-progress` payload main sent (CAN-5192). */
export function isCloudProjectSetupProgress(
  value: unknown,
): value is CloudProjectSetupProgress {
  if (!isRecord(value)) return false;
  if (typeof value.projectId !== 'string' || typeof value.phase !== 'string')
    return false;
  if (!STATES.has(value.state)) return false;
  if (value.percent !== undefined && typeof value.percent !== 'number')
    return false;
  if (value.workspaceId !== undefined && typeof value.workspaceId !== 'string')
    return false;
  const repository = value.repository;
  return (
    repository === undefined ||
    (isRecord(repository) &&
      typeof repository.index === 'number' &&
      typeof repository.count === 'number' &&
      typeof repository.name === 'string')
  );
}
