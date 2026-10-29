// Turn-diff event guards and structural equality helpers.
import type {
  ChangedFileInfo,
  ChatTurnDiffEvent,
  TurnDiffData,
} from '@canopy/desktop-shared/types';
import { isRecord } from './utils';

export function changedFilesMatch(
  left: TurnDiffData['files'][number],
  right: TurnDiffData['files'][number],
): boolean {
  return (
    left.path === right.path &&
    left.status === right.status &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions &&
    left.previousPath === right.previousPath &&
    left.repoId === right.repoId &&
    left.repoName === right.repoName
  );
}

export function turnDiffTreeRefsMatch(
  left: NonNullable<TurnDiffData['treeRefs']>[number],
  right: NonNullable<TurnDiffData['treeRefs']>[number],
): boolean {
  return (
    left.startTree === right.startTree &&
    left.endTree === right.endTree &&
    left.repoId === right.repoId &&
    left.startHeadCommitSha === right.startHeadCommitSha
  );
}

export function turnDiffsMatch(
  left: TurnDiffData | undefined,
  right: TurnDiffData,
): boolean {
  if (!left) return false;
  if (
    left.capturedAt !== right.capturedAt ||
    left.totalInsertions !== right.totalInsertions ||
    left.totalDeletions !== right.totalDeletions ||
    left.files.length !== right.files.length ||
    (left.treeRefs?.length ?? 0) !== (right.treeRefs?.length ?? 0)
  ) {
    return false;
  }
  const rightTreeRefs = right.treeRefs ?? [];
  return (
    left.files.every((file, index) => {
      const rightFile = right.files[index];
      return rightFile !== undefined && changedFilesMatch(file, rightFile);
    }) &&
    (left.treeRefs ?? []).every((treeRef, index) => {
      const rightTreeRef = rightTreeRefs[index];
      return (
        rightTreeRef !== undefined &&
        turnDiffTreeRefsMatch(treeRef, rightTreeRef)
      );
    })
  );
}

export function isChangedFileInfo(value: unknown): value is ChangedFileInfo {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    typeof value.insertions === 'number' &&
    typeof value.deletions === 'number' &&
    (value.previousPath === undefined ||
      typeof value.previousPath === 'string') &&
    (value.repoId === undefined || typeof value.repoId === 'string') &&
    (value.repoName === undefined || typeof value.repoName === 'string')
  );
}

function isTurnDiffTreeRef(
  value: unknown,
): value is NonNullable<TurnDiffData['treeRefs']>[number] {
  return (
    isRecord(value) &&
    typeof value.startTree === 'string' &&
    typeof value.endTree === 'string' &&
    (value.repoId === undefined || typeof value.repoId === 'string') &&
    (value.startHeadCommitSha === undefined ||
      typeof value.startHeadCommitSha === 'string')
  );
}

export function isTurnDiffEventData(
  value: unknown,
): value is ChatTurnDiffEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === 'turn_diff' &&
    typeof value.userMessageId === 'string' &&
    Array.isArray(value.files) &&
    value.files.every((file) => isChangedFileInfo(file)) &&
    typeof value.totalInsertions === 'number' &&
    typeof value.totalDeletions === 'number' &&
    typeof value.capturedAt === 'number' &&
    (value.treeRefs === undefined ||
      (Array.isArray(value.treeRefs) &&
        value.treeRefs.every(isTurnDiffTreeRef)))
  );
}

export function isTurnDiffData(value: unknown): value is TurnDiffData {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Array.isArray(value.files) &&
    value.files.every((file) => isChangedFileInfo(file)) &&
    typeof value.totalInsertions === 'number' &&
    typeof value.totalDeletions === 'number' &&
    typeof value.capturedAt === 'number' &&
    (value.treeRefs === undefined ||
      (Array.isArray(value.treeRefs) &&
        value.treeRefs.every(isTurnDiffTreeRef)))
  );
}

export function isTurnDiffsRecord(
  value: unknown,
): value is Record<string, TurnDiffData> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([userMessageId, turnDiff]) =>
        typeof userMessageId === 'string' && isTurnDiffData(turnDiff),
    )
  );
}
