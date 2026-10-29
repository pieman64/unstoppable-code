import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DetectedPlanEntry,
  DetectedPlanStatus,
  DetectedPlansFile,
} from '@canopy/desktop-shared/types';
import { resolveDetectedPlansFilePath } from './resolve-worktree';
import { isRecord } from './type-guards';

/**
 * Per-file write queue that serializes read-modify-write operations on the same
 * detected-plans file to prevent concurrent writes from silently dropping data.
 */
const writeLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === next) {
      writeLocks.delete(key);
    }
  }
}

function isDetectedPlanStatus(value: unknown): value is DetectedPlanStatus {
  return value === 'detected' || value === 'dismissed' || value === 'imported';
}

function isDetectedPlanEntry(value: unknown): value is DetectedPlanEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.sourceRepoId === 'string' &&
    typeof value.sourceFilePath === 'string' &&
    isDetectedPlanStatus(value.status) &&
    typeof value.bannerSeen === 'boolean' &&
    typeof value.detectedInChatId === 'string' &&
    typeof value.detectedAt === 'string' &&
    (value.importedPlanId === undefined ||
      typeof value.importedPlanId === 'string')
  );
}

function isDetectedPlansFile(value: unknown): value is DetectedPlansFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => isDetectedPlanEntry(entry))
  );
}

async function readDetectedPlansFile(
  projectId: string,
  worktreeId: string,
): Promise<DetectedPlansFile> {
  try {
    const filePath = resolveDetectedPlansFilePath(projectId, worktreeId);
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isDetectedPlansFile(parsed)) {
      return parsed;
    }
  } catch {
    // Use empty state when missing or invalid.
  }

  return {
    version: 1,
    entries: [],
  };
}

async function writeDetectedPlansFile(
  projectId: string,
  worktreeId: string,
  file: DetectedPlansFile,
): Promise<void> {
  const filePath = resolveDetectedPlansFilePath(projectId, worktreeId);
  if (file.entries.length === 0) {
    await rm(filePath, { force: true });
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');
}

export async function readDetectedPlans(
  projectId: string,
  worktreeId: string,
): Promise<DetectedPlanEntry[]> {
  const file = await readDetectedPlansFile(projectId, worktreeId);
  return file.entries;
}

/**
 * Append entries to the detected-plans file, deduplicating by
 * `(sourceRepoId, sourceFilePath)`. Returns the full updated list.
 */
export async function appendDetectedPlans(
  projectId: string,
  worktreeId: string,
  entries: DetectedPlanEntry[],
): Promise<DetectedPlanEntry[]> {
  const filePath = resolveDetectedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readDetectedPlansFile(projectId, worktreeId);

    const existingKeys = new Set(
      file.entries.map((e) => `${e.sourceRepoId}::${e.sourceFilePath}`),
    );
    const newEntries = entries.filter(
      (e) => !existingKeys.has(`${e.sourceRepoId}::${e.sourceFilePath}`),
    );

    const next: DetectedPlansFile = {
      version: 1,
      entries: [...file.entries, ...newEntries],
    };
    await writeDetectedPlansFile(projectId, worktreeId, next);
    return next.entries;
  });
}

/**
 * Patch a single detected-plan entry by id. Returns the full updated list.
 */
export async function updateDetectedPlan(
  projectId: string,
  worktreeId: string,
  entryId: string,
  patch: {
    status?: DetectedPlanStatus;
    bannerSeen?: boolean;
    importedPlanId?: string;
  },
): Promise<DetectedPlanEntry[]> {
  const filePath = resolveDetectedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readDetectedPlansFile(projectId, worktreeId);

    const next: DetectedPlansFile = {
      version: 1,
      entries: file.entries.map((entry) => {
        if (entry.id !== entryId) {
          return entry;
        }
        const updated: DetectedPlanEntry = {
          ...entry,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.bannerSeen !== undefined
            ? { bannerSeen: patch.bannerSeen }
            : {}),
          ...(patch.importedPlanId !== undefined
            ? { importedPlanId: patch.importedPlanId }
            : {}),
        };
        return updated;
      }),
    };

    await writeDetectedPlansFile(projectId, worktreeId, next);
    return next.entries;
  });
}

/**
 * Set `bannerSeen: true` for all entries with a matching `detectedInChatId`
 * and `status === 'detected'`. Returns the full updated list.
 */
export async function markBannerSeenForChat(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<DetectedPlanEntry[]> {
  const filePath = resolveDetectedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readDetectedPlansFile(projectId, worktreeId);

    const next: DetectedPlansFile = {
      version: 1,
      entries: file.entries.map((entry) => {
        if (
          entry.detectedInChatId === chatId &&
          entry.status === 'detected' &&
          !entry.bannerSeen
        ) {
          return { ...entry, bannerSeen: true };
        }
        return entry;
      }),
    };

    await writeDetectedPlansFile(projectId, worktreeId, next);
    return next.entries;
  });
}

/**
 * Remove the detected-plans file for the given worktree entirely.
 */
export async function deleteDetectedPlansForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const filePath = resolveDetectedPlansFilePath(projectId, worktreeId);
  await rm(filePath, { force: true });
}
