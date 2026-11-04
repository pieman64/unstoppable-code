import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type LocalMemoryImportResult,
  type SidebarItem,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from '../../../lib/background-helper-queue';
import {
  coworkWorkspaceRootDirFor,
  getUserMemoryDir,
  getWorkspaceMemoryDir,
} from '../../../lib/paths';
import { readLocalMemoryEnabledPreference } from '../../../lib/preferences-store';
import { readAllSidebarItems } from '../../../lib/sidebar-items';
import { readWorkspaceConfig } from '../../../lib/workspace-persistence';
import { broadcastLocalMemoryChanged } from '../change-events';
import { requestLocalMemoryConsolidation } from '../consolidation-scheduler';
import { isMemoryMarkdownFileName } from '../memory-files';
import { resolveLocalMemoryPolicy } from '../policy';
import {
  discoverClaudeMemoryFiles,
  discoverCodexMemoryFiles,
} from './discovery';
import {
  runClaudeMemoryImport,
  runCodexMemoryImport,
  type ClaudeMemoryImportResult,
} from './import-runner';
import { readImportState } from './ledger';
import { routeClaudeMemoryContent } from './scope-routing';

export const CLAUDE_MEMORY_IMPORT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface ClaudeMemoryImportTargetBase {
  repoPath: string;
  repoId?: string;
}

export interface ClaudeMemoryUserImportTarget extends ClaudeMemoryImportTargetBase {
  scope: 'user';
  /** Preserve source attribution through a queued startup/manual import. */
  workspaceId?: string;
}

export interface ClaudeMemoryWorkspaceImportTarget extends ClaudeMemoryImportTargetBase {
  scope: 'workspace';
  workspaceId: string;
}

export type ClaudeMemoryImportTarget =
  | ClaudeMemoryUserImportTarget
  | ClaudeMemoryWorkspaceImportTarget;

export interface CodexMemoryImportTarget {
  scope: 'user';
}

type LocalMemoryImportTarget =
  | ({ sourceTool: 'claude-code' } & ClaudeMemoryImportTarget)
  | ({ sourceTool: 'codex' } & CodexMemoryImportTarget);

export type ClaudeMemoryImportJobStatus =
  | 'completed'
  | 'disabled'
  | 'min-interval';

export interface ClaudeMemoryImportJobResult extends ClaudeMemoryImportResult {
  status: ClaudeMemoryImportJobStatus;
}

function emptyJobResult(
  status: ClaudeMemoryImportJobStatus,
): ClaudeMemoryImportJobResult {
  return {
    status,
    staged: 0,
    skippedUnchanged: 0,
    skippedOversize: 0,
    oversizePaths: [],
    skippedUndrainable: 0,
    deferred: 0,
    errors: [],
  };
}

function targetScopeDir(target: LocalMemoryImportTarget): string {
  return target.scope === 'user'
    ? getUserMemoryDir()
    : getWorkspaceMemoryDir(target.workspaceId);
}

async function scopeHasPendingStagedImports(
  scopeDir: string,
): Promise<boolean> {
  try {
    const state = await readImportState(scopeDir);
    if (
      Object.values(state.sources).some(
        (entry) => 'stagedAs' in entry && entry.consolidatedAt === undefined,
      )
    ) {
      return true;
    }
  } catch {
    // Fall through to the staged-directory check. This is a best-effort re-arm
    // after the import result has already been computed.
  }
  try {
    const entries = await readdir(join(scopeDir, 'imported'), {
      withFileTypes: true,
    });
    return entries.some(
      (entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name),
    );
  } catch {
    return false;
  }
}

function checkedWithinInterval(
  checkedAt: string | undefined,
  nowMs: number,
): boolean {
  if (checkedAt === undefined) {
    return false;
  }
  const checkedMs = Date.parse(checkedAt);
  return (
    Number.isFinite(checkedMs) &&
    nowMs - checkedMs < CLAUDE_MEMORY_IMPORT_MIN_INTERVAL_MS
  );
}

