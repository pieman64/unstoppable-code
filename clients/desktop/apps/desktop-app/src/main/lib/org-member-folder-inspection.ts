import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  OrgMemberFolderInspection,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { computeRelationships } from './org-project-relationships';
import { normalizeRemoteUrl } from './repo-url-matcher';
import {
  getGitCommonDir,
  getRemoteUrlStrict,
  getWorktreeTopLevel,
  isGitRepo,
} from './git';
import { hasManifestRepos, readCanopyJson } from './canopy-json';
import {
  resolveMultiRepoRepositories,
  type MultiRepoCheckout,
} from './org-member-multi-repo-repositories';
import { rejectUnsafeManifest } from './org-project-materialization';
import { readAllSidebarItems } from './sidebar-items';
import { assertFolderIsImportable } from './workspace-service';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';

export interface OrgMemberFolderInspectorDeps {
  realpath(path: string): Promise<string>;
  git: {
    topLevel(path: string): Promise<string | null>;
    commonDir(path: string): Promise<string>;
    remoteUrl(path: string): Promise<string | null>;
  };
  manifest: {
    rejectUnsafe(path: string): Promise<void>;
    hasMultipleRepos(path: string): Promise<boolean>;
    /** The repositories a multi-repo project file lists. */
    repositories(
      path: string,
    ): Promise<readonly { readonly name: string; readonly url: string }[]>;
  };
  sidebar: {
    list(): Promise<SidebarItem[]>;
    assertImportable(
      path: string,
      items: SidebarItem[],
      options: { readonly allowInsideDataDir: boolean },
    ): Promise<void>;
  };
  catalog: {
    refresh(organizationId: string): Promise<{
      readonly projects: readonly OrgProjectSummary[];
      /** The refresh failed or fell back to a cached list. */
      readonly stale: boolean;
    }>;
  };
}

export interface OrgMemberFolderInspectionOptions {
  readonly allowInsideDataDir?: boolean;
}

export interface OrgMemberFolderInspector {
  inspect(
    organizationId: string,
    path: string,
    options?: OrgMemberFolderInspectionOptions,
  ): Promise<OrgMemberFolderInspection>;
  /**
   * Whether an organization's Existing folder could take this folder at all:
   * it is not an organization project already and overlaps no other project.
   * The same placement step `inspect` runs first, with no catalog read, so
   * the create-time nudge never offers an add `inspect` would refuse.
   */
  canPlace(
    path: string,
    options?: OrgMemberFolderInspectionOptions,
  ): Promise<boolean>;
}

/** Where a folder sits among the device's projects. */
type FolderPlacement =
  | { ok: false; reason: 'already-org-project' | 'overlaps-project' }
  | {
      ok: true;
      /** The Personal single-repo project this folder is, if any. */
      personalWorkspaceId?: string;
      /** The Personal multi-repo project whose root this folder is, if any. */
      personalMultiRepo?: Extract<SidebarItem, { type: 'multi-repo' }>;
    };

