import type {
  ProjectRow,
  ProjectsListAction,
} from '@canopy/desktop-shared/lib/project-discovery';
import { hasHostAbsolutePath } from '@canopy/protocol/canopy-core';
import {
  COWORK_HOME_WORKTREE_ID,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  type CoworkWorkEntriesFile,
  type ProjectOwnerContext,
  type SidebarItem,
  type WorkspaceConfigFile,
  type WorkspaceRepoData,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { listAuthorizedProjects, type AuthorizedProject } from './owner-policy';
import {
  readProjectConfigSnapshot,
  readProjectEntries,
  readProjectWorktrees,
} from './sources';
import type { ProjectDiscoveryCaller } from './index';
import { sanitizeRemoteUrl } from '../lib/plan-share-repos';

export type { ProjectsListAction } from '@canopy/desktop-shared/lib/project-discovery';

interface SafeRepoDetails {
  repoId: string;
  name: string;
  source: string;
  manifestUrl?: string;
}

function sameOwner(
  left: ProjectOwnerContext,
  right: ProjectOwnerContext,
): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === 'personal' ||
    (right.kind === 'organization' &&
      left.organizationId.trim().toLowerCase() ===
        right.organizationId.trim().toLowerCase())
  );
}

function matchesQuery(candidate: AuthorizedProject, text: string): boolean {
  const query = text.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    candidate.projectId,
    candidate.name,
    candidate.displayName,
    candidate.description ?? '',
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function matchesExactName(candidate: AuthorizedProject, text: string): boolean {
  const name = text.trim().toLocaleLowerCase();
  return (
    candidate.name.toLocaleLowerCase() === name ||
    candidate.displayName.toLocaleLowerCase() === name
  );
}

/** Metadata filters are applied before the parent pages and hydrates rows. */
export function filterProjectCandidates(
  candidates: AuthorizedProject[],
  action: ProjectsListAction,
): AuthorizedProject[] {
  return candidates.filter((candidate) => {
    if (action.types && !action.types.includes(candidate.type)) return false;
    if (action.purposes && !action.purposes.includes(candidate.purpose))
      return false;
    if (action.readiness && !action.readiness.includes(candidate.readiness)) {
      return false;
    }
    if (action.owner && !sameOwner(action.owner, candidate.owner)) return false;
    if (!action.includeDefault && candidate.isDefault) return false;
    if (action.name && !matchesExactName(candidate, action.name)) return false;
    if (action.query && !matchesQuery(candidate, action.query)) return false;
    return true;
  });
}

export async function listProjectCandidates(
  action: ProjectsListAction,
  caller: ProjectDiscoveryCaller,
): Promise<AuthorizedProject[]> {
  const authorized = await listAuthorizedProjects(caller);
  return filterProjectCandidates(authorized, action);
}

interface ProjectCounts {
  countsAvailable: boolean;
  taskCount: number | null;
  activeTaskCount: number | null;
  doneTaskCount: number | null;
}

const unavailableCounts: ProjectCounts = {
  countsAvailable: false,
  taskCount: null,
  activeTaskCount: null,
  doneTaskCount: null,
};

function countWorktrees(worktrees: WorktreeData[]): ProjectCounts {
  const discoverable = worktrees.filter(
    (worktree) =>
      worktree.hidden !== true && worktree.id !== COWORK_HOME_WORKTREE_ID,
  );
  const doneTaskCount = discoverable.filter(
    (worktree) => worktree.status === 'done',
  ).length;
  const taskCount = discoverable.length;
  return {
    countsAvailable: true,
    taskCount,
    doneTaskCount,
    activeTaskCount: taskCount - doneTaskCount,
  };
}

function countEntries(file: CoworkWorkEntriesFile): ProjectCounts {
  const discoverable = file.entries.filter(
    (entry) => entry.id !== COWORK_HOME_WORKTREE_ID,
  );
  const doneTaskCount = discoverable.filter(
    (entry) => entry.status === 'done',
  ).length;
  const taskCount = discoverable.length;
  return {
    countsAvailable: true,
    taskCount,
    doneTaskCount,
    activeTaskCount: taskCount - doneTaskCount,
  };
}

async function readCounts(
  candidate: AuthorizedProject,
): Promise<ProjectCounts> {
  if (candidate.readiness !== 'ready') return unavailableCounts;
  try {
    return candidate.type === 'code'
      ? countWorktrees(await readProjectWorktrees(candidate.projectId))
      : countEntries(await readProjectEntries(candidate.projectId));
  } catch {
    return unavailableCounts;
  }
}

async function readReliableConfig(
  candidate: AuthorizedProject,
): Promise<WorkspaceConfigFile | undefined> {
  if (
    candidate.config &&
    (candidate.configAuthority === 'ok' ||
      candidate.configAuthority === 'absent')
  ) {
    return candidate.config;
  }
  try {
    return (await readProjectConfigSnapshot(candidate.projectId)).config;
  } catch {
    return undefined;
  }
}

function hasSelections(config: WorkspaceConfigFile | undefined): boolean {
  return Object.keys(config?.defaultPluginSelections ?? {}).length > 0;
}

function toSafeRepo(repo: WorkspaceRepoData): SafeRepoDetails {
  const manifestUrl = sanitizeRemoteUrl(repo.manifestUrl ?? null);
  return {
    repoId: repo.id,
    name: repo.name,
    source: repo.source ?? 'local',
    ...(manifestUrl && !hasHostAbsolutePath(manifestUrl)
      ? { manifestUrl }
      : {}),
  };
}

/** The effective repositories, as the sidebar projects them (never raw config). */
function codeRepos(item: SidebarItem): SafeRepoDetails[] {
  if (item.type === 'single-repo') {
    return [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        name: item.name,
        source: 'local',
      },
    ];
  }
  if (item.type === 'multi-repo') {
    return item.repos.map(toSafeRepo);
  }
  return [];
}

