import { z } from 'zod';
import type {
  SidebarItemGroup,
  SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import type { WorkspaceContextState } from '@canopy/protocol/workspace-context';
import {
  workspaceSettingsCapabilities,
  workspaceSummary,
  worktreeSummary,
} from '@canopy/desktop-shared/lib/app-advisor-worktree-summaries';
import {
  trackedPlanCommentThreadResult,
  trackedPlanCommentThreadsResult,
  trackedPlanGetResult,
  trackedPlanListResult,
} from '@canopy/desktop-shared/lib/app-advisor-tracked-plan-results';
import { sidebarItemGroupIds } from '@canopy/desktop-shared/lib/sidebar-item-group-actions';
import { sidebarGroupStackUnits } from '@canopy/desktop-shared/lib/worktree-grouping';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import type {
  AdhocMultiRepoJoinOptionsResponse,
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  DesktopOrgProjectCatalogSnapshot,
  ExistingWorktreeJoinOptionsResponse,
  ExistingWorktreeJoinWorkspaceGroup,
  MultiRepoSidebarItem,
  ReadWorkspaceReadinessResponse,
  ResolvedProjectStartPage,
  SidebarItem,
  SingleRepoSidebarItem,
  TrackedPlanData,
  WorkspaceSettingsDataResponse,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';

/*
 * CAN-5998: App Advisor's project, organization project, sidebar group and
 * tracked-plan reads, and its sidebar group writes, in Electron main. Each
 * answers as the renderer dispatcher did, from main's own owners: the
 * sidebar items, the project settings, start page, readiness and join-option
 * readers, the selected workspace context and organization project catalog,
 * the sidebar item group service and the tracked plans service.
 */

export const ADVISOR_WORKSPACE_ACTION_TYPES = [
  'workspace.list',
  'workspace.get_settings',
  'workspace.get_start_page',
  'workspace.list_worktrees',
  'workspace.list_join_options',
  'workspace.list_existing_worktree_join_options',
  'workspace.read_readiness',
  'org_project.list',
  'sidebar.item_groups.list',
  'sidebar.item_groups.list_items',
  'sidebar.item_groups.create',
  'sidebar.item_groups.update',
  'sidebar.item_groups.set_item',
  'sidebar.item_groups.move_item',
  'sidebar.item_groups.move_group',
  'sidebar.item_groups.ungroup',
  'tracked-plan.list',
  'tracked-plan.get',
  'tracked-plan.list_comment_threads',
  'tracked-plan.get_comment_thread',
] as const;

type AdvisorWorkspaceActionType =
  (typeof ADVISOR_WORKSPACE_ACTION_TYPES)[number];

export type AdvisorWorkspaceAction = Extract<
  AppAdvisorAction,
  { type: AdvisorWorkspaceActionType }
>;

type SidebarGroupAction = Extract<
  AdvisorWorkspaceAction,
  { type: `sidebar.item_groups.${string}` }
>;

type TrackedPlanAction = Extract<
  AdvisorWorkspaceAction,
  { type: `tracked-plan.${string}` }
>;

export function isAdvisorWorkspaceAction(action: {
  type: string;
}): action is AdvisorWorkspaceAction {
  return ADVISOR_WORKSPACE_ACTION_TYPES.some((type) => type === action.type);
}

/** The main owners these actions use; tests replace them. */
export interface AdvisorWorkspaceActionHost {
  readItems(): Promise<SidebarItem[]>;
  /** Tells every window to reload a project's worktree rows; never throws. */
  announceWorktrees(workspaceId: string): void;
  /** The "group child branches with their base" preference. */
  readGroupChildBranchesWithBase(): Promise<boolean>;
  readSettingsData(
    workspaceId: string,
    worktreeId?: string,
  ): Promise<WorkspaceSettingsDataResponse>;
  /** The project's CLAUDE.md through core.workspace.instructions.get. */
  readInstructions(workspaceId: string): Promise<string>;
  isStartPageEnabled(): boolean;
  resolveStartPage(request: {
    projectId: string;
    worktreeId?: string;
  }): Promise<ResolvedProjectStartPage | null>;
  readReadiness(
    workspaceId: string,
    worktreeId?: string,
  ): Promise<ReadWorkspaceReadinessResponse>;
  listJoinOptions(request: {
    sourceWorkspaceId: string;
  }): Promise<AdhocMultiRepoJoinOptionsResponse>;
  listExistingWorktreeJoinOptions(request: {
    sourceWorkspaceId: string;
    sourceWorktreeId: string;
  }): Promise<ExistingWorktreeJoinOptionsResponse>;
  readWorkspaceContext(): Promise<WorkspaceContextState>;
  listOrgProjects(
    context: WorkspaceContextState['context'],
  ): Promise<DesktopOrgProjectCatalogSnapshot>;
  listTrackedPlans(request: {
    projectId: string;
    worktreeId: string;
  }): Promise<TrackedPlanData[]>;
  readTrackedPlan(request: {
    projectId: string;
    worktreeId: string;
    planId: string;
  }): Promise<TrackedPlanData | null>;
  sidebarGroups: {
    /** Groups in sidebar order, each with its `order`. */
    describe(
      scope: SidebarItemGroupScope,
    ): Promise<Array<SidebarItemGroup & { order: number }>>;
    /** Groups in left-nav order. */
    list(scope: SidebarItemGroupScope): Promise<SidebarItemGroup[]>;
    listItems(request: {
      scope: SidebarItemGroupScope;
      groupId: string;
    }): Promise<{
      group: SidebarItemGroup;
      items: Array<{
        id: string;
        name: string;
        kind: 'worktree' | 'work-entry';
        groupId: string;
        createdAt: string;
      }>;
    }>;
    create(request: {
      scope: SidebarItemGroupScope;
      itemId: string;
      name?: string;
      color?: SidebarItemGroup['color'];
      labelHidden?: boolean;
    }): Promise<SidebarItemGroup>;
    update(request: {
      scope: SidebarItemGroupScope;
      groupId: string;
      name?: string;
      color?: SidebarItemGroup['color'];
      collapsed?: boolean;
      labelHidden?: boolean;
      keepWhenEmpty?: boolean;
    }): Promise<void>;
    ungroup(request: {
      scope: SidebarItemGroupScope;
      groupId: string;
    }): Promise<void>;
    moveItem(request: {
      scope: SidebarItemGroupScope;
      itemId: string;
      groupId: string | null;
      before?: string;
      after?: string;
    }): Promise<void>;
    moveGroup(request: {
      scope: SidebarItemGroupScope;
      groupId: string;
      before?: string;
      after?: string;
    }): Promise<void>;
  };
}

type Outcome = Omit<AppAdvisorActionResponse, 'requestId'>;

const ORG_CONTEXT_REQUIRED: AppAdvisorActionError = {
  code: 'surface_unavailable',
  message:
    'Organization projects are only available while an organization context is selected. Choose an organization from the context switcher above the account in the sidebar first.',
};

const START_PAGE_UNAVAILABLE: AppAdvisorActionError = {
  code: 'surface_unavailable',
  message: 'Project start pages are not available.',
  retryable: false,
};

function failure(error: AppAdvisorActionError): Outcome {
  return { ok: false, error };
}

function jsonValue(value: unknown): AppAdvisorJson {
  return z.json().parse(JSON.parse(JSON.stringify(value ?? null)));
}

/** The renderer's required-string check: the schema admits empty strings. */
function missingFields(
  action: AdvisorWorkspaceAction,
  fields: readonly string[],
): Outcome | null {
  const record: Record<string, unknown> = { ...action };
  const missing = fields.filter(
    (field) => typeof record[field] !== 'string' || record[field] === '',
  );
  return missing.length > 0
    ? failure({
        code: 'invalid_payload',
        message: `Action ${action.type} requires ${missing.join(', ')}.`,
      })
    : null;
}

const ID_FIELDS = [
  'workspaceId',
  'worktreeId',
  'sourceWorkspaceId',
  'sourceWorktreeId',
  'projectId',
  'planId',
] as const;

/**
 * The window's IPC handlers validate every id before an owner builds a path
 * from it; an id an owner would join into a path is refused the same way.
 */
function invalidIds(action: AdvisorWorkspaceAction): Outcome | null {
  const record: Record<string, unknown> = { ...action };
  for (const field of ID_FIELDS) {
    // An empty optional id means omitted, as in the renderer.
    if (record[field] === undefined || record[field] === '') continue;
    try {
      validateId(record[field], field);
    } catch {
      return failure({
        code: 'invalid_payload',
        message: `Action ${action.type} has invalid ${field}.`,
      });
    }
  }
  return null;
}

function visibleWorkspaces(items: SidebarItem[]): SidebarItem[] {
  return items.filter((item) => !isRetiredTemporaryWorkspace(item));
}

function findWorkspace(
  items: SidebarItem[],
  workspaceId: string,
): SidebarItem | { error: AppAdvisorActionError } {
  return (
    visibleWorkspaces(items).find((item) => item.id === workspaceId) ?? {
      error: {
        code: 'not_found',
        message: `Project ${workspaceId} was not found.`,
      },
    }
  );
}

function findGitWorkspace(
  items: SidebarItem[],
  workspaceId: string,
):
  | SingleRepoSidebarItem
  | MultiRepoSidebarItem
  | { error: AppAdvisorActionError } {
  const workspace = findWorkspace(items, workspaceId);
  if ('error' in workspace) return workspace;
  if (workspace.type === 'cowork')
    return {
      error: {
        code: 'unsupported_action',
        message: `Project ${workspaceId} is a cowork project and has no git worktrees.`,
      },
    };
  return workspace;
}

function findSourceWorktree(
  items: SidebarItem[],
  action: { sourceWorkspaceId: string; sourceWorktreeId: string },
):
  | {
      workspace: SingleRepoSidebarItem | MultiRepoSidebarItem;
      worktree: WorktreeData;
    }
  | { error: AppAdvisorActionError } {
  const workspace = findGitWorkspace(items, action.sourceWorkspaceId);
  if ('error' in workspace) return workspace;
  const worktree = workspace.worktrees.find(
    (candidate) => candidate.id === action.sourceWorktreeId,
  );
  if (!worktree)
    return {
      error: {
        code: 'not_found',
        message: `Worktree ${action.sourceWorktreeId} was not found in project ${action.sourceWorkspaceId}.`,
      },
    };
  return { workspace, worktree };
}

function joinModes(
  workspace: SingleRepoSidebarItem | MultiRepoSidebarItem,
): string[] {
  return workspace.type === 'multi-repo' && workspace.temporary !== true
    ? ['temporary', 'update-source-workspace']
    : ['temporary'];
}

/** Each worktree's sidebar group, with branch stacks following their root. */
async function worktreeGroupIds(
  host: AdvisorWorkspaceActionHost,
  projectId: string,
  worktrees: readonly WorktreeData[],
  groupingEnabled: () => Promise<boolean>,
): Promise<Map<string, string>> {
  if (worktrees.length === 0) return new Map();
  const groups = await host.sidebarGroups.list({ workspaceLocalId: projectId });
  if (groups.length === 0) return new Map();
  return sidebarItemGroupIds(
    groups,
    sidebarGroupStackUnits(worktrees, await groupingEnabled()),
  );
}

function onceGroupingPreference(
  host: AdvisorWorkspaceActionHost,
): () => Promise<boolean> {
  let preference: Promise<boolean> | undefined;
  return () => {
    preference ??= host.readGroupChildBranchesWithBase();
    return preference;
  };
}

async function listWorkspaces(
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const items = await host.readItems();
  const workspaces = visibleWorkspaces(items);
  return {
    ok: true,
    result: {
      totalWorkspaces: workspaces.length,
      excludedSoftDeletedTemporaryWorkspaces: items.length - workspaces.length,
      workspaces: workspaces.map(workspaceSummary),
    },
  };
}

async function getSettings(
  action: Extract<AdvisorWorkspaceAction, { type: 'workspace.get_settings' }>,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  // The project must be one the sidebar lists before anything, including
  // its CLAUDE.md, is read.
  const workspace = findWorkspace(await host.readItems(), action.workspaceId);
  if ('error' in workspace) return failure(workspace.error);
  const [settingsData, claudeMd] = await Promise.all([
    host.readSettingsData(action.workspaceId, action.worktreeId || undefined),
    action.includeClaudeMd === true
      ? host.readInstructions(action.workspaceId)
      : Promise.resolve(undefined),
  ]);
  return {
    ok: true,
    result: {
      workspace: workspaceSummary(workspace),
      capabilities: workspaceSettingsCapabilities(workspace),
      settingsData: jsonValue(settingsData),
      ...(claudeMd !== undefined ? { claudeMd } : {}),
    },
  };
}

async function getStartPage(
  action: Extract<AdvisorWorkspaceAction, { type: 'workspace.get_start_page' }>,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  if (!host.isStartPageEnabled()) return failure(START_PAGE_UNAVAILABLE);
  const workspace = findWorkspace(await host.readItems(), action.workspaceId);
  if ('error' in workspace) return failure(workspace.error);
  const resolved = await host.resolveStartPage({
    projectId: action.workspaceId,
    ...(action.worktreeId ? { worktreeId: action.worktreeId } : {}),
  });
  return {
    ok: true,
    result: {
      resolved: resolved
        ? {
            source: resolved.source,
            startPage:
              resolved.startPage.kind === 'url'
                ? { kind: 'url', url: resolved.startPage.url }
                : {
                    kind: 'file',
                    path: resolved.startPage.path,
                    ...(resolved.startPage.repoId
                      ? { repoId: resolved.startPage.repoId }
                      : {}),
                  },
          }
        : null,
    },
  };
}

async function listWorktrees(
  action: Extract<AdvisorWorkspaceAction, { type: 'workspace.list_worktrees' }>,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const workspace = findGitWorkspace(
    await host.readItems(),
    action.workspaceId,
  );
  if ('error' in workspace) return failure(workspace.error);
  const memberships = await worktreeGroupIds(
    host,
    workspace.id,
    workspace.worktrees,
    onceGroupingPreference(host),
  );
  return {
    ok: true,
    result: {
      workspace: workspaceSummary(workspace),
      totalWorktrees: workspace.worktrees.length,
      worktrees: workspace.worktrees.map((item) =>
        worktreeSummary(item, memberships.get(item.id)),
      ),
    },
  };
}

async function listJoinOptions(
  action: Extract<
    AdvisorWorkspaceAction,
    { type: 'workspace.list_join_options' }
  >,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const source = findSourceWorktree(await host.readItems(), action);
  if ('error' in source) return failure(source.error);
  const response = await host.listJoinOptions({
    sourceWorkspaceId: action.sourceWorkspaceId,
  });
  return {
    ok: true,
    result: {
      sourceWorkspace: workspaceSummary(source.workspace),
      sourceWorktree: worktreeSummary(source.worktree),
      allowedModes: joinModes(source.workspace),
      totalOptions: response.options.length,
      options: jsonValue(response.options),
    },
  };
}

async function existingWorktreeJoinGroups(
  groups: ExistingWorktreeJoinWorkspaceGroup[],
  items: SidebarItem[],
  host: AdvisorWorkspaceActionHost,
): Promise<AppAdvisorJson> {
  const groupingEnabled = onceGroupingPreference(host);
  const membershipsByWorkspace = new Map<
    string,
    Promise<Map<string, string>>
  >();
  return Promise.all(
    groups.map(async (group): Promise<AppAdvisorJson> => {
      let membership = membershipsByWorkspace.get(group.workspaceId);
      if (!membership) {
        const workspace = items.find((item) => item.id === group.workspaceId);
        membership = worktreeGroupIds(
          host,
          group.workspaceId,
          workspace && workspace.type !== 'cowork' ? workspace.worktrees : [],
          groupingEnabled,
        );
        membershipsByWorkspace.set(group.workspaceId, membership);
      }
      // Group labels are a convenience; a failed read leaves them out.
      const memberships = await membership.catch(
        () => new Map<string, string>(),
      );
      return {
        workspaceId: group.workspaceId,
        workspaceName: group.workspaceName,
        color: group.color,
        isMultiRepo: group.isMultiRepo,
        repoCount: group.repoCount,
        temporary: group.temporary,
        candidates: group.candidates.map((candidate) => {
          const groupId = memberships.get(candidate.worktreeId);
          return {
            workspaceId: candidate.workspaceId,
            worktreeId: candidate.worktreeId,
            ...(groupId ? { groupId } : {}),
            branchName: candidate.branchName,
            ...(candidate.busyReason
              ? { busyReason: candidate.busyReason }
              : {}),
            addsNewRepo: candidate.addsNewRepo,
            repoOverlaps: candidate.repoOverlaps.map((overlap) => ({
              repoName: overlap.repoName,
              sourceHasChanges: overlap.sourceHasChanges,
              targetHasChanges: overlap.targetHasChanges,
              sourceBranch: overlap.sourceBranch,
              targetBranch: overlap.targetBranch,
            })),
          };
        }),
      };
    }),
  );
}

async function listExistingWorktreeJoinOptions(
  action: Extract<
    AdvisorWorkspaceAction,
    { type: 'workspace.list_existing_worktree_join_options' }
  >,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const items = await host.readItems();
  const source = findSourceWorktree(items, action);
  if ('error' in source) return failure(source.error);
  const response = await host.listExistingWorktreeJoinOptions({
    sourceWorkspaceId: action.sourceWorkspaceId,
    sourceWorktreeId: action.sourceWorktreeId,
  });
  return {
    ok: true,
    result: {
      sourceWorkspace: workspaceSummary(source.workspace),
      sourceWorktree: worktreeSummary(source.worktree),
      allowedModes: joinModes(source.workspace),
      totalGroups: response.groups.length,
      totalCandidates: response.groups.reduce(
        (sum, group) => sum + group.candidates.length,
        0,
      ),
      groups: await existingWorktreeJoinGroups(response.groups, items, host),
    },
  };
}

async function readReadiness(
  action: Extract<AdvisorWorkspaceAction, { type: 'workspace.read_readiness' }>,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const workspace = findGitWorkspace(
    await host.readItems(),
    action.workspaceId,
  );
  if ('error' in workspace) return failure(workspace.error);
  const response = await host.readReadiness(
    action.workspaceId,
    action.worktreeId || undefined,
  );
  return {
    ok: true,
    result: {
      workspace: workspaceSummary(workspace),
      issues: response.issues.map((issue) => ({
        code: issue.code,
        title: issue.title,
        message: issue.message,
        repoName: issue.repoName,
        ...(issue.repoId ? { repoId: issue.repoId } : {}),
      })),
    },
  };
}

async function listOrgProjects(
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  // Main's workspace context is the selected organization the window shows.
  const { context } = await host.readWorkspaceContext();
  if (context.kind !== 'organization') return failure(ORG_CONTEXT_REQUIRED);
  const snapshot = await host.listOrgProjects(context);
  return {
    ok: true,
    result: {
      organizationId: context.organizationId,
      stale: snapshot.stale,
      error: snapshot.error,
      totalProjects: snapshot.projects.length,
      projects: snapshot.projects.map((project) => ({
        projectId: project.id,
        name: project.name,
        kind: project.kind,
        listed: project.listed,
        repository: project.repository
          ? `${project.repository.owner}/${project.repository.name}`
          : null,
        verification: project.repository?.verification ?? null,
        instanceState: project.instance?.state ?? null,
      })),
    },
  };
}

async function sidebarGroupAction(
  action: SidebarGroupAction,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const { scope } = action;
  // A code project's rows carry branch-stack grouping, so a write there
  // reloads the windows' worktrees; work entries announce their own.
  let codeProjectId: string | undefined;
  if (!scope.appAdvisor) {
    const workspace = findWorkspace(
      await host.readItems(),
      scope.workspaceLocalId,
    );
    if ('error' in workspace) return failure(workspace.error);
    if (workspace.type !== 'cowork') codeProjectId = workspace.id;
  }
  const groups = host.sidebarGroups;
  if (action.type === 'sidebar.item_groups.list_items') {
    const listed = await groups.listItems({ scope, groupId: action.groupId });
    return {
      ok: true,
      result: jsonValue({
        group: {
          id: listed.group.id,
          name: listed.group.name,
          color: listed.group.color,
          collapsed: listed.group.collapsed,
          memberIds: listed.group.memberIds,
        },
        items: listed.items,
        returned: listed.items.length,
      }),
    };
  }
  if (action.type === 'sidebar.item_groups.list')
    return {
      ok: true,
      result: jsonValue({ groups: await groups.describe(scope) }),
    };
  let createdId: string | undefined;
  switch (action.type) {
    case 'sidebar.item_groups.set_item':
      if (action.newGroup !== undefined) {
        createdId = (
          await groups.create({
            scope,
            itemId: action.itemId,
            ...action.newGroup,
          })
        ).id;
      } else {
        await groups.moveItem({
          scope,
          itemId: action.itemId,
          groupId: action.groupId ?? null,
        });
      }
      break;
    case 'sidebar.item_groups.create':
      createdId = (
        await groups.create({
          scope,
          itemId: action.itemId,
          name: action.name,
          color: action.color,
          labelHidden: action.labelHidden,
        })
      ).id;
      break;
    case 'sidebar.item_groups.update':
      await groups.update({
        scope,
        groupId: action.groupId,
        name: action.name,
        color: action.color,
        collapsed: action.collapsed,
        labelHidden: action.labelHidden,
        keepWhenEmpty: action.keepWhenEmpty,
      });
      break;
    case 'sidebar.item_groups.ungroup':
      await groups.ungroup({ scope, groupId: action.groupId });
      break;
    case 'sidebar.item_groups.move_item':
      await groups.moveItem({
        scope,
        itemId: action.itemId,
        groupId: action.groupId,
        ...(action.before
          ? { before: action.before }
          : action.after
            ? { after: action.after }
            : {}),
      });
      break;
    case 'sidebar.item_groups.move_group':
      await groups.moveGroup({
        scope,
        groupId: action.groupId,
        ...(action.before
          ? { before: action.before }
          : action.after
            ? { after: action.after }
            : {}),
      });
      break;
  }
  if (codeProjectId !== undefined) host.announceWorktrees(codeProjectId);
  let described: Array<SidebarItemGroup & { order: number }>;
  try {
    described = await groups.describe(scope);
  } catch {
    // The write landed; only the refreshed group list failed.
    return {
      ok: true,
      result: jsonValue({
        applied: action.type,
        groupId: createdId ?? ('groupId' in action ? action.groupId : null),
        ...('itemId' in action ? { itemId: action.itemId } : {}),
        refreshFailed: true,
      }),
    };
  }
  return {
    ok: true,
    result: jsonValue({
      ...(createdId ? { groupId: createdId } : {}),
      ...(action.type === 'sidebar.item_groups.set_item'
        ? {
            itemId: action.itemId,
            groupId: createdId ?? action.groupId ?? null,
          }
        : {}),
      groups: described,
    }),
  };
}

async function trackedPlanAction(
  action: TrackedPlanAction,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  const target = { projectId: action.projectId, worktreeId: action.worktreeId };
  switch (action.type) {
    case 'tracked-plan.list':
      return trackedPlanListResult(action, await host.listTrackedPlans(target));
    case 'tracked-plan.get':
      return trackedPlanGetResult(
        action,
        await host.readTrackedPlan({ ...target, planId: action.planId }),
      );
    case 'tracked-plan.list_comment_threads':
      return trackedPlanCommentThreadsResult(
        action,
        await host.readTrackedPlan({ ...target, planId: action.planId }),
      );
    case 'tracked-plan.get_comment_thread':
      return trackedPlanCommentThreadResult(
        action,
        await host.readTrackedPlan({ ...target, planId: action.planId }),
      );
  }
}

const REQUIRED_FIELDS: Partial<
  Record<AdvisorWorkspaceActionType, readonly string[]>
> = {
  'workspace.get_settings': ['workspaceId'],
  'workspace.get_start_page': ['workspaceId'],
  'workspace.list_worktrees': ['workspaceId'],
  'workspace.list_join_options': ['sourceWorkspaceId', 'sourceWorktreeId'],
  'workspace.list_existing_worktree_join_options': [
    'sourceWorkspaceId',
    'sourceWorktreeId',
  ],
  'workspace.read_readiness': ['workspaceId'],
  'tracked-plan.list': ['projectId', 'worktreeId'],
  'tracked-plan.get': ['projectId', 'worktreeId', 'planId'],
  'tracked-plan.list_comment_threads': ['projectId', 'worktreeId', 'planId'],
  'tracked-plan.get_comment_thread': [
    'projectId',
    'worktreeId',
    'planId',
    'threadId',
  ],
};

/** One of {@link ADVISOR_WORKSPACE_ACTION_TYPES}, in main. Never throws. */
export async function dispatchAdvisorWorkspaceAction(
  action: AdvisorWorkspaceAction,
  host: AdvisorWorkspaceActionHost,
  requestId: string,
): Promise<AppAdvisorActionResponse> {
  let outcome: Outcome;
  try {
    outcome =
      missingFields(action, REQUIRED_FIELDS[action.type] ?? []) ??
      invalidIds(action) ??
      (await run(action, host));
  } catch (error) {
    outcome = failure({
      code: 'execution_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...outcome, requestId };
}

async function run(
  action: AdvisorWorkspaceAction,
  host: AdvisorWorkspaceActionHost,
): Promise<Outcome> {
  switch (action.type) {
    case 'workspace.list':
      return listWorkspaces(host);
    case 'workspace.get_settings':
      return getSettings(action, host);
    case 'workspace.get_start_page':
      return getStartPage(action, host);
    case 'workspace.list_worktrees':
      return listWorktrees(action, host);
    case 'workspace.list_join_options':
      return listJoinOptions(action, host);
    case 'workspace.list_existing_worktree_join_options':
      return listExistingWorktreeJoinOptions(action, host);
    case 'workspace.read_readiness':
      return readReadiness(action, host);
    case 'org_project.list':
      return listOrgProjects(host);
    case 'tracked-plan.list':
    case 'tracked-plan.get':
    case 'tracked-plan.list_comment_threads':
    case 'tracked-plan.get_comment_thread':
      return trackedPlanAction(action, host);
    default:
      return sidebarGroupAction(action, host);
  }
}