async function targetDueSourcePaths(
  target: LocalMemoryImportTarget,
  nowMs: number,
): Promise<string[]> {
  const policy =
    target.sourceTool === 'claude-code' && target.workspaceId
      ? await resolveLocalMemoryPolicy({
          projectId: target.workspaceId,
          worktreeId: target.workspaceId,
        })
      : null;
  if (policy && policy.kind !== 'scoped') return [];
  if (
    policy?.kind === 'scoped' &&
    policy.privateMemory &&
    target.scope === 'user'
  )
    return [];
  const privateWorkspace =
    policy?.kind === 'scoped' &&
    policy.privateMemory &&
    target.scope === 'workspace';
  const discovery =
    target.sourceTool === 'codex'
      ? await discoverCodexMemoryFiles()
      : await discoverClaudeMemoryFiles(target.repoPath);
  const dueSourcePaths: string[] = [];
  const state = await readImportState(targetScopeDir(target));
  for (const sourcePath of discovery.oversizeFiles) {
    const entry = state.sources[sourcePath];
    const lastChecked =
      entry && 'importedAt' in entry
        ? (entry.checkedAt ?? entry.importedAt)
        : entry?.checkedAt;
    if (!checkedWithinInterval(lastChecked, nowMs)) {
      dueSourcePaths.push(sourcePath);
    }
  }
  for (const source of discovery.files) {
    if (target.sourceTool === 'claude-code') {
      let content: string;
      try {
        content = await readFile(source.sourcePath, 'utf8');
      } catch {
        dueSourcePaths.push(source.sourcePath);
        continue;
      }
      if (
        !privateWorkspace &&
        routeClaudeMemoryContent(content, source.modifiedAt).scope !==
          target.scope
      ) {
        continue;
      }
    }
    const entry = state.sources[source.sourcePath];
    const lastChecked =
      entry && 'importedAt' in entry
        ? (entry.checkedAt ?? entry.importedAt)
        : entry?.checkedAt;
    if (!checkedWithinInterval(lastChecked, nowMs)) {
      dueSourcePaths.push(source.sourcePath);
    }
  }
  return dueSourcePaths;
}

async function runLocalMemoryImportJob(
  target: LocalMemoryImportTarget,
  force: boolean,
): Promise<ClaudeMemoryImportJobResult> {
  if (!(await readLocalMemoryEnabledPreference())) {
    return emptyJobResult('disabled');
  }
  const checkedAt = new Date().toISOString();
  let dueSourcePaths: string[] | undefined = undefined;
  if (!force) {
    try {
      dueSourcePaths = await targetDueSourcePaths(
        target,
        Date.parse(checkedAt),
      );
    } catch {
      dueSourcePaths = undefined;
    }
  }
  if (dueSourcePaths?.length === 0) {
    return emptyJobResult('min-interval');
  }

  const result =
    target.sourceTool === 'codex'
      ? await runCodexMemoryImport({
          userScope: true,
          checkedAt,
          ...(dueSourcePaths ? { sourcePaths: dueSourcePaths } : {}),
        })
      : await runClaudeMemoryImport(
          target.scope === 'user'
            ? {
                userScope: true,
                ...(target.workspaceId
                  ? { workspaceId: target.workspaceId }
                  : {}),
                repoPath: target.repoPath,
                ...(target.repoId ? { repoId: target.repoId } : {}),
                scopeFilter: 'user',
                checkedAt,
                ...(dueSourcePaths ? { sourcePaths: dueSourcePaths } : {}),
              }
            : {
                workspaceId: target.workspaceId,
                repoPath: target.repoPath,
                ...(target.repoId ? { repoId: target.repoId } : {}),
                scopeFilter: 'workspace',
                checkedAt,
                ...(dueSourcePaths ? { sourcePaths: dueSourcePaths } : {}),
              },
        );
  if (result.staged > 0) {
    broadcastLocalMemoryChanged(
      target.scope === 'user'
        ? { scope: 'user' }
        : { scope: 'workspace', workspaceId: target.workspaceId },
    );
  }
  return { status: 'completed', ...result };
}

function enqueueLocalMemoryImport(
  target: LocalMemoryImportTarget,
  force: boolean,
): Promise<ClaudeMemoryImportJobResult> {
  return enqueueBackgroundHelperTask({
    priority: BACKGROUND_HELPER_PRIORITIES.memoryImport,
    task: (): Promise<ClaudeMemoryImportJobResult> =>
      runLocalMemoryImportJob(target, force),
  });
}

export function enqueueClaudeMemoryImport(
  target: ClaudeMemoryImportTarget,
  force = false,
): Promise<ClaudeMemoryImportJobResult> {
  return enqueueLocalMemoryImport(
    { sourceTool: 'claude-code', ...target },
    force,
  );
}

export function enqueueCodexMemoryImport(
  force = false,
): Promise<ClaudeMemoryImportJobResult> {
  return enqueueLocalMemoryImport(
    { sourceTool: 'codex', scope: 'user' },
    force,
  );
}

function repositoryTargets(
  workspaceId: string,
  workspace: {
    type: WorkspaceConfigFile['type'];
    repoPath?: string;
    sourceRepoPath?: string;
    externalPath?: string;
    repos?: ReadonlyArray<{ id: string; repoPath: string }>;
  },
  scopes: readonly ('user' | 'workspace')[],
): LocalMemoryImportTarget[] {
  const repositories: Array<{ repoPath: string; repoId?: string }> = [];
  if (workspace.type === 'cowork') {
    // A cowork workspace is one plain folder: the attached external folder,
    // or the managed home when none is attached. Claude Code keys its memory
    // directory by that cwd exactly as it does for a repository, so the
    // folder is the "repository" the discovery slugs. Resolved from the
    // config in hand through the pure form of `getCoworkWorkspaceRootDir`,
    // so the target does not depend on the registry having been rebuilt yet.
    repositories.push({
      repoPath: coworkWorkspaceRootDirFor(workspaceId, workspace.externalPath),
    });
  } else if (workspace.type === 'single-repo') {
    if (workspace.repoPath) {
      repositories.push({ repoPath: workspace.repoPath });
    }
  } else {
    if (workspace.sourceRepoPath) {
      repositories.push({
        repoPath: workspace.sourceRepoPath,
        repoId: WORKSPACE_ROOT_REPO_ID,
      });
    }
    repositories.push(
      ...(workspace.repos ?? []).map((repo) => ({
        repoPath: repo.repoPath,
        repoId: repo.id,
      })),
    );
  }

  return repositories.flatMap((repository) =>
    scopes.map(
      (scope): LocalMemoryImportTarget =>
        scope === 'user'
          ? { sourceTool: 'claude-code', scope, workspaceId, ...repository }
          : {
              sourceTool: 'claude-code',
              scope,
              workspaceId,
              ...repository,
            },
    ),
  );
}

