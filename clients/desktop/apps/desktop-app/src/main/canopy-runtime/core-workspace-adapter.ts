import type {
  CanopyQueryHandlerMap,
  CanopyQueryParams,
  CanopyQueryResult,
  CanopyWorkspaceScope,
  CoreWorkspace,
  CoreWorktree,
} from '@canopy/protocol/canopy-core';
import { hasHostAbsolutePath } from '@canopy/protocol/canopy-core';
import type {
  SidebarItem,
  SidebarItemsFile,
  WorktreeData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
  readWorkspaceIndexEntry,
} from '../lib/sidebar-items';
import {
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import type { WorkspaceIndexAuthority } from '../lib/workspace-index-repository';
import { readEffectiveWorkspaceConfig } from '../lib/workspace-source';
import { sanitizeRemoteUrl } from '../lib/plan-share-repos';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** Authority of a persisted read: only `ok` proves the content is complete. */
export type CoreWorkspaceReadAuthority = WorkspaceIndexAuthority;

export interface CoreWorkspaceReadServices {
  readAllSidebarItems(): Promise<SidebarItemsFile>;
  readWorkspaceIndexEntry: typeof readWorkspaceIndexEntry;
  readWorkspaceConfig: typeof readWorkspaceConfig;
  readWorkspaceWorktrees: typeof readWorkspaceWorktrees;
  readEffectiveWorkspaceConfig: typeof readEffectiveWorkspaceConfig;
  /**
   * The same reads together with their authority. When present the
   * projections use them, so a capture can pair content with the authority
   * of the read that produced it.
   */
  readAllSidebarItemsSnapshot?(): Promise<{
    file: SidebarItemsFile;
    authority: CoreWorkspaceReadAuthority;
    indexAuthority?: CoreWorkspaceReadAuthority;
  }>;
  readWorkspaceConfigDetailed?(workspaceId: string): Promise<{
    config: WorkspaceConfigFile;
    authority: CoreWorkspaceReadAuthority;
    ownerMalformed: boolean;
  }>;
  readWorkspaceWorktreesDetailed?(workspaceId: string): Promise<{
    worktrees: WorktreeData[];
    authority: CoreWorkspaceReadAuthority;
  }>;
}

export interface CoreWorkspaceReadDetail {
  authority: CoreWorkspaceReadAuthority;
  /**
   * For the sidebar snapshot: the authority of the project index read alone.
   * `authority` also folds in every project's manifests, so one unreadable
   * project lowers it without the index itself being unreliable.
   */
  indexAuthority?: CoreWorkspaceReadAuthority;
  ownerMalformed?: boolean;
}

export interface CoreWorkspaceProjectionCapture {
  captureSidebar(
    result: SidebarItemsFile,
    detail?: CoreWorkspaceReadDetail,
  ): void;
  captureConfig(
    result: WorkspaceConfigFile,
    detail?: CoreWorkspaceReadDetail,
  ): void;
  captureWorktrees(
    result: WorktreeData[],
    detail?: CoreWorkspaceReadDetail,
  ): void;
  captureWorktree(result: WorktreeData): void;
}

type WorkspaceReadHandlers = Pick<
  CanopyQueryHandlerMap,
  | 'core.workspace.list'
  | 'core.workspace.get'
  | 'core.worktree.list'
  | 'core.worktree.get'
>;

function checkScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.targetId !== undefined ||
    (scope?.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected workspace authority or target is unavailable.',
      retry: { kind: 'never' },
    });
  }
}

function checkWorkspaceScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.worktreeId !== undefined ||
    scope?.chatId !== undefined ||
    scope?.operationId !== undefined ||
    scope?.executionId !== undefined ||
    scope?.repoId !== undefined
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected workspace scope is unavailable.',
      retry: { kind: 'never' },
    });
  }
}

function invalidArgument(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message,
    retry: { kind: 'never' },
  });
}

