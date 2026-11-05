import type { W5FileStore } from '@canopy/core-runtime/node/w5/file-store';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';
import type {
  ActivitySectionId,
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorkspaceCliRecord,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceRepoData,
  WorktreeData,
} from '../../types';
import { hasManifestRepos, readCanopyJson } from './canopy-json';
import { settleAll } from './detached-work';

// CLI reads of the workspace index, manifests and worktree lists. Writers
// live in ./workspace-service; this module must not import it.

async function readWorkspaceRecord(
  filePath: string,
  store?: W5FileStore,
): Promise<string> {
  if (!store) return readFile(filePath, 'utf8');
  const read = await store.read(filePath);
  if (read.state === 'present') return read.raw;
  if (read.state === 'absent')
    throw Object.assign(new Error('Project record not found'), {
      code: 'ENOENT',
    });
  throw read.error ?? new Error('Project record is unreadable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getWorkspacesRootDir(): string {
  return path.join(getCanopyDataDir(), 'workspaces');
}

function getWorkspaceIndexFilePath(): string {
  return path.join(getWorkspacesRootDir(), 'index.json');
}

export function getWorkspaceDir(workspaceId: string): string {
  return path.join(getWorkspacesRootDir(), workspaceId);
}

function getWorkspaceHomeDir(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'home');
}

function getWorkspaceConfigPath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'workspace.json');
}

function getWorkspaceWorktreesFilePath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'worktrees.json');
}

function normalizeIndexEntry(value: unknown): WorkspaceIndexEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    id,
    name,
    type,
    color,
    collapsed,
    order,
    pinned,
    activitySectionOrder,
  } = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    (type !== 'single-repo' && type !== 'multi-repo' && type !== 'cowork') ||
    typeof color !== 'string'
  ) {
    return null;
  }
  return {
    id,
    name,
    type,
    color,
    collapsed: typeof collapsed === 'boolean' ? collapsed : false,
    order: typeof order === 'number' ? order : 0,
    ...(pinned === true ? { pinned: true } : {}),
    activitySectionOrder: normalizeActivitySectionOrder(activitySectionOrder),
  };
}

function isActivitySectionId(value: unknown): value is ActivitySectionId {
  return (
    value === 'summary' ||
    value === 'changed-files' ||
    value === 'pull-request' ||
    value === 'background-processes' ||
    value === 'pipeline-runs' ||
    value === 'cost' ||
    value === 'plans' ||
    value === 'scripts' ||
    value === 'hooks' ||
    value === 'mcp-servers' ||
    value === 'todo' ||
    value === 'memory'
  );
}

function normalizeActivitySectionOrder(
  value: unknown,
): ActivitySectionId[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(isActivitySectionId);
  return normalized.length > 0 ? normalized : undefined;
}

interface LoadedWorkspaceIndex {
  entries: WorkspaceIndexEntry[];
  /** File contents when every entry normalized; `null` when absent or partial. */
  completeRaw: string | null;
  partial: boolean;
}

/** `null` when the index exists but cannot be read or parsed. */
export async function loadWorkspaceIndex(
  store?: W5FileStore,
): Promise<LoadedWorkspaceIndex | null> {
  let raw: string;
  try {
    raw = await readWorkspaceRecord(getWorkspaceIndexFilePath(), store);
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT'
      ? { entries: [], completeRaw: null, partial: false }
      : null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
      return null;
    }
    const entries = parsed.workspaces
      .map((entry) => normalizeIndexEntry(entry))
      .filter((entry): entry is WorkspaceIndexEntry => entry !== null);
    return {
      entries,
      completeRaw: entries.length === parsed.workspaces.length ? raw : null,
      partial: entries.length !== parsed.workspaces.length,
    };
  } catch {
    return null;
  }
}

export async function readWorkspaceIndex(): Promise<WorkspaceIndexEntry[]> {
  return (await loadWorkspaceIndex())?.entries ?? [];
}

function normalizeRepo(value: unknown): WorkspaceRepoData | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, name, repoPath, source, manifestUrl } = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof repoPath !== 'string'
  ) {
    return null;
  }
  const repo: WorkspaceRepoData = {
    id,
    name,
    repoPath,
    source: source === 'manifest' ? 'manifest' : 'local',
    manifestUrl: typeof manifestUrl === 'string' ? manifestUrl : undefined,
  };
  const scripts = normalizeScriptOverrides(value.scripts);
  if (scripts) {
    repo.scripts = scripts;
  }
  return repo;
}

