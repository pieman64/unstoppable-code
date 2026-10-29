import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  SplitPrMap,
  SplitPrMapFile,
} from '@canopy/desktop-shared/types/github';
import { getWorkspaceSplitMapFilePath } from './paths';
import { isRecord } from './type-guards';

export async function readSplitPrMap(
  workspaceId: string,
  worktreeId: string,
): Promise<SplitPrMap | null> {
  try {
    const filePath = getWorkspaceSplitMapFilePath(workspaceId, worktreeId);
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isSplitPrMapFile(parsed)) {
      return null;
    }
    return parsed.map;
  } catch {
    return null;
  }
}

export async function writeSplitPrMap(
  workspaceId: string,
  worktreeId: string,
  map: SplitPrMap,
): Promise<boolean> {
  try {
    const filePath = getWorkspaceSplitMapFilePath(workspaceId, worktreeId);
    const splitMapDir = dirname(filePath);
    await mkdir(splitMapDir, { recursive: true });

    const payload: SplitPrMapFile = {
      version: 1,
      map,
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function deleteSplitPrMapForWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  const filePath = getWorkspaceSplitMapFilePath(workspaceId, worktreeId);
  await rm(filePath, { force: true });
}

function isSplitPrMapFile(value: unknown): value is SplitPrMapFile {
  if (!isRecord(value)) {
    return false;
  }

  return value.version === 1 && isSplitPrMap(value.map);
}

function isSplitPrMap(value: unknown): value is SplitPrMap {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.originalPrNumber === 'number' &&
    typeof value.originalPrUrl === 'string' &&
    typeof value.originalBaseBranch === 'string' &&
    typeof value.originalHeadBranch === 'string' &&
    typeof value.originalHeadSha === 'string' &&
    typeof value.integrationBranch === 'string' &&
    typeof value.originalWorktreeId === 'string' &&
    Array.isArray(value.children) &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}
