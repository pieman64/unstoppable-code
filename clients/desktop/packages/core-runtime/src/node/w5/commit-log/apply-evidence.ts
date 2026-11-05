import type { W5FileConflict } from './apply';
import { isRecord } from './is-record';

export function isW5FileConflict(value: unknown): value is W5FileConflict {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    (value.expected === null ||
      (typeof value.expected === 'string' &&
        /^[a-f0-9]{64}$/.test(value.expected))) &&
    (value.actual === null ||
      (typeof value.actual === 'string' && /^[a-f0-9]{64}$/.test(value.actual)))
  );
}

/** Persisted evidence is untrusted. Missing or unsupported fields prove nothing. */
export function isCleanConflictEvidence(
  value: unknown,
): value is { conflicts: W5FileConflict[]; written: string[] } {
  return (
    isRecord(value) &&
    Object.keys(value).every(
      (key) => key === 'conflicts' || key === 'written',
    ) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.length > 0 &&
    value.conflicts.every(isW5FileConflict) &&
    Array.isArray(value.written) &&
    value.written.length === 0
  );
}

/** Only the unscoped list repository uses this operation; it never reserves effects. */
export const W5_LAUNCH_HEAL_OPERATIONS: readonly string[] = [
  'w5.worktree_list.write',
];