function normalizeScriptOverrides(
  value: unknown,
): Record<string, string | null> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | null] =>
      typeof entry[1] === 'string' || entry[1] === null,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter((entry) => typeof entry === 'string');
  return normalized.length > 0 ? normalized : undefined;
}

async function readWorkspaceConfig(
  workspaceId: string,
  store?: W5FileStore,
): Promise<WorkspaceConfigFile> {
  try {
    const parsed: unknown = JSON.parse(
      await readWorkspaceRecord(getWorkspaceConfigPath(workspaceId), store),
    );
    if (!isRecord(parsed)) {
      throw new Error('Invalid project config');
    }
    const type =
      parsed.type === 'single-repo' ||
      parsed.type === 'multi-repo' ||
      parsed.type === 'cowork'
        ? parsed.type
        : 'multi-repo';
    const repos = Array.isArray(parsed.repos)
      ? parsed.repos
          .map((repo) => normalizeRepo(repo))
          .filter((repo): repo is WorkspaceRepoData => repo !== null)
      : [];
    return {
      version: 1,
      type,
      repoPath:
        typeof parsed.repoPath === 'string' ? parsed.repoPath : undefined,
      repos,
      externalPath:
        typeof parsed.externalPath === 'string'
          ? parsed.externalPath
          : typeof parsed.folderPath === 'string'
            ? parsed.folderPath
            : undefined,
      sourceRepoPath:
        typeof parsed.sourceRepoPath === 'string'
          ? parsed.sourceRepoPath
          : undefined,
      suppressedRepoIds: normalizeStringArray(parsed.suppressedRepoIds),
      alwaysShow:
        typeof parsed.alwaysShow === 'boolean' ? parsed.alwaysShow : true,
    };
  } catch (error) {
    if (store) throw error;
    return { version: 1, type: 'multi-repo', repos: [], alwaysShow: true };
  }
}

function normalizeWorktree(value: unknown): WorktreeData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.branchName !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return null;
  }
  const worktree: WorktreeData = {
    id: value.id,
    branchName: value.branchName,
    createdAt: value.createdAt,
    label: typeof value.label === 'string' ? value.label : undefined,
    status: value.status === 'done' ? 'done' : undefined,
    trackedBaseBranch:
      typeof value.trackedBaseBranch === 'string'
        ? value.trackedBaseBranch
        : undefined,
  };
  if (
    value.branchGroupingOverride === 'group' ||
    value.branchGroupingOverride === 'ungroup'
  ) {
    worktree.branchGroupingOverride = value.branchGroupingOverride;
  }
  if (typeof value.branchGroupingParentWorktreeId === 'string') {
    worktree.branchGroupingParentWorktreeId =
      value.branchGroupingParentWorktreeId;
  }
  return worktree;
}

async function readWorkspaceWorktrees(
  workspaceId: string,
  store?: W5FileStore,
): Promise<WorktreeData[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readWorkspaceRecord(
        getWorkspaceWorktreesFilePath(workspaceId),
        store,
      ),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.worktrees)) {
      return [];
    }
    return parsed.worktrees
      .map((worktree) => normalizeWorktree(worktree))
      .filter((worktree): worktree is WorktreeData => worktree !== null);
  } catch {
    return [];
  }
}

async function buildSidebarItem(
  entry: WorkspaceIndexEntry,
  store?: W5FileStore,
): Promise<SidebarItem | null> {
  const [config, worktrees] = await settleAll([
    readWorkspaceConfig(entry.id, store),
    readWorkspaceWorktrees(entry.id, store),
  ]);

  if (entry.type === 'cowork') {
    const item: CoworkSidebarItem = {
      type: 'cowork',
      id: entry.id,
      name: entry.name,
      color: entry.color,
      collapsed: entry.collapsed,
      order: entry.order,
      ...(entry.pinned === true ? { pinned: true } : {}),
      externalPath: config.externalPath,
      alwaysShow: config.alwaysShow,
    };
    return item;
  }

  if (entry.type === 'single-repo') {
    if (!config.repoPath) {
      return null;
    }
    const item: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: entry.id,
      name: entry.name,
      repoPath: config.repoPath,
      color: entry.color,
      worktrees,
      collapsed: entry.collapsed,
      order: entry.order,
      ...(entry.pinned === true ? { pinned: true } : {}),
      activitySectionOrder: entry.activitySectionOrder,
      alwaysShow: config.alwaysShow,
    };
    return item;
  }

  const item: MultiRepoSidebarItem = {
    type: 'multi-repo',
    id: entry.id,
    name: entry.name,
    color: entry.color,
    repos: config.repos,
    worktrees,
    collapsed: entry.collapsed,
    order: entry.order,
    ...(entry.pinned === true ? { pinned: true } : {}),
    activitySectionOrder: entry.activitySectionOrder,
    sourceRepoPath: config.sourceRepoPath,
    suppressedRepoIds: config.suppressedRepoIds,
    alwaysShow: config.alwaysShow,
  };
  return applySourceManifestToWorkspace(item);
}