export function createOrgMemberFolderInspector(
  deps: OrgMemberFolderInspectorDeps,
): OrgMemberFolderInspector {
  function matchingProjects(
    catalog: readonly OrgProjectSummary[],
    remoteUrl: string,
  ): OrgProjectSummary[] {
    const matches: OrgProjectSummary[] = [];
    for (const project of catalog) {
      if (
        project.kind !== 'CODE' ||
        project.visibility !== 'organization' ||
        project.repository === null
      ) {
        continue;
      }
      const projectWithUse: OrgProjectSummary = {
        ...project,
        capabilities: { ...project.capabilities, use: true },
      };
      if (
        computeRelationships(
          [projectWithUse],
          [{ id: 'folder-inspection', type: 'single-repo', remoteUrl }],
        ).length > 0
      ) {
        matches.push(project);
      }
    }
    return matches;
  }

  /**
   * A multi-repo project is the organization's to take only when every
   * repository in it is one of the organization's projects (CAN-3546).
   */
  async function multiRepoInspection(
    organizationId: string,
    checkouts: readonly MultiRepoCheckout[],
    personalWorkspaceId: string | undefined,
  ): Promise<OrgMemberFolderInspection> {
    const snapshot = await deps.catalog.refresh(organizationId);
    // A catalog that could not be refreshed proves nothing either way.
    if (snapshot.stale) return { kind: 'refused', reason: 'unreadable' };
    const catalog = snapshot.projects.filter(
      (project): boolean =>
        project.organizationId?.toLowerCase() === organizationId.toLowerCase(),
    );
    const resolution = resolveMultiRepoRepositories(catalog, checkouts);
    if (!resolution.ok)
      return resolution.reason === 'outside-organization'
        ? {
            kind: 'refused',
            reason: 'outside-organization',
            repositories: [...resolution.outside],
          }
        : { kind: 'refused', reason: 'unreadable' };
    return {
      kind: 'multi-repo',
      repositoryCount: resolution.repositoryProjectIds.length,
      ...(personalWorkspaceId ? { personalWorkspaceId } : {}),
    };
  }

  /**
   * The placement step of the folder check: the Personal project the folder
   * already is, or why no organization could take it.
   */
  async function placeFolder(
    path: string,
    options: OrgMemberFolderInspectionOptions,
  ): Promise<FolderPlacement> {
    const items = await deps.sidebar.list();
    let personalWorkspaceId: string | undefined;
    let personalMultiRepo:
      | Extract<SidebarItem, { type: 'multi-repo' }>
      | undefined;
    const remaining: SidebarItem[] = [];
    for (const item of items) {
      const roots =
        item.type === 'single-repo'
          ? [item.repoPath]
          : item.type === 'multi-repo'
            ? [item.sourceRepoPath, ...item.repos.map((repo) => repo.repoPath)]
            : item.externalPath
              ? [item.externalPath]
              : [];
      const exact = (
        await Promise.all(
          roots
            .filter((root): root is string => typeof root === 'string')
            .map((root) => deps.realpath(root).catch(() => null)),
        )
      ).some((root) => root === path);
      if (!exact) {
        remaining.push(item);
        continue;
      }
      if (item.owner?.type === 'organization') {
        return { ok: false, reason: 'already-org-project' };
      }
      // A Personal multi-repo project's own root folder (CAN-3546).
      if (
        item.type === 'multi-repo' &&
        item.temporary !== true &&
        item.sourceRepoPath !== undefined &&
        (await deps.realpath(item.sourceRepoPath).catch(() => null)) === path
      ) {
        personalMultiRepo = item;
        continue;
      }
      if (item.type !== 'single-repo') {
        return { ok: false, reason: 'overlaps-project' };
      }
      personalWorkspaceId = item.id;
    }
    try {
      await deps.sidebar.assertImportable(path, remaining, {
        allowInsideDataDir:
          options.allowInsideDataDir === true ||
          personalWorkspaceId !== undefined ||
          personalMultiRepo !== undefined,
      });
    } catch {
      return { ok: false, reason: 'overlaps-project' };
    }
    return {
      ok: true,
      ...(personalWorkspaceId === undefined ? {} : { personalWorkspaceId }),
      ...(personalMultiRepo === undefined ? {} : { personalMultiRepo }),
    };
  }

  return {
    async inspect(
      organizationId,
      candidatePath,
      options = {},
    ): Promise<OrgMemberFolderInspection> {
      try {
        const path = await deps.realpath(candidatePath);
        const topLevel = await deps.git.topLevel(path);
        const placement = await placeFolder(path, options);
        if (!placement.ok) return { kind: 'refused', reason: placement.reason };
        const { personalWorkspaceId, personalMultiRepo } = placement;
        if (personalMultiRepo !== undefined) {
          const checkouts: MultiRepoCheckout[] = [];
          for (const repo of personalMultiRepo.repos)
            checkouts.push({
              name: repo.name,
              remoteUrl: await deps.git.remoteUrl(repo.repoPath),
              root: false,
            });
          return multiRepoInspection(
            organizationId,
            [
              {
                name: personalMultiRepo.name,
                remoteUrl: await deps.git.remoteUrl(path),
                root: true,
              },
              ...checkouts,
            ],
            personalMultiRepo.id,
          );
        }
        if (topLevel === null) return { kind: 'cowork' };
        const canonicalTopLevel = await deps.realpath(topLevel);
        if (canonicalTopLevel !== path) {
          return { kind: 'refused', reason: 'inside-repo' };
        }
        const commonDir = await deps.git.commonDir(path);
        const ownGitDir = await deps
          .realpath(join(path, '.git'))
          .catch(() => resolve(path, '.git'));
        if (resolve(commonDir) !== resolve(ownGitDir)) {
          return { kind: 'refused', reason: 'linked-worktree' };
        }
        await deps.manifest.rejectUnsafe(path);
        if (await deps.manifest.hasMultipleRepos(path)) {
          const repositories = await deps.manifest.repositories(path);
          return multiRepoInspection(
            organizationId,
            [
              {
                name: basename(path),
                remoteUrl: await deps.git.remoteUrl(path),
                root: true,
              },
              ...repositories.map(
                (repository): MultiRepoCheckout => ({
                  name: repository.name,
                  remoteUrl: repository.url,
                  root: false,
                }),
              ),
            ],
            undefined,
          );
        }
        const remoteUrl = await deps.git.remoteUrl(path);
        const normalized =
          remoteUrl === null ? null : normalizeRemoteUrl(remoteUrl, true);
        const segments = normalized?.split('/') ?? [];
        const repository =
          segments.length === 3 && segments[0] === 'github.com'
            ? {
                host: 'github.com' as const,
                owner: segments[1] ?? '',
                name: segments[2] ?? '',
              }
            : null;
        let target: 'new' | { projectId: string; projectName: string } = 'new';
        if (repository && remoteUrl) {
          const catalog = (await deps.catalog.refresh(organizationId)).projects;
          const matches = matchingProjects(catalog, remoteUrl);
          if (matches.length > 1) {
            return { kind: 'refused', reason: 'ambiguous' };
          }
          const match = matches[0];
          if (match && !match.capabilities.use) {
            return { kind: 'refused', reason: 'no-access' };
          }
          if (match) {
            target = { projectId: match.id, projectName: match.name };
          }
        }
        return {
          kind: 'code',
          target,
          repository,
          ...(personalWorkspaceId ? { personalWorkspaceId } : {}),
        };
      } catch {
        return { kind: 'refused', reason: 'unreadable' };
      }
    },
    async canPlace(candidatePath, options = {}): Promise<boolean> {
      try {
        return (await placeFolder(await deps.realpath(candidatePath), options))
          .ok;
      } catch {
        return false;
      }
    },
  };
}

