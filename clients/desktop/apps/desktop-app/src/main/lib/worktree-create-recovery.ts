import { isAbsolute, relative, resolve } from 'node:path';
import type {
  WorkspaceConfigFile,
  WorkspaceReadinessIssue,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { listCheckedOutBranches, listRegisteredWorktreePaths } from './git';
import {
  getWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorkspaceWorktreesRootDir,
} from './paths';
import { readWorkspaceWorktreesDetailed } from './workspace-persistence';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { canonicalizePossiblyMissingPath } from './worktree-registration-removal';

function issue(
  recovery: NonNullable<WorkspaceReadinessIssue['recovery']>,
): WorkspaceReadinessIssue {
  return {
    code: 'recovery-required',
    title: 'Recover interrupted worktree creation',
    message:
      recovery.phase === 'reserved'
        ? `${recovery.branchName}: ${recovery.checkoutPath}. Creation stopped before Git ran, so this checkout may not exist. Review this path before creating another worktree. Any files there have been kept.`
        : `${recovery.branchName}: ${recovery.checkoutPath}. Review this checkout before creating another worktree. Its files and Git registration have been kept.`,
    repoName: recovery.repositoryPath,
    // This issue reports evidence only; recovery requires an explicit decision.
    fixPrompt: null,
    recovery,
  };
}

/** Read-only D3/B4 diagnostics. Never adopts, resumes or removes a checkout. */
export async function inspectWorktreeCreationRecovery(
  workspaceId: string,
  config: WorkspaceConfigFile,
  rows?: readonly WorktreeData[],
): Promise<WorkspaceReadinessIssue[]> {
  if (config.type === 'cowork') return [];
  let registryComplete = true;
  if (!rows) {
    const read = await readWorkspaceWorktreesDetailed(workspaceId);
    // Partial rows still contain authoritative recovery metadata. They only
    // cannot prove that an unlisted checkout is orphaned.
    registryComplete = read.authority === 'ok' || read.authority === 'absent';
    rows = read.worktrees;
  }
  const issues = rows.flatMap((row) =>
    row.creation?.state === 'recovery-required'
      ? (row.creation.checkouts.length
          ? row.creation.checkouts
          : [
              {
                repositoryPath:
                  config.sourceRepoPath ??
                  getWorkspaceWorktreeRootRepoDir(workspaceId, row.id),
                checkoutPath: getWorkspaceWorktreeRootRepoDir(
                  workspaceId,
                  row.id,
                ),
              },
            ]
        ).map((checkout) =>
          issue({
            workspaceId,
            worktreeId: row.id,
            operationId: row.creation?.operationId,
            phase: row.creation?.phase ?? 'reserved',
            branchName: row.branchName,
            ...checkout,
          }),
        )
      : [],
  );
  if (!registryComplete) return issues;
  const canonicalPaths = new Map<string, Promise<string | null>>();
  function canonicalPath(path: string): Promise<string | null> {
    const absolute = resolve(path);
    let result = canonicalPaths.get(absolute);
    if (!result) {
      result = canonicalizePossiblyMissingPath(absolute).catch(() => null);
      canonicalPaths.set(absolute, result);
    }
    return result;
  }
  const repositories =
    config.type === 'single-repo'
      ? config.repoPath
        ? [await resolveProjectReferenceRepoPath(config.repoPath)]
        : []
      : [
          ...(config.sourceRepoPath
            ? [await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath)]
            : []),
          ...config.repos.map((repo) => repo.repoPath),
        ];
  const ownedPaths = new Set(
    await Promise.all(
      rows
        .flatMap((row) => [
          getWorktreeDir(workspaceId, row.id),
          getWorkspaceWorktreeRootRepoDir(workspaceId, row.id),
          // Creation only checks out the selected child repositories; a missing
          // scope means every configured repository, and [] is root-only.
          ...config.repos
            .filter(
              (repo) =>
                row.includedRepoIds === undefined ||
                row.includedRepoIds.includes(repo.id),
            )
            .map((repo) =>
              getWorkspaceWorktreeRepoDir(workspaceId, row.id, repo.id),
            ),
          ...(row.creation?.checkouts.map(
            (checkout) => checkout.checkoutPath,
          ) ?? []),
        ])
        .map(canonicalPath),
    ),
  );
  const root = await canonicalPath(getWorkspaceWorktreesRootDir(workspaceId));
  // Unresolved ownership cannot prove an orphan. Missing paths still resolve
  // through their existing ancestors, including macOS /var aliases.
  if (root === null || ownedPaths.has(null)) return issues;
  for (const repositoryPath of Array.from(new Set(repositories))) {
    // An unreadable repository cannot prove a checkout is orphaned. Keep the
    // persisted diagnostics and continue scanning the other repositories.
    const listing = await Promise.all([
      listRegisteredWorktreePaths(repositoryPath),
      listCheckedOutBranches(repositoryPath),
    ]).catch(() => null);
    if (!listing) continue;
    const [registered, branches] = listing;
    const branchByPath = new Map(
      await Promise.all(
        Array.from(
          branches,
          async ([branch, path]) =>
            [await canonicalPath(path), branch] as const,
        ),
      ),
    );
    for (const checkoutPath of Array.from(registered)) {
      const canonicalCheckout = await canonicalPath(checkoutPath);
      if (canonicalCheckout === null) continue;
      const child = relative(root, canonicalCheckout);
      if (
        !child ||
        child === '..' ||
        child.startsWith('../') ||
        child.startsWith('..\\') ||
        isAbsolute(child) ||
        ownedPaths.has(canonicalCheckout)
      )
        continue;
      issues.push(
        issue({
          workspaceId,
          phase: 'orphan-checkout',
          repositoryPath,
          checkoutPath,
          branchName: branchByPath.get(canonicalCheckout) ?? 'HEAD',
        }),
      );
    }
  }
  return issues;
}