function sharedMetadata(
  candidate: AuthorizedProject,
  item: SidebarItem,
  counts: ProjectCounts,
): Omit<ProjectRow, 'type' | 'details'> {
  return {
    projectId: candidate.projectId,
    purpose: candidate.purpose,
    name: candidate.name,
    displayName: candidate.displayName,
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
    ...(candidate.lastActivityAt
      ? { lastActivityAt: candidate.lastActivityAt }
      : {}),
    color: item.color,
    isDefault: candidate.isDefault,
    readiness: candidate.readiness,
    owner: candidate.owner,
    ...counts,
  };
}

export async function hydrateProjectRow(
  candidate: AuthorizedProject,
): Promise<ProjectRow> {
  const item = candidate.item;
  const [counts, config] = await Promise.all([
    readCounts(candidate),
    readReliableConfig(candidate),
  ]);
  const metadata = sharedMetadata(candidate, item, counts);

  if (candidate.type === 'code') {
    const repos = codeRepos(item);
    const temporary = item.type === 'multi-repo' && item.temporary === true;
    return {
      ...metadata,
      type: 'code',
      details: {
        kind: 'code',
        codeKind: item.type === 'single-repo' ? 'single-repo' : 'multi-repo',
        temporary,
        // Mirrors apps/desktop-app/src/renderer/src/lib/app-actions/dispatcher.ts:1409; paths stay private.
        sourceControlledConfigAvailable:
          item.type !== 'multi-repo' ||
          (!temporary && Boolean(item.sourceRepoPath)),
        // Like the sidebar summary, the workspace-root repository is not counted.
        repoCount: repos.filter(
          (repo) => repo.repoId !== WORKSPACE_ROOT_REPO_ID,
        ).length,
        repos,
        alwaysShow: item.alwaysShow === true,
        hasDefaultPluginSelections: hasSelections(config),
      },
    };
  }

  return {
    ...metadata,
    type: 'cowork',
    details: {
      kind: 'cowork',
      ...(config?.cowork?.defaultModel
        ? { defaultModel: config.cowork.defaultModel }
        : {}),
      ...(config?.cowork?.defaultPresetId
        ? { defaultPresetId: config.cowork.defaultPresetId }
        : {}),
      presetCount: config?.cowork?.presets?.length ?? 0,
      hasDefaultPluginSelections: hasSelections(config),
      ...(config?.cowork?.archiveRetentionDays != null
        ? { archiveRetentionDays: config.cowork.archiveRetentionDays }
        : {}),
    },
  };
}
