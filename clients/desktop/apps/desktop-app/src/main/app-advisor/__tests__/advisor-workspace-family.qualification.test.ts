import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type {
  AppAdvisorActionResponse,
  SidebarItem,
  TrackedPlanData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorWorkspaceActionHost } from '../advisor-workspace-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorWorkspaceActionHost;
const mockHostOptions: unknown[] = [];
jest.mock('../advisor-workspace-action-host', () => ({
  mainAdvisorWorkspaceActionHost: (options: {
    chatId: string;
  }): AdvisorWorkspaceActionHost => {
    mockHostOptions.push(options);
    return mockHost;
  },
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import { trackedPlanListResult } from '@canopy/desktop-shared/lib/app-advisor-tracked-plan-results';
import {
  workspaceSettingsCapabilities,
  workspaceSummary,
  worktreeSummary,
} from '@canopy/desktop-shared/lib/app-advisor-worktree-summaries';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
  type AppAdvisorDispatchPayload,
} from '../action-router';
import { ADVISOR_WORKSPACE_ACTION_TYPES } from '../advisor-workspace-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const MOVED_READS = [
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
  'tracked-plan.list',
  'tracked-plan.get',
  'tracked-plan.list_comment_threads',
  'tracked-plan.get_comment_thread',
] as const;
const MOVED_WRITES = [
  'sidebar.item_groups.create',
  'sidebar.item_groups.update',
  'sidebar.item_groups.set_item',
  'sidebar.item_groups.move_item',
  'sidebar.item_groups.move_group',
  'sidebar.item_groups.ungroup',
] as const;

const BASE = {
  id: 'wt',
  branchName: 'main-work',
  createdAt: '2026-11-08T00:00:00.000Z',
} as unknown as WorktreeData;
const CHILD = {
  id: 'wt-child',
  branchName: 'child',
  createdAt: '2026-11-08T01:00:00.000Z',
  trackedBaseBranch: 'main-work',
} as unknown as WorktreeData;
const ITEM = {
  id: 'proj',
  type: 'single-repo',
  name: 'Project',
  repoPath: '/repo',
  color: 'blue',
  worktrees: [BASE, CHILD],
} as unknown as SidebarItem;
const COWORK = {
  id: 'cowork',
  type: 'cowork',
  name: 'Cowork',
} as unknown as SidebarItem;
const RETIRED = {
  id: 'retired',
  type: 'multi-repo',
  name: 'Old temporary',
  temporary: true,
  deletedAt: '2026-11-01T00:00:00.000Z',
  repos: [],
  worktrees: [],
} as unknown as SidebarItem;
const GROUP: SidebarItemGroup = {
  id: 'grp-1',
  name: 'Review',
  color: 'categorical-1',
  collapsed: false,
  memberIds: ['wt'],
};
const PLAN = {
  id: 'plan-1',
  projectId: 'proj',
  worktreeId: 'wt',
  source: 'agent',
  title: 'Ship it',
  reviewStatus: 'pending',
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
  latestRevisionNumber: 1,
  linkedExecutionIds: [],
  content: '# Plan',
  revisions: [],
  commentThreads: [
    {
      id: 'thread-1',
      status: 'open',
      anchorState: 'matched',
      createdAt: '2026-11-08T00:00:00.000Z',
      anchor: { quote: 'Plan' },
      comments: [
        {
          id: 'c-1',
          author: 'Nick',
          body: 'Looks good',
          createdAt: '2026-11-08T00:00:00.000Z',
        },
      ],
    },
  ],
} as unknown as TrackedPlanData;

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let items: SidebarItem[];
let contextKind: 'personal' | 'organization';
let startPageEnabled: boolean;
let describeFails: boolean;
let createFails: boolean;

function recordingHost(): AdvisorWorkspaceActionHost {
  const record =
    <T>(name: string, value: T) =>
    (...request: unknown[]): Promise<T> => {
      (calls[name] ??= []).push(request.length === 1 ? request[0] : request);
      return Promise.resolve(value);
    };
  return {
    readItems: () => Promise.resolve(items),
    announceWorktrees: (workspaceId) => {
      (calls.announceWorktrees ??= []).push(workspaceId);
    },
    readGroupChildBranchesWithBase: record('readGrouping', true),
    readSettingsData: record('readSettingsData', {
      config: { name: 'Project' },
      manifest: null,
    } as never),
    readInstructions: record('readInstructions', '# Project rules'),
    isStartPageEnabled: () => startPageEnabled,
    resolveStartPage: record('resolveStartPage', {
      source: 'local',
      startPage: { kind: 'url', url: 'https://example.com' },
    } as never),
    readReadiness: record('readReadiness', {
      issues: [
        {
          code: 'missing-claude-md',
          title: 'No CLAUDE.md',
          message: 'Add one.',
          repoName: 'repo',
        },
      ],
    } as never),
    listJoinOptions: record('listJoinOptions', {
      options: [{ workspaceId: 'other' }],
    } as never),
    listExistingWorktreeJoinOptions: record('listExistingJoinOptions', {
      groups: [
        {
          workspaceId: 'proj',
          workspaceName: 'Project',
          color: 'blue',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
          candidates: [
            {
              workspaceId: 'proj',
              worktreeId: 'wt-child',
              branchName: 'child',
              addsNewRepo: false,
              repoOverlaps: [],
            },
          ],
        },
      ],
    } as never),
    readWorkspaceContext: () =>
      Promise.resolve(
        contextKind === 'organization'
          ? {
              context: { kind: 'organization', organizationId: 'org-1' },
              revision: 1,
              organizations: [],
            }
          : { context: { kind: 'personal' }, revision: 1, organizations: [] },
      ) as never,
    listOrgProjects: record('listOrgProjects', {
      context: 'org:org-1',
      revision: 'r1',
      projects: [
        {
          id: 'op-1',
          name: 'Shared',
          kind: 'CODE',
          listed: true,
          repository: { owner: 'acme', name: 'app', verification: 'verified' },
          instance: { state: 'ready' },
        },
      ],
      fetchedAt: '2026-11-08T00:00:00.000Z',
      stale: false,
    } as never),
    listTrackedPlans: record('listTrackedPlans', [PLAN]),
    readTrackedPlan: (request) => {
      (calls.readTrackedPlan ??= []).push(request);
      return Promise.resolve(request.planId === PLAN.id ? PLAN : null);
    },
    sidebarGroups: {
      describe: (scope) => {
        (calls.describe ??= []).push(scope);
        return describeFails
          ? Promise.reject(new Error('Registry busy'))
          : Promise.resolve([{ ...GROUP, order: 0 }]);
      },
      list: record('listGroups', [GROUP]),
      listItems: record('listItems', {
        group: GROUP,
        items: [
          {
            id: 'wt',
            name: 'main-work',
            kind: 'worktree' as const,
            groupId: 'grp-1',
            createdAt: '2026-11-08T00:00:00.000Z',
          },
        ],
      }),
      create: (request) => {
        (calls.create ??= []).push(request);
        return createFails
          ? Promise.reject(new Error('Sidebar item group limit reached'))
          : Promise.resolve({ ...GROUP, id: 'grp-new' });
      },
      update: record('update', undefined),
      ungroup: record('ungroup', undefined),
      moveItem: record('moveItem', undefined),
      moveGroup: record('moveGroup', undefined),
    },
  };
}

const ACTIONS: Record<
  (typeof MOVED_READS | typeof MOVED_WRITES)[number],
  unknown
> = {
  'workspace.list': { type: 'workspace.list' },
  'workspace.get_settings': {
    type: 'workspace.get_settings',
    workspaceId: 'proj',
  },
  'workspace.get_start_page': {
    type: 'workspace.get_start_page',
    workspaceId: 'proj',
  },
  'workspace.list_worktrees': {
    type: 'workspace.list_worktrees',
    workspaceId: 'proj',
  },
  'workspace.list_join_options': {
    type: 'workspace.list_join_options',
    sourceWorkspaceId: 'proj',
    sourceWorktreeId: 'wt',
  },
  'workspace.list_existing_worktree_join_options': {
    type: 'workspace.list_existing_worktree_join_options',
    sourceWorkspaceId: 'proj',
    sourceWorktreeId: 'wt',
  },
  'workspace.read_readiness': {
    type: 'workspace.read_readiness',
    workspaceId: 'proj',
  },
  'org_project.list': { type: 'org_project.list' },
  'sidebar.item_groups.list': {
    type: 'sidebar.item_groups.list',
    scope: { workspaceLocalId: 'proj' },
  },
  'sidebar.item_groups.list_items': {
    type: 'sidebar.item_groups.list_items',
    scope: { workspaceLocalId: 'proj' },
    groupId: 'grp-1',
  },
  'tracked-plan.list': {
    type: 'tracked-plan.list',
    projectId: 'proj',
    worktreeId: 'wt',
  },
  'tracked-plan.get': {
    type: 'tracked-plan.get',
    projectId: 'proj',
    worktreeId: 'wt',
    planId: 'plan-1',
  },
  'tracked-plan.list_comment_threads': {
    type: 'tracked-plan.list_comment_threads',
    projectId: 'proj',
    worktreeId: 'wt',
    planId: 'plan-1',
  },
  'tracked-plan.get_comment_thread': {
    type: 'tracked-plan.get_comment_thread',
    projectId: 'proj',
    worktreeId: 'wt',
    planId: 'plan-1',
    threadId: 'thread-1',
  },
  'sidebar.item_groups.create': {
    type: 'sidebar.item_groups.create',
    scope: { workspaceLocalId: 'proj' },
    itemId: 'wt',
    name: 'Review',
  },
  'sidebar.item_groups.update': {
    type: 'sidebar.item_groups.update',
    scope: { workspaceLocalId: 'proj' },
    groupId: 'grp-1',
    collapsed: true,
  },
  'sidebar.item_groups.set_item': {
    type: 'sidebar.item_groups.set_item',
    scope: { workspaceLocalId: 'proj' },
    itemId: 'wt',
    groupId: 'grp-1',
  },
  'sidebar.item_groups.move_item': {
    type: 'sidebar.item_groups.move_item',
    scope: { workspaceLocalId: 'proj' },
    itemId: 'wt',
    groupId: null,
  },
  'sidebar.item_groups.move_group': {
    type: 'sidebar.item_groups.move_group',
    scope: { workspaceLocalId: 'proj' },
    groupId: 'grp-1',
    after: 'wt-child',
  },
  'sidebar.item_groups.ungroup': {
    type: 'sidebar.item_groups.ungroup',
    scope: { workspaceLocalId: 'proj' },
    groupId: 'grp-1',
  },
};

function action(input: unknown): AppAdvisorDispatchPayload {
  return dispatchActionSchema.parse({ action: input }).action;
}

function setup(): {
  surfaces: Record<string, jest.Mock>;
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const surfaces = {
    getMainWindow: jest.fn(() => null),
    getAppAdvisorWindow: jest.fn(() => null),
    openAppAdvisorWindow: jest.fn(),
    ensureAppAdvisorWindow: jest.fn(),
  };
  const runtime = createAppAdvisorToolRuntime(surfaces, {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId: 'advisor-chat',
  });
  return {
    surfaces,
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        action(input),
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

/** As the tool text carries it: undefined fields drop out. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-5998-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  items = [ITEM, COWORK, RETIRED];
  contextKind = 'organization';
  startPageEnabled = true;
  describeFails = false;
  createFails = false;
  mockHost = recordingHost();
  mockHostOptions.length = 0;
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor workspace family in main (CAN-5998)', () => {
  it('the moved rows are core worktree-actions; the writes keep core.workspace.write', () => {
    expect([...ADVISOR_WORKSPACE_ACTION_TYPES].sort()).toEqual(
      [...MOVED_READS, ...MOVED_WRITES].sort(),
    );
    for (const type of MOVED_READS)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'read',
        executor: 'worktree-actions',
      });
    for (const type of MOVED_WRITES)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.workspace.write'],
        revision: 'none',
      });
    expect(
      appAdvisorActionDisposition('environment.update_workspace_assignment'),
    ).toMatchObject({ kind: 'legacy' });
  });

  it('each moved action runs in main with no window and never reaches a renderer', async () => {
    const h = setup();
    let call = 0;
    for (const [type, input] of Object.entries(ACTIONS)) {
      call += 1;
      const result = await h.route(input, { toolUseId: `toolu_${call}` });
      expect({ type, ok: result.ok }).toEqual({ type, ok: true });
    }
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
    expect(h.surfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(h.surfaces.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(mockHostOptions).toContainEqual({ chatId: 'advisor-chat' });
  });

  it('workspace.list lists what the sidebar shows, leaving out retired temporary projects', async () => {
    const result = await setup().route(ACTIONS['workspace.list']);

    expect(result).toMatchObject({
      ok: true,
      result: {
        totalWorkspaces: 2,
        excludedSoftDeletedTemporaryWorkspaces: 1,
        workspaces: wire([workspaceSummary(ITEM), workspaceSummary(COWORK)]),
      },
    });
  });

  it('list_worktrees labels each worktree with its group, a branch stack following its root', async () => {
    const result = await setup().route(ACTIONS['workspace.list_worktrees']);

    expect(result).toMatchObject({
      ok: true,
      result: {
        totalWorktrees: 2,
        worktrees: wire([
          worktreeSummary(BASE, 'grp-1'),
          worktreeSummary(CHILD, 'grp-1'),
        ]),
      },
    });
    expect(calls.listGroups).toEqual([{ workspaceLocalId: 'proj' }]);
  });

  it('get_settings reads CLAUDE.md only for a project the sidebar lists, with the window path fields', async () => {
    const h = setup();
    const unknown = await h.route({
      type: 'workspace.get_settings',
      workspaceId: 'someone-elses',
      includeClaudeMd: true,
    });
    const retired = await h.route({
      type: 'workspace.get_settings',
      workspaceId: 'retired',
      includeClaudeMd: true,
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Project someone-elses was not found.',
      },
    });
    expect(retired).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls.readInstructions).toBeUndefined();
    expect(calls.readSettingsData).toBeUndefined();

    const listed = await h.route({
      type: 'workspace.get_settings',
      workspaceId: 'proj',
      worktreeId: 'wt',
      includeClaudeMd: true,
    });
    expect(listed).toEqual({
      requestId: 'toolu_1',
      ok: true,
      result: {
        workspace: wire(workspaceSummary(ITEM)),
        capabilities: workspaceSettingsCapabilities(ITEM),
        settingsData: { config: { name: 'Project' }, manifest: null },
        claudeMd: '# Project rules',
      },
    });
    expect(calls.readInstructions).toEqual(['proj']);
    expect(calls.readSettingsData).toEqual([['proj', 'wt']]);

    const withoutClaudeMd = await h.route(ACTIONS['workspace.get_settings']);
    expect(withoutClaudeMd.result).not.toHaveProperty('claudeMd');
    expect(calls.readInstructions).toEqual(['proj']);
  });

  it('an empty required id is refused as the renderer refused it', async () => {
    const result = await setup().route({
      type: 'tracked-plan.get',
      projectId: 'proj',
      worktreeId: 'wt',
      planId: '',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Action tracked-plan.get requires planId.',
      },
    });
    expect(calls.readTrackedPlan).toBeUndefined();
  });

  it('get_start_page is unavailable while the start page flag is off', async () => {
    startPageEnabled = false;
    const result = await setup().route(ACTIONS['workspace.get_start_page']);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Project start pages are not available.',
      },
    });
    expect(calls.resolveStartPage).toBeUndefined();
  });

  it('org_project.list reads the selected organization from main, and needs one', async () => {
    const h = setup();
    const listed = await h.route(ACTIONS['org_project.list']);
    expect(listed).toMatchObject({
      ok: true,
      result: {
        organizationId: 'org-1',
        totalProjects: 1,
        projects: [
          {
            projectId: 'op-1',
            repository: 'acme/app',
            verification: 'verified',
            instanceState: 'ready',
          },
        ],
      },
    });
    expect(calls.listOrgProjects).toEqual([
      { kind: 'organization', organizationId: 'org-1' },
    ]);

    contextKind = 'personal';
    const personal = await h.route(ACTIONS['org_project.list']);
    expect(personal).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(calls.listOrgProjects).toHaveLength(1);
  });

  it('join options and readiness refuse a Cowork project before reading', async () => {
    const h = setup();
    const readiness = await h.route({
      type: 'workspace.read_readiness',
      workspaceId: 'cowork',
    });
    const join = await h.route({
      type: 'workspace.list_join_options',
      sourceWorkspaceId: 'proj',
      sourceWorktreeId: 'missing',
    });

    expect(readiness).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(join).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Worktree missing was not found in project proj.',
      },
    });
    expect(calls.readReadiness).toBeUndefined();
    expect(calls.listJoinOptions).toBeUndefined();
  });

  it('existing-worktree join groups carry each candidate group', async () => {
    const result = await setup().route(
      ACTIONS['workspace.list_existing_worktree_join_options'],
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        allowedModes: ['temporary'],
        totalGroups: 1,
        totalCandidates: 1,
        groups: [
          {
            workspaceId: 'proj',
            candidates: [{ worktreeId: 'wt-child', groupId: 'grp-1' }],
          },
        ],
      },
    });
  });

  it('sidebar writes take the scope the action names and refuse an unknown project before writing', async () => {
    const h = setup();
    const created = await h.route({
      type: 'sidebar.item_groups.set_item',
      scope: { workspaceLocalId: 'proj' },
      itemId: 'wt',
      newGroup: { name: 'Review' },
    });
    expect(created).toMatchObject({
      ok: true,
      result: { itemId: 'wt', groupId: 'grp-new', groups: [{ id: 'grp-1' }] },
    });
    expect(calls.create).toEqual([
      { scope: { workspaceLocalId: 'proj' }, itemId: 'wt', name: 'Review' },
    ]);

    const advisorScope = await h.route(
      {
        type: 'sidebar.item_groups.ungroup',
        scope: { appAdvisor: true },
        groupId: 'grp-1',
      },
      { toolUseId: 'toolu_2' },
    );
    expect(advisorScope.ok).toBe(true);
    expect(calls.ungroup).toEqual([
      { scope: { appAdvisor: true }, groupId: 'grp-1' },
    ]);

    const unknown = await h.route(
      {
        type: 'sidebar.item_groups.update',
        scope: { workspaceLocalId: 'gone' },
        groupId: 'grp-1',
        name: 'X',
      },
      { toolUseId: 'toolu_3' },
    );
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Project gone was not found.' },
    });
    expect(calls.update).toBeUndefined();
  });

  it('traversal ids are refused before any owner reads, as the window refused them', async () => {
    const h = setup();
    const cases = [
      { type: 'workspace.get_start_page', workspaceId: '../../etc' },
      {
        type: 'workspace.get_start_page',
        workspaceId: 'proj',
        worktreeId: '../../other/worktrees/wt',
      },
      { type: 'workspace.read_readiness', workspaceId: '..' },
      {
        type: 'workspace.read_readiness',
        workspaceId: 'proj',
        worktreeId: '../../other/worktrees/wt',
      },
      {
        type: 'workspace.get_settings',
        workspaceId: 'proj',
        worktreeId: '../wt',
      },
    ];
    for (const input of cases) {
      const result = await h.route(input);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
    }
    expect(calls.resolveStartPage).toBeUndefined();
    expect(calls.readReadiness).toBeUndefined();
    expect(calls.readSettingsData).toBeUndefined();
  });

  it('get_start_page reads only a project the sidebar lists', async () => {
    const result = await setup().route({
      type: 'workspace.get_start_page',
      workspaceId: 'unlisted',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Project unlisted was not found.' },
    });
    expect(calls.resolveStartPage).toBeUndefined();
  });

  it("a code project group write reloads the windows' worktree rows; App Advisor scope and failed writes do not", async () => {
    const h = setup();
    await h.route(ACTIONS['sidebar.item_groups.move_item'], {
      toolUseId: 'toolu_20',
    });
    expect(calls.announceWorktrees).toEqual(['proj']);

    await h.route(
      {
        type: 'sidebar.item_groups.ungroup',
        scope: { appAdvisor: true },
        groupId: 'grp-1',
      },
      { toolUseId: 'toolu_21' },
    );
    await h.route(ACTIONS['sidebar.item_groups.list'], {
      toolUseId: 'toolu_22',
    });
    createFails = true;
    const failed = await h.route(ACTIONS['sidebar.item_groups.create'], {
      toolUseId: 'toolu_23',
    });
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Sidebar item group limit reached',
      },
    });
    expect(calls.announceWorktrees).toEqual(['proj']);
  });

  it('a sidebar write runs once per tool call', async () => {
    const h = setup();
    const create = ACTIONS['sidebar.item_groups.create'];
    const first = await h.route(create, { toolUseId: 'toolu_9' });
    const second = await h.route(create, { toolUseId: 'toolu_9' });

    expect(second).toEqual(first);
    expect(calls.create).toHaveLength(1);
  });

  it('a landed sidebar write whose group list cannot be read back reports refreshFailed', async () => {
    describeFails = true;
    const result = await setup().route(ACTIONS['sidebar.item_groups.update']);

    expect(result).toEqual({
      requestId: 'toolu_1',
      ok: true,
      result: {
        applied: 'sidebar.item_groups.update',
        groupId: 'grp-1',
        refreshFailed: true,
      },
    });
    expect(calls.update).toHaveLength(1);
  });

  it('sidebar list_items answers with the group and its members', async () => {
    const result = await setup().route(
      ACTIONS['sidebar.item_groups.list_items'],
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        group: {
          id: 'grp-1',
          name: 'Review',
          color: 'categorical-1',
          collapsed: false,
          memberIds: ['wt'],
        },
        items: [{ id: 'wt', kind: 'worktree', groupId: 'grp-1' }],
        returned: 1,
      },
    });
  });

  it('tracked-plan reads answer with the shared results, and a missing plan is not_found', async () => {
    const h = setup();
    const listed = await h.route(ACTIONS['tracked-plan.list']);
    expect(listed).toEqual({
      requestId: 'toolu_1',
      ...wire(
        trackedPlanListResult(
          { type: 'tracked-plan.list', projectId: 'proj', worktreeId: 'wt' },
          [PLAN],
        ),
      ),
    });

    const thread = await h.route(ACTIONS['tracked-plan.get_comment_thread']);
    expect(thread).toMatchObject({
      ok: true,
      result: {
        planTitle: 'Ship it',
        thread: { id: 'thread-1', comments: [{ body: 'Looks good' }] },
      },
    });

    const missing = await h.route({
      type: 'tracked-plan.get',
      projectId: 'proj',
      worktreeId: 'wt',
      planId: 'plan-gone',
    });
    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Tracked plan plan-gone was not found.',
      },
    });
  });
});