function checkWorkspaceIdSpelling(workspaceId?: string): void {
  if (workspaceId !== undefined && hasHostAbsolutePath(workspaceId)) {
    throw invalidArgument('Workspace ids cannot be host paths.');
  }
}

function checkWorktreeScope(scope?: CanopyWorkspaceScope): void {
  if (
    scope?.chatId !== undefined ||
    scope?.operationId !== undefined ||
    scope?.executionId !== undefined ||
    scope?.repoId !== undefined
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected worktree scope is unavailable.',
      retry: { kind: 'never' },
    });
  }
}

function workspaceNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'Workspace not found.',
    retry: { kind: 'never' },
  });
}

const MAX_REPO_ID_LENGTH = 512;

function worktreeNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'Worktree not found.',
    retry: { kind: 'never' },
  });
}

async function checkWorktreeWorkspaceId(
  workspaceId: string,
  services: CoreWorkspaceReadServices,
): Promise<void> {
  if (
    workspaceId === '.' ||
    workspaceId === '..' ||
    workspaceId.includes('/') ||
    workspaceId.includes('\\') ||
    !(await services.readWorkspaceIndexEntry(workspaceId))
  ) {
    throw worktreeNotFound();
  }
}

function projectRepositorySources(
  repos: readonly { id: string; manifestUrl?: string | null }[],
): CoreWorkspace['repositorySources'] {
  // Legacy persistence accepts any id length; the legacy helpers fall back.
  if (repos.some((repo) => repo.id.length > MAX_REPO_ID_LENGTH)) {
    throw invalidArgument('Workspace repository id exceeds 512 characters.');
  }
  return repos.flatMap((repo) => {
    const remoteUrl = sanitizeRemoteUrl(repo.manifestUrl ?? null);
    return remoteUrl &&
      remoteUrl.length <= 4096 &&
      !hasHostAbsolutePath(remoteUrl)
      ? [{ repoId: repo.id, remoteUrl }]
      : [];
  });
}

function projectWorkspace(item: SidebarItem): CoreWorkspace {
  const repos = item.type === 'multi-repo' ? item.repos : [];
  return {
    workspaceId: item.id,
    name: item.name,
    kind: item.type === 'cowork' ? 'cowork' : 'git',
    repositorySources: projectRepositorySources(repos),
    settings: {},
  };
}

function projectWorktree(
  workspaceId: string,
  worktree: WorktreeData,
): CoreWorktree {
  return {
    worktreeId: worktree.id,
    workspaceId,
    name: worktree.label || worktree.branchName,
    state: worktree.healthIssue
      ? 'error'
      : worktree.setupPhase === 'git-pending'
        ? 'creating'
        : 'ready',
    baseBranch: worktree.trackedBaseBranch ?? null,
    branch: worktree.branchName,
    createdAt: worktree.createdAt,
  };
}

function paginate<T>(
  items: T[],
  pageSize = 100,
  cursor?: string,
): {
  items: T[];
  nextCursor: string | null;
} {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) {
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Invalid workspace pagination cursor.',
      retry: { kind: 'never' },
    });
  }
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

async function readSidebar(
  services: CoreWorkspaceReadServices,
): Promise<{ file: SidebarItemsFile; detail?: CoreWorkspaceReadDetail }> {
  if (!services.readAllSidebarItemsSnapshot)
    return { file: await services.readAllSidebarItems() };
  const { file, authority, indexAuthority } =
    await services.readAllSidebarItemsSnapshot();
  return {
    file,
    detail: { authority, ...(indexAuthority ? { indexAuthority } : {}) },
  };
}

async function readConfig(
  services: CoreWorkspaceReadServices,
  workspaceId: string,
): Promise<{ config: WorkspaceConfigFile; detail?: CoreWorkspaceReadDetail }> {
  if (!services.readWorkspaceConfigDetailed)
    return { config: await services.readWorkspaceConfig(workspaceId) };
  const { config, authority, ownerMalformed } =
    await services.readWorkspaceConfigDetailed(workspaceId);
  return { config, detail: { authority, ownerMalformed } };
}

