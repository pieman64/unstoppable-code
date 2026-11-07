import { BRAND } from '@canopy/brand/current';
import type {
  ReadWorkspaceDriftSummaryResponse,
  WorkspaceConfigFile,
  WorkspaceDriftIssue,
} from '@canopy/desktop-shared/types';
import {
  getCanopyJsonPath,
  hasManifestRepos,
  readCanopyJson,
} from './canopy-json';
import { getWorkspaceDir, getWorkspaceWorktreeRootRepoDir } from './paths';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

export interface WorkspaceDriftReport {
  issues: WorkspaceDriftIssue[];
  targetRepoPath: string;
  targetCanopyJsonPath: string;
}

export async function computeWorkspaceDriftIssues(
  workspaceId: string,
  worktreeId?: string,
): Promise<WorkspaceDriftReport> {
  const config = await readWorkspaceConfig(workspaceId);
  // Local combinations have no source-controlled root manifest to drift from.
  if (config.type === 'multi-repo' && !config.sourceRepoPath) {
    const targetRepoPath = worktreeId
      ? getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId)
      : getWorkspaceDir(workspaceId);
    return {
      issues: [],
      targetRepoPath,
      targetCanopyJsonPath: getCanopyJsonPath(targetRepoPath),
    };
  }
  const targetRepoPath = await getWorkspaceDriftTargetRepoPath(
    config,
    workspaceId,
    worktreeId,
  );
  const targetCanopyJsonPath = getCanopyJsonPath(targetRepoPath);

  let manifest;
  try {
    manifest = await readCanopyJson(targetRepoPath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'canopy.json is invalid';
    return {
      issues: [
        {
          code: 'invalid-canopy-json',
          message,
          blocking: true,
        },
      ],
      targetRepoPath,
      targetCanopyJsonPath,
    };
  }

  if (manifest === null) {
    const isSingleRepo = config.type === 'single-repo';
    return {
      issues: [
        {
          code: 'missing-canopy-json',
          message: isSingleRepo
            ? 'canopy.json is not present — optional for single-repo projects'
            : 'canopy.json is missing from this project root',
          blocking: !isSingleRepo,
        },
      ],
      targetRepoPath,
      targetCanopyJsonPath,
    };
  }

  if (config.type === 'single-repo') {
    const issues: WorkspaceDriftIssue[] = [];
    if (hasManifestRepos(manifest)) {
      issues.push({
        code: 'single-repo-has-repos',
        message:
          'This project is tracked as single-repo, but canopy.json defines multi-repo children.',
        blocking: true,
      });
    }

    return {
      issues,
      targetRepoPath,
      targetCanopyJsonPath,
    };
  }

  const issues: WorkspaceDriftIssue[] = [];
  if (!hasManifestRepos(manifest)) {
    issues.push({
      code: 'multi-repo-missing-repos',
      message:
        'This project is tracked as multi-repo, but canopy.json does not include repos.',
      blocking: true,
    });
    return {
      issues,
      targetRepoPath,
      targetCanopyJsonPath,
    };
  }

  const suppressedRepoIds = new Set(config.suppressedRepoIds ?? []);
  const trackedManifestRepos = new Map<
    string,
    WorkspaceConfigFile['repos'][number]
  >();
  for (const repo of config.repos) {
    if (suppressedRepoIds.has(repo.id)) {
      continue;
    }
    if (repo.source === 'local' || !repo.manifestUrl) {
      continue;
    }
    trackedManifestRepos.set(repo.id, repo);
  }

  const manifestReposById = new Map(
    manifest.repos.map((repo) => [repo.id, repo]),
  );

  for (const manifestRepo of manifest.repos) {
    if (suppressedRepoIds.has(manifestRepo.id)) {
      continue;
    }

    const trackedRepo = trackedManifestRepos.get(manifestRepo.id);
    if (!trackedRepo) {
      issues.push({
        code: 'manifest-repo-missing-local-binding',
        message: `canopy.json includes repo "${manifestRepo.id}", but ${BRAND.displayName} has no tracked local binding for it.`,
        blocking: true,
        repoId: manifestRepo.id,
      });
      continue;
    }

    if (trackedRepo.manifestUrl !== manifestRepo.url) {
      issues.push({
        code: 'manifest-repo-url-mismatch',
        message: `Repo "${manifestRepo.id}" has a different URL in canopy.json than in ${BRAND.displayName} tracking.`,
        blocking: true,
        repoId: manifestRepo.id,
      });
    }
  }

  trackedManifestRepos.forEach((trackedRepo) => {
    if (manifestReposById.has(trackedRepo.id)) {
      return;
    }

    issues.push({
      code: 'tracked-manifest-repo-missing-from-canopy',
      message: `${BRAND.displayName} tracks repo "${trackedRepo.id}" from the project manifest, but this canopy.json does not include it.`,
      blocking: true,
      repoId: trackedRepo.id,
    });
  });

  return {
    issues,
    targetRepoPath,
    targetCanopyJsonPath,
  };
}

export async function readWorkspaceDriftSummary(
  workspaceId: string,
  worktreeId: string,
): Promise<ReadWorkspaceDriftSummaryResponse> {
  const report = await computeWorkspaceDriftIssues(workspaceId, worktreeId);
  const blockingIssueCount = report.issues.filter(
    (issue) => issue.blocking,
  ).length;

  return {
    hasDrift: report.issues.length > 0,
    blockingIssueCount,
    warningIssueCount: report.issues.length - blockingIssueCount,
  };
}

async function getWorkspaceDriftTargetRepoPath(
  config: WorkspaceConfigFile,
  workspaceId: string,
  worktreeId?: string,
): Promise<string> {
  if (worktreeId) {
    return Promise.resolve(
      getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
    );
  }

  if (config.type === 'single-repo' && config.repoPath) {
    return resolveProjectReferenceRepoPath(config.repoPath);
  }

  if (config.sourceRepoPath) {
    return resolveWorkspaceReferenceRepoPath(config.sourceRepoPath);
  }

  throw new Error(
    `Workspace ${workspaceId} does not have a valid drift target`,
  );
}
