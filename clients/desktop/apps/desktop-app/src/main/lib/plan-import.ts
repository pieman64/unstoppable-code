import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { isImportablePlanFile } from '@canopy/desktop-shared/importable-plan-file';
import type {
  AppAdvisorJson,
  ImportTrackedPlanResponse,
  TrackedPlanData,
  UsageInitiationSource,
} from '@canopy/desktop-shared/types';
import { createTrackedPlanData } from '../services/plans-service';
import {
  resolveTrackedPlansFilePath,
  resolveWorktreeCwd,
} from './resolve-worktree';
import { validateId, validateOptionalRepoId } from './validation';
import { getWorkspaceType } from './workspace-registry';

/** Sentinel stored by the detection scanner meaning "the worktree root". */
const WORKTREE_SENTINEL = '__worktree__';

/**
 * Resolve the effective working directory for a filePath-based import.
 *
 * `WORKSPACE_ROOT_REPO_ID` and the legacy detection sentinel `'__worktree__'`
 * map to the worktree root. A real child `repoId` maps to the child-repo
 * checkout inside the worktree.
 */
function isWorkspaceRootImportRepoId(
  projectId: string,
  repoId: string,
): boolean {
  return (
    repoId === WORKSPACE_ROOT_REPO_ID ||
    repoId === WORKTREE_SENTINEL ||
    (repoId === projectId && getWorkspaceType(projectId) === 'single-repo')
  );
}

function resolveImportCwd(
  projectId: string,
  worktreeId: string,
  repoId: string,
): string {
  if (isWorkspaceRootImportRepoId(projectId, repoId)) {
    return resolveWorktreeCwd(projectId, worktreeId);
  }
  return resolveWorktreeCwd(projectId, worktreeId, repoId);
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function sourceRepoIdForRequest(
  projectId: string,
  repoId: string | undefined,
): string | undefined {
  if (
    repoId === WORKTREE_SENTINEL ||
    (repoId === projectId && getWorkspaceType(projectId) === 'single-repo')
  ) {
    return WORKSPACE_ROOT_REPO_ID;
  }
  return repoId;
}

function fileReadError(error: unknown): Error {
  return new Error(
    `Could not read the selected file: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

export async function importTrackedPlanFromPath(request: {
  projectId: string;
  worktreeId: string;
  filePath: string;
  repoId?: string;
  initiationSource?: UsageInitiationSource;
  allowAbsolutePath?: boolean;
}): Promise<ImportTrackedPlanResponse & { plan: TrackedPlanData }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(
    request.repoId === WORKTREE_SENTINEL ? undefined : request.repoId,
    'repoId',
  );

  if (!request.allowAbsolutePath && !request.repoId) {
    throw new Error(
      'Plan import requires repoId; use WORKSPACE_ROOT_REPO_ID for the worktree root.',
    );
  }
  const cwd = resolveImportCwd(
    request.projectId,
    request.worktreeId,
    request.repoId ?? WORKSPACE_ROOT_REPO_ID,
  );
  if (isAbsolute(request.filePath) && !request.allowAbsolutePath) {
    throw new Error('Plan import paths must be relative to the worktree.');
  }
  const resolvedFilePath = isAbsolute(request.filePath)
    ? resolve(request.filePath)
    : resolve(cwd, request.filePath);
  if (!isImportablePlanFile(basename(resolvedFilePath))) {
    throw new Error(
      'Only Markdown (.md) and plain text (.txt) plan documents can be imported.',
    );
  }
  let sourceFilePath = basename(resolvedFilePath);
  let sourceRepoId: string | undefined;
  if (!request.allowAbsolutePath) {
    const relativeToCwd = relative(cwd, resolvedFilePath);
    if (
      relativeToCwd === '' ||
      relativeToCwd === '..' ||
      relativeToCwd.startsWith(`..${sep}`) ||
      isAbsolute(relativeToCwd)
    ) {
      throw new Error('Plan import path must stay inside the worktree.');
    }
    let realCwd: string;
    let realFilePath: string;
    try {
      realCwd = await realpath(cwd);
      realFilePath = await realpath(resolvedFilePath);
    } catch (error) {
      throw fileReadError(error);
    }
    const realRelativeToCwd = relative(realCwd, realFilePath);
    if (
      realRelativeToCwd === '' ||
      realRelativeToCwd === '..' ||
      realRelativeToCwd.startsWith(`..${sep}`) ||
      isAbsolute(realRelativeToCwd)
    ) {
      throw new Error('Plan import path must stay inside the worktree.');
    }
    sourceFilePath = toPosix(relativeToCwd);
    sourceRepoId = sourceRepoIdForRequest(request.projectId, request.repoId);
  }

  let content: string;
  try {
    content = await readFile(resolvedFilePath, 'utf8');
  } catch (error) {
    throw fileReadError(error);
  }

  const plan = await createTrackedPlanData({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    source: 'imported',
    content,
    sourceFilePath,
    ...(sourceRepoId ? { sourceRepoId } : {}),
    initiationSource: request.initiationSource ?? 'user',
  });

  return {
    plan,
    trackedPlanFilePath: resolveTrackedPlansFilePath(
      request.projectId,
      request.worktreeId,
    ),
  };
}

export function importedPlanResult(
  plan: TrackedPlanData,
  trackedPlanFilePath: string,
): AppAdvisorJson {
  return {
    plan: {
      id: plan.id,
      projectId: plan.projectId,
      worktreeId: plan.worktreeId,
      source: plan.source,
      title: plan.title,
      reviewStatus: plan.reviewStatus,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      latestRevisionNumber: plan.latestRevisionNumber,
      sourceFilePath: plan.sourceFilePath ?? null,
      sourceRepoId: plan.sourceRepoId ?? null,
      contentLength: plan.content.length,
    },
    trackedPlanFilePath,
  };
}
