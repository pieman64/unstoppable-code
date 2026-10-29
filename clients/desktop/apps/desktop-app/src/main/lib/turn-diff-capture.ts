import type {
  ChangedFileInfo,
  TurnDiffData,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import { resolveWorktreeCwd } from './resolve-worktree';
import { isMultiRepoWorkspace } from './workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import {
  captureHeadCommitSha,
  captureWorkingTreeSha,
  diffTreeObjects,
  setGitTreeSnapshotRuntime,
} from './git-tree-snapshot';
import { persistTurnDiffTreeRef } from './git';
import { getResolvedGitExecutableForSpawn } from './git-executable';

setGitTreeSnapshotRuntime({
  resolveExecutable: () => getResolvedGitExecutableForSpawn(process.env),
  environment: () => process.env,
});

interface RepoTreeSnapshot {
  repoPath: string;
  treeSha: string;
  repoId?: string;
  repoName?: string;
  headCommitSha?: string;
}

interface TurnStartSnapshot {
  projectId: string;
  worktreeId: string;
  repos: RepoTreeSnapshot[];
}

const turnStartSnapshots = new Map<string, TurnStartSnapshot>();

function summarizeTurnDiff(
  files: ChangedFileInfo[],
  treeRefs: TurnDiffTreeRef[],
): TurnDiffData {
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    totalInsertions += file.insertions;
    totalDeletions += file.deletions;
  }

  return {
    files,
    totalInsertions,
    totalDeletions,
    capturedAt: Date.now(),
    treeRefs,
  };
}

function sortChangedFiles(files: ChangedFileInfo[]): ChangedFileInfo[] {
  return [...files].sort((left, right) => {
    const repoComparison = (left.repoName ?? '').localeCompare(
      right.repoName ?? '',
    );
    if (repoComparison !== 0) {
      return repoComparison;
    }
    return left.path.localeCompare(right.path);
  });
}

async function captureRepoTree(
  repoPath: string,
  projectId: string,
  worktreeId: string,
): Promise<string> {
  const treeSha = await captureWorkingTreeSha(repoPath);
  await persistTurnDiffTreeRef(repoPath, projectId, worktreeId, treeSha);
  return treeSha;
}

async function captureRepoSnapshot(
  repoPath: string,
  projectId: string,
  worktreeId: string,
): Promise<{ treeSha: string; headCommitSha?: string }> {
  const [treeSha, headCommitSha] = await Promise.all([
    captureRepoTree(repoPath, projectId, worktreeId),
    captureHeadCommitSha(repoPath),
  ]);
  return {
    treeSha,
    ...(headCommitSha ? { headCommitSha } : {}),
  };
}

export async function captureTurnStart(
  sessionKey: string,
  projectId: string,
  worktreeId: string,
): Promise<void> {
  turnStartSnapshots.delete(sessionKey);

  try {
    const worktreePath = resolveWorktreeCwd(projectId, worktreeId);
    if (!isMultiRepoWorkspace(projectId)) {
      const snapshot = await captureRepoSnapshot(
        worktreePath,
        projectId,
        worktreeId,
      );
      turnStartSnapshots.set(sessionKey, {
        projectId,
        worktreeId,
        repos: [{ repoPath: worktreePath, ...snapshot }],
      });
      return;
    }

    const repoEntries = await listWorkspaceWorktreeRepoEntries(
      projectId,
      worktreePath,
    );
    const repos = await Promise.all(
      repoEntries.map(async (entry): Promise<RepoTreeSnapshot> => {
        const snapshot = await captureRepoSnapshot(
          entry.repoPath,
          projectId,
          worktreeId,
        );
        return {
          repoPath: entry.repoPath,
          repoId: entry.repoId,
          repoName: entry.repoName,
          ...snapshot,
        };
      }),
    );

    turnStartSnapshots.set(sessionKey, {
      projectId,
      worktreeId,
      repos,
    });
  } catch (error: unknown) {
    turnStartSnapshots.delete(sessionKey);
    // eslint-disable-next-line no-console
    console.error(
      '[turn-diff-capture] failed to capture turn start snapshot:',
      error,
    );
  }
}

export async function captureTurnEndAndDiff(
  sessionKey: string,
): Promise<TurnDiffData | null> {
  const startSnapshot = turnStartSnapshots.get(sessionKey);
  turnStartSnapshots.delete(sessionKey);

  if (!startSnapshot) {
    return null;
  }

  try {
    const results = await Promise.all(
      startSnapshot.repos.map(
        async (
          repo,
        ): Promise<{
          files: ChangedFileInfo[];
          treeRef: TurnDiffTreeRef;
        }> => {
          const endTree = await captureRepoTree(
            repo.repoPath,
            startSnapshot.projectId,
            startSnapshot.worktreeId,
          );
          const treeRef: TurnDiffTreeRef = {
            startTree: repo.treeSha,
            endTree,
            ...(repo.repoId ? { repoId: repo.repoId } : {}),
            ...(repo.headCommitSha
              ? { startHeadCommitSha: repo.headCommitSha }
              : {}),
          };
          const files = await diffTreeObjects(
            repo.repoPath,
            repo.treeSha,
            endTree,
          );
          return {
            files: files.map((file) => ({
              ...file,
              ...(repo.repoId ? { repoId: repo.repoId } : {}),
              ...(repo.repoName ? { repoName: repo.repoName } : {}),
            })),
            treeRef,
          };
        },
      ),
    );

    const treeRefs = results.map((r) => r.treeRef);
    const files = sortChangedFiles(results.flatMap((r) => r.files));
    return summarizeTurnDiff(files, treeRefs);
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error(
      '[turn-diff-capture] failed to capture turn end diff:',
      error,
    );
    return null;
  }
}