function sidebarTargets(
  item: SidebarItem,
  scopes: readonly ('user' | 'workspace')[],
): LocalMemoryImportTarget[] {
  return repositoryTargets(item.id, item, scopes);
}

async function enqueueLocalMemoryImportBatch(
  targets: LocalMemoryImportTarget[],
  force = false,
): Promise<LocalMemoryImportResult> {
  const results = await Promise.all(
    targets.map((target) => enqueueLocalMemoryImport(target, force)),
  );
  const skippedOversize = new Set(
    results.flatMap((result) => result.oversizePaths),
  ).size;
  const aggregated: LocalMemoryImportResult = {
    disabled:
      results.length > 0 &&
      results.every((result) => result.status === 'disabled'),
    staged: results.reduce((total, result) => total + result.staged, 0),
    skipped:
      skippedOversize +
      results.reduce(
        (total, result) =>
          total + result.skippedUnchanged + result.skippedUndrainable,
        0,
      ),
    deferred: results.reduce((total, result) => total + result.deferred, 0),
    errors: results.flatMap((result) => result.errors),
  };
  const stagedTargets = targets.filter(
    (_target, index) => (results[index]?.staged ?? 0) > 0,
  );
  const stagedUserScope = stagedTargets.some(
    (target) => target.scope === 'user',
  );
  const stagedWorkspaceIds = new Set(
    stagedTargets.flatMap((target) =>
      target.scope === 'workspace' ? [target.workspaceId] : [],
    ),
  );
  if (!aggregated.disabled) {
    const involvedUserScope = targets.some((target) => target.scope === 'user');
    const involvedWorkspaceIds = new Set(
      targets.flatMap((target) =>
        target.scope === 'workspace' ? [target.workspaceId] : [],
      ),
    );
    const pendingUserScope =
      involvedUserScope &&
      (stagedUserScope ||
        (await scopeHasPendingStagedImports(getUserMemoryDir())));
    const pendingWorkspaceIds = (
      await Promise.all(
        Array.from(involvedWorkspaceIds, async (workspaceId) => ({
          workspaceId,
          pending:
            stagedWorkspaceIds.has(workspaceId) ||
            (await scopeHasPendingStagedImports(
              getWorkspaceMemoryDir(workspaceId),
            )),
        })),
      )
    ).filter(({ pending }) => pending);
    await Promise.all([
      ...(pendingUserScope ? [requestLocalMemoryConsolidation({})] : []),
      ...pendingWorkspaceIds.map(({ workspaceId }) =>
        requestLocalMemoryConsolidation({ workspaceId }),
      ),
    ]);
  }
  return aggregated;
}

export async function enqueueStartupLocalMemoryImportBatch(): Promise<LocalMemoryImportResult> {
  const sidebar = await readAllSidebarItems();
  return enqueueLocalMemoryImportBatch([
    ...sidebar.items.flatMap((item) => sidebarTargets(item, ['user'])),
    { sourceTool: 'codex', scope: 'user' },
  ]);
}

export async function enqueueWorkspaceLocalMemoryImportBatch(
  workspaceId: string,
): Promise<LocalMemoryImportResult> {
  const workspace = await readWorkspaceConfig(workspaceId);
  return enqueueLocalMemoryImportBatch(
    repositoryTargets(workspaceId, workspace, ['workspace']),
  );
}

export async function enqueueManualLocalMemoryImportBatch(
  workspaceId?: string,
): Promise<LocalMemoryImportResult> {
  if (workspaceId === undefined) {
    const sidebar = await readAllSidebarItems();
    return enqueueLocalMemoryImportBatch(
      [
        ...sidebar.items.flatMap((item) => sidebarTargets(item, ['user'])),
        { sourceTool: 'codex', scope: 'user' },
      ],
      true,
    );
  }
  const workspace = await readWorkspaceConfig(workspaceId);
  return enqueueLocalMemoryImportBatch(
    [
      ...repositoryTargets(workspaceId, workspace, ['user', 'workspace']),
      { sourceTool: 'codex', scope: 'user' },
    ],
    true,
  );
}