async function readWorktrees(
  services: CoreWorkspaceReadServices,
  workspaceId: string,
): Promise<{ worktrees: WorktreeData[]; detail?: CoreWorkspaceReadDetail }> {
  if (!services.readWorkspaceWorktreesDetailed)
    return { worktrees: await services.readWorkspaceWorktrees(workspaceId) };
  const { worktrees, authority } =
    await services.readWorkspaceWorktreesDetailed(workspaceId);
  return { worktrees, detail: { authority } };
}

export function createCoreWorkspaceAdapter(
  // Client reads never persist removal cleanup (RR1); list writes do.
  services: CoreWorkspaceReadServices = {
    readAllSidebarItems: () =>
      readAllSidebarItems({ persistRemovalCleanup: false }),
    readWorkspaceIndexEntry: (workspaceId) =>
      readWorkspaceIndexEntry(workspaceId),
    readWorkspaceConfig: (workspaceId) => readWorkspaceConfig(workspaceId),
    readWorkspaceWorktrees: (workspaceId) =>
      readWorkspaceWorktrees(workspaceId, { persistRemovalCleanup: false }),
    readEffectiveWorkspaceConfig: (workspaceId, config) =>
      readEffectiveWorkspaceConfig(workspaceId, config),
    readAllSidebarItemsSnapshot: () =>
      readAllSidebarItemsSnapshot({ persistRemovalCleanup: false }),
    readWorkspaceConfigDetailed: (workspaceId) =>
      readWorkspaceConfigDetailed(workspaceId),
    readWorkspaceWorktreesDetailed: (workspaceId) =>
      readWorkspaceWorktreesDetailed(workspaceId, {
        persistRemovalCleanup: false,
      }),
  },
  capture?: CoreWorkspaceProjectionCapture,
): WorkspaceReadHandlers {
  return {
    'core.workspace.list': async (
      params: CanopyQueryParams<'core.workspace.list'>,
    ): Promise<CanopyQueryResult<'core.workspace.list'>> => {
      checkScope(params.scope);
      checkWorkspaceScope(params.scope);
      checkWorkspaceIdSpelling(params.scope?.workspaceId);
      const { file: sidebar, detail } = await readSidebar(services);
      capture?.captureSidebar(sidebar, detail);
      const items = sidebar.items.filter(
        (item) =>
          (params.scope?.workspaceId === undefined ||
            item.id === params.scope.workspaceId) &&
          (params.scope?.organizationId === undefined ||
            item.owner?.organizationId === params.scope.organizationId),
      );
      return paginate(
        items.map(projectWorkspace),
        params.pageSize,
        params.cursor,
      );
    },
    'core.workspace.get': async (
      params: CanopyQueryParams<'core.workspace.get'>,
    ): Promise<CanopyQueryResult<'core.workspace.get'>> => {
      checkScope(params.scope);
      checkWorkspaceScope(params.scope);
      checkWorkspaceIdSpelling(params.workspaceId);
      checkWorkspaceIdSpelling(params.scope?.workspaceId);
      if (
        params.scope?.workspaceId !== undefined &&
        params.scope.workspaceId !== params.workspaceId
      ) {
        throw workspaceNotFound();
      }
      // The index lookup stays first: it keeps unknown ids off the config path.
      const index = await services.readWorkspaceIndexEntry(params.workspaceId);
      if (!index) throw workspaceNotFound();
      const { config, detail } = await readConfig(services, params.workspaceId);
      capture?.captureConfig(config, detail);
      if (
        params.scope?.organizationId !== undefined &&
        config.owner?.organizationId !== params.scope.organizationId
      ) {
        throw workspaceNotFound();
      }
      const effective = await services.readEffectiveWorkspaceConfig(
        params.workspaceId,
        config,
      );
      return {
        workspaceId: params.workspaceId,
        name: index.name,
        kind: index.type === 'cowork' ? 'cowork' : 'git',
        repositorySources: projectRepositorySources(effective.repos),
        settings: {},
      };
    },
    'core.worktree.list': async (
      params: CanopyQueryParams<'core.worktree.list'>,
    ): Promise<CanopyQueryResult<'core.worktree.list'>> => {
      checkScope(params.scope);
      checkWorktreeScope(params.scope);
      const workspaceId = params.scope?.workspaceId;
      if (workspaceId) {
        await checkWorktreeWorkspaceId(workspaceId, services);
        const { worktrees, detail } = await readWorktrees(
          services,
          workspaceId,
        );
        capture?.captureWorktrees(worktrees, detail);
        const config = params.scope?.organizationId
          ? await services.readWorkspaceConfig(workspaceId)
          : undefined;
        return paginate(
          worktrees
            .filter(
              (worktree) =>
                (params.scope?.worktreeId === undefined ||
                  worktree.id === params.scope.worktreeId) &&
                (params.scope?.organizationId === undefined ||
                  config?.owner?.organizationId ===
                    params.scope.organizationId),
            )
            .map((worktree) => projectWorktree(workspaceId, worktree)),
          params.pageSize,
          params.cursor,
        );
      }
      const { file: sidebar, detail } = await readSidebar(services);
      capture?.captureSidebar(sidebar, detail);
      const items = sidebar.items.flatMap((item) =>
        item.type === 'cowork' ||
        (params.scope?.organizationId !== undefined &&
          item.owner?.organizationId !== params.scope.organizationId)
          ? []
          : item.worktrees
              .filter(
                (worktree) =>
                  params.scope?.worktreeId === undefined ||
                  worktree.id === params.scope.worktreeId,
              )
              .map((worktree) => projectWorktree(item.id, worktree)),
      );
      return paginate(items, params.pageSize, params.cursor);
    },
    'core.worktree.get': async (
      params: CanopyQueryParams<'core.worktree.get'>,
    ): Promise<CanopyQueryResult<'core.worktree.get'>> => {
      checkScope(params.scope);
      checkWorktreeScope(params.scope);
      if (
        params.scope?.worktreeId !== undefined &&
        params.scope.worktreeId !== params.worktreeId
      )
        throw worktreeNotFound();
      const workspaceId = params.scope?.workspaceId;
      if (workspaceId) {
        await checkWorktreeWorkspaceId(workspaceId, services);
        if (params.scope?.organizationId !== undefined) {
          const config = await services.readWorkspaceConfig(workspaceId);
          if (config.owner?.organizationId !== params.scope.organizationId)
            throw worktreeNotFound();
        }
        const worktrees = await services.readWorkspaceWorktrees(workspaceId);
        const worktree = worktrees.find(
          (entry) => entry.id === params.worktreeId,
        );
        if (worktree) {
          capture?.captureWorktree(worktree);
          return projectWorktree(workspaceId, worktree);
        }
        throw worktreeNotFound();
      }
      const sidebar = await services.readAllSidebarItems();
      let match: { workspaceId: string; worktree: WorktreeData } | undefined;
      for (const item of sidebar.items) {
        if (
          item.type === 'cowork' ||
          (params.scope?.organizationId !== undefined &&
            item.owner?.organizationId !== params.scope.organizationId)
        )
          continue;
        const worktree = item.worktrees.find(
          (entry) => entry.id === params.worktreeId,
        );
        if (worktree) {
          if (match)
            throw new CanopyOperationError({
              kind: 'invalid_argument',
              message: 'Workspace scope required for ambiguous worktree ID.',
              retry: { kind: 'never' },
            });
          match = { workspaceId: item.id, worktree };
        }
      }
      if (match) {
        capture?.captureWorktree(match.worktree);
        return projectWorktree(match.workspaceId, match.worktree);
      }
      throw worktreeNotFound();
    },
  };
}