async function applySourceManifestToWorkspace(
  item: MultiRepoSidebarItem,
): Promise<MultiRepoSidebarItem> {
  if (!item.sourceRepoPath) {
    return item;
  }

  const manifest = await readCanopyJson(item.sourceRepoPath);
  if (!hasManifestRepos(manifest)) {
    return item;
  }

  const localRepoById = new Map(item.repos.map((repo) => [repo.id, repo]));
  const manifestRepoIds = new Set<string>();
  const suppressedRepoIds = new Set(item.suppressedRepoIds ?? []);
  const repos: WorkspaceRepoData[] = [];

  for (const manifestRepo of manifest.repos) {
    manifestRepoIds.add(manifestRepo.id);
    if (suppressedRepoIds.has(manifestRepo.id)) {
      continue;
    }

    const localRepo = localRepoById.get(manifestRepo.id);
    if (!localRepo) {
      continue;
    }

    repos.push({
      ...localRepo,
      source: 'manifest',
      manifestUrl: manifestRepo.url,
    });
  }

  for (const localRepo of item.repos) {
    if (localRepo.source === 'manifest' || manifestRepoIds.has(localRepo.id)) {
      continue;
    }
    repos.push({ ...localRepo, source: 'local' });
  }

  return { ...item, repos };
}

export async function listWorkspaceItems(): Promise<SidebarItem[]> {
  const entries = await readWorkspaceIndex();
  const items = await settleAll(
    entries.map((entry) => buildSidebarItem(entry)),
  );
  return items
    .filter((item): item is SidebarItem => item !== null)
    .sort((left, right) => left.order - right.order);
}

export async function getWorkspaceItem(
  workspaceId: string,
  store?: W5FileStore,
): Promise<SidebarItem> {
  if (store) {
    const index = await loadWorkspaceIndex(store);
    if (!index || index.partial) throw new Error('Project list is unreadable');
    const entry = index.entries.find(
      (candidate) => candidate.id === workspaceId,
    );
    const item = entry ? await buildSidebarItem(entry, store) : null;
    if (!item) throw new Error(`Project ${workspaceId} not found`);
    return item;
  }
  const item = (await listWorkspaceItems()).find(
    (workspace) => workspace.id === workspaceId,
  );
  if (!item) {
    throw new Error(`Project ${workspaceId} not found`);
  }
  return item;
}

export function toWorkspaceCliRecord(item: SidebarItem): WorkspaceCliRecord {
  if (item.type === 'single-repo') {
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      color: item.color,
      order: item.order,
      collapsed: item.collapsed,
      rootPath: item.repoPath,
      repoPath: item.repoPath,
      repoCount: 1,
      worktreeCount: item.worktrees.length,
      repos: [{ id: item.id, name: item.name, repoPath: item.repoPath }],
      worktrees: item.worktrees,
    };
  }

  if (item.type === 'cowork') {
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      color: item.color,
      order: item.order,
      collapsed: item.collapsed,
      rootPath: item.externalPath ?? getWorkspaceHomeDir(item.id),
      repoCount: 0,
      worktreeCount: 0,
      repos: [],
      worktrees: [],
    };
  }

  const rootPath =
    item.sourceRepoPath ?? path.join(getCanopyDataDir(), 'workspaces', item.id);
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    color: item.color,
    order: item.order,
    collapsed: item.collapsed,
    rootPath,
    sourceRepoPath: item.sourceRepoPath,
    repoCount: item.repos.length,
    worktreeCount: item.worktrees.length,
    repos: item.repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      repoPath: repo.repoPath,
      source: repo.source,
      manifestUrl: repo.manifestUrl,
    })),
    worktrees: item.worktrees,
  };
}
