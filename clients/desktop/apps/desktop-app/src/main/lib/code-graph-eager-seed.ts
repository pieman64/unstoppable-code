import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { fingerprintCustomLanguageInputs } from '@canopy/desktop-shared/node/code-graph/languages/custom-config';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import { runCodeGraphWorkerEagerSeed } from '../code-graph/build-runner';
import { withCodeGraphBaseVariantLeases } from './code-graph-base-store';
import { isCodeGraphAvailableForWorkspace } from './code-graph-availability';
import { isE2eBuild } from './e2e-gate';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorktreeCodeGraphRepositories } from './worktree-repo-entries';

export type CodeGraphEagerSeedResult =
  | { status: 'seeded'; source: 'base-worktree' | 'workspace-shadow' }
  | { status: 'existing' | 'disabled' | 'no-compatible-source' }
  | { status: 'failed'; message: string };

function canonicalSourceByRepoId(
  config: Awaited<ReturnType<typeof readWorkspaceConfig>>,
): Map<string, string> {
  const result = new Map<string, string>();
  if (config.type === 'single-repo' && config.repoPath) {
    result.set(WORKSPACE_ROOT_REPO_ID, config.repoPath);
  }
  if (config.type === 'multi-repo') {
    if (config.sourceRepoPath) {
      result.set(WORKSPACE_ROOT_REPO_ID, config.sourceRepoPath);
    }
    for (const repository of config.repos) {
      result.set(repository.id, repository.repoPath);
    }
  }
  return result;
}

function workerResult(
  response: Awaited<ReturnType<typeof runCodeGraphWorkerEagerSeed>>,
): CodeGraphEagerSeedResult {
  if (!response.ok) {
    return { status: 'failed', message: response.message };
  }
  if (response.status === 'seeded' && response.source !== undefined) {
    return { status: 'seeded', source: response.source };
  }
  return response.status === 'existing'
    ? { status: 'existing' }
    : { status: 'no-compatible-source' };
}

async function runSeedWorker(input: {
  workspaceId: string;
  worktreeId: string;
  repositories: readonly CodeGraphRepositoryInput[];
  source:
    | { kind: 'base-worktree'; dbPath: string }
    | {
        kind: 'workspace-shadow';
        bases: readonly {
          variantDir: string;
          identity: {
            repoId: string;
            canonicalRepoRoot: string;
            customLanguagesFingerprint: string;
          };
          destinationRootPath: string;
        }[];
      };
}): Promise<CodeGraphEagerSeedResult> {
  const response = await runCodeGraphWorkerEagerSeed(
    `${input.workspaceId}/${input.worktreeId}`,
    {
      operation: 'eager-seed',
      targetDbPath: getWorktreeCodeGraphDbPath(
        input.workspaceId,
        input.worktreeId,
      ),
      repositories: input.repositories,
      source: input.source,
    },
    {
      priority: 'worktree',
      metadata: {
        scope: 'worktree',
        workspaceIds: [input.workspaceId],
        worktreeId: input.worktreeId,
        label: input.worktreeId,
        trigger: 'worktree-eager-seed',
      },
    },
  );
  return workerResult(response);
}

/**
 * Installs a readable graph snapshot for callers without the automatic
 * post-create setup lifecycle. Desktop-created worktrees defer graph work to
 * the normal post-setup refresh so a large snapshot cannot extend their
 * Git-pending gate. Main resolves paths and holds immutable-base leases, but
 * every SQLite open, validation, copy, path rebind, fusion, and integrity
 * check runs in the code-graph utility process.
 */
export async function eagerSeedNewWorktreeCodeGraph(input: {
  workspaceId: string;
  worktreeId: string;
  baseWorktreeId?: string;
}): Promise<CodeGraphEagerSeedResult> {
  if (isE2eBuild() || !isCodeGraphAvailableForWorkspace(input.workspaceId)) {
    return { status: 'disabled' };
  }

  try {
    const worktreePath = resolveWorktreeCwd(
      input.workspaceId,
      input.worktreeId,
    );
    const repositories = await resolveWorktreeCodeGraphRepositories(
      input.workspaceId,
      worktreePath,
    );
    let shadowResult: CodeGraphEagerSeedResult = {
      status: 'no-compatible-source',
    };
    try {
      const customLanguagesFingerprint =
        await fingerprintCustomLanguageInputs(worktreePath);
      const config = await readWorkspaceConfig(input.workspaceId);
      const canonicalSources = canonicalSourceByRepoId(config);
      const leaseInputs = repositories.flatMap((repository) => {
        const canonicalRepoPath = canonicalSources.get(repository.repoId);
        return canonicalRepoPath === undefined
          ? []
          : [
              {
                canonicalRepoPath,
                repoId: repository.repoId,
                customLanguagesFingerprint: customLanguagesFingerprint.value,
                destinationRootPath: repository.rootPath,
              },
            ];
      });
      if (
        leaseInputs.length === repositories.length &&
        leaseInputs.length > 0
      ) {
        shadowResult = await withCodeGraphBaseVariantLeases(
          leaseInputs,
          (bases) =>
            runSeedWorker({
              workspaceId: input.workspaceId,
              worktreeId: input.worktreeId,
              repositories,
              source: { kind: 'workspace-shadow', bases },
            }),
        );
        if (
          shadowResult.status === 'seeded' ||
          shadowResult.status === 'existing'
        ) {
          return shadowResult;
        }
      }
    } catch (error) {
      shadowResult = {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // Prefer an immutable published base even for worktrees created from an
    // explicit worktree. It supports a copy-on-write clone and was already
    // integrity-checked at publication. The live base remains a fallback when
    // no compatible published generation exists.
    if (input.baseWorktreeId) {
      return runSeedWorker({
        workspaceId: input.workspaceId,
        worktreeId: input.worktreeId,
        repositories,
        source: {
          kind: 'base-worktree',
          dbPath: getWorktreeCodeGraphDbPath(
            input.workspaceId,
            input.baseWorktreeId,
          ),
        },
      }).catch(
        (error): CodeGraphEagerSeedResult => ({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return shadowResult;
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