let inspector: OrgMemberFolderInspector | undefined;

export function getOrgMemberFolderInspector(): OrgMemberFolderInspector {
  inspector ??= createOrgMemberFolderInspector({
    realpath,
    git: {
      topLevel: async (path): Promise<string | null> =>
        (await isGitRepo(path)) ? getWorktreeTopLevel(path) : null,
      commonDir: getGitCommonDir,
      remoteUrl: getRemoteUrlStrict,
    },
    manifest: {
      rejectUnsafe: rejectUnsafeManifest,
      hasMultipleRepos: async (path): Promise<boolean> =>
        hasManifestRepos(await readCanopyJson(path)),
      repositories: async (
        path,
      ): Promise<readonly { name: string; url: string }[]> =>
        (await readCanopyJson(path))?.repos ?? [],
    },
    sidebar: {
      list: async (): Promise<SidebarItem[]> =>
        (await readAllSidebarItems()).items,
      assertImportable: assertFolderIsImportable,
    },
    catalog: {
      refresh: async (organizationId) => {
        const snapshot = await getOrgProjectCatalogService().refresh(
          { kind: 'organization', organizationId },
          { force: true },
        );
        return {
          projects: snapshot.projects,
          stale: snapshot.stale || Boolean(snapshot.error),
        };
      },
    },
  });
  return inspector;
}

export function resetOrgMemberFolderInspectorForTests(): void {
  inspector = undefined;
}
