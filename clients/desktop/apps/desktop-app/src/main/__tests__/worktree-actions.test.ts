import {
  browserActionCatalog,
  browserActionSchema,
  createDispatchActionInputSchema,
  findBrowserUiOnlyField,
  searchAgentActionCatalog,
} from '@canopy/agent-actions';
import type { BrowserActionReceipt } from '@canopy/desktop-shared/types';
import { BrowserReadTargetError } from '@canopy/desktop-shared/browser/read-target-error';
import { browserHandoffs } from '../browser/browser-handoffs';
import * as resourceLanes from '../pipelines/resource-lanes';
import * as installContext from '../pipelines/pipeline-install-context';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import * as path from 'node:path';
import {
  dispatchActionSchema,
  dispatchActionJsonSchema,
} from '../canopy-tools/definitions';
import {
  dispatchScopedBrowserAction,
  dispatchWorktreeAction,
  searchWorktreeActions,
  type DispatchWorktreeActionInput,
  type WorktreeActionRuntime,
} from '../canopy-tools/worktree-actions';
import * as pipelineStore from '../pipelines/pipeline-service';
import * as curatedCatalog from '../pipelines/curated-pipeline-catalog';
import {
  getSharedPipeline,
  listSharedPipelines,
} from '../pipelines/canopy-server-client';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import { loadExecutionState } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import {
  cancelMatrixVariantFromMain,
  cancelPipelineExecutionFromMain,
  retryMatrixJobFromMain,
  retryPipelineExecutionFromMain,
  startPipelineExecutionFromMain,
} from '../pipelines/pipeline-handlers';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import { BrowserService } from '../browser/browser-service';
import { getBrowserService } from '../browser/browser-service-registry';
import {
  noteChatDriver,
  resetChatDriversForTests,
} from '../remote-control/host/chat-drivers';
import { importTrackedPlanFromPath } from '../lib/plan-import';
import {
  changeWorktreeHookPause,
  getWorktreePausedHookKeys,
  listHooks,
} from '../services/hooks-service';
import {
  readWorkspaceWorktrees,
  updateWorkspaceWorktree,
} from '../lib/workspace-persistence';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import type { SendableBrowserWindow } from '../lib/window-send';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type BrowserSessionSnapshot,
  type PortalHookSummary,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  PipelineData,
  SharedPipelineDetail,
} from '@canopy/desktop-shared/types/pipeline';
import type * as planImportModule from '../lib/plan-import';
import type * as preferencesStoreModule from '../lib/preferences-store';
import { withPipelineCrudTelemetry } from '../pipelines/instrumentation';
import { BrowserWindow } from 'electron';
import { pinOrgProjectsFlagOff } from './helpers/org-projects-flag';

// Browser actions belong to the shared browser family, which the desktop
// surface binds beside the legacy actions.
const browserDispatchSchema = createDispatchActionInputSchema(
  browserActionSchema,
  { findUiOnlyField: findBrowserUiOnlyField },
);
function searchBrowserActions(input: { actionType: string }): {
  actions: ReadonlyArray<{ type: string }>;
} {
  return searchAgentActionCatalog(browserActionCatalog(), input);
}

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
});

jest.mock('../pipelines/curated-pipeline-catalog', () => ({
  listManagedCuratedPipelines: jest.fn(() => Promise.resolve([])),
  getManagedCuratedPipeline: jest.fn(),
}));

jest.mock('../pipelines/pipeline-service', () => ({
  getPipeline: jest.fn(),
  listPipelines: jest.fn(),
}));

jest.mock('../pipelines/canopy-server-client', () => ({
  listSharedPipelines: jest.fn(),
  getSharedPipeline: jest.fn(),
  createSharedPipeline: jest.fn(),
  updateSharedPipeline: jest.fn(),
  deleteSharedPipeline: jest.fn(),
}));

jest.mock('../canopy-cloud/client', () => {
  class MockCanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return {
    assertCanopyCloudCapability: jest.fn(() => Promise.resolve()),
    CanopyCloudClientError: MockCanopyCloudClientError,
  };
});

jest.mock('../pipelines/project-pipeline-discovery', () => ({
  discoverProjectPipelines: jest.fn().mockResolvedValue([]),
  loadProjectPipelineFromDisk: jest.fn(),
}));

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn(),
    loadExecutionState: jest.fn(),
  }),
);

jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));

jest.mock('../pipelines/pipeline-handlers', () => ({
  cancelMatrixVariantFromMain: jest.fn(),
  cancelPipelineExecutionFromMain: jest.fn(),
  retryMatrixJobFromMain: jest.fn(),
  retryPipelineExecutionFromMain: jest.fn(),
  startPipelineExecutionFromMain: jest.fn(),
}));

jest.mock('../pipelines/pipeline-resume-service', () => ({
  resumePipelineExecutionFromMain: jest.fn(),
}));

jest.mock('../pipelines/instrumentation', () => ({
  withPipelineCrudTelemetry: jest.fn(
    (_context: unknown, operation: () => unknown) => operation(),
  ),
}));

jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(),
}));

jest.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    isDestroyed = jest.fn(() => false);
    isFocused = jest.fn(() => true);
    webContents = {
      focus: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isFocused: jest.fn(() => false),
    };
  },
  ipcMain: {
    on: jest.fn(),
    removeListener: jest.fn(),
  },
}));

jest.mock('../lib/plan-import', () => {
  const actual =
    jest.requireActual<typeof planImportModule>('../lib/plan-import');
  return {
    importedPlanResult: actual.importedPlanResult,
    importTrackedPlanFromPath: jest.fn(),
  };
});

jest.mock('../services/hooks-service', () => ({
  changeWorktreeHookPause: jest.fn(),
  getWorktreePausedHookKeys: jest.fn(),
  listHooks: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(),
  updateWorkspaceWorktree: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof preferencesStoreModule>(
    '../lib/preferences-store',
  );
  return { ...actual, readPreferencesFile: jest.fn() };
});

const getPipelineMock = jest.mocked(pipelineStore.getPipeline);
const getSharedPipelineMock = jest.mocked(getSharedPipeline);
const listSharedPipelinesMock = jest.mocked(listSharedPipelines);
const assertCanopyCloudCapabilityMock = jest.mocked(
  assertCanopyCloudCapability,
);
const loadExecutionStateMock = jest.mocked(loadExecutionState);
const createElectronExecutionRuntimeMock = jest.mocked(
  createElectronExecutionRuntime,
);
const startPipelineExecutionFromMainMock = jest.mocked(
  startPipelineExecutionFromMain,
);
const cancelPipelineExecutionFromMainMock = jest.mocked(
  cancelPipelineExecutionFromMain,
);
const cancelMatrixVariantFromMainMock = jest.mocked(
  cancelMatrixVariantFromMain,
);
const retryMatrixJobFromMainMock = jest.mocked(retryMatrixJobFromMain);
const retryPipelineExecutionFromMainMock = jest.mocked(
  retryPipelineExecutionFromMain,
);
const resumePipelineExecutionFromMainMock = jest.mocked(
  resumePipelineExecutionFromMain,
);
const getBrowserServiceMock = jest.mocked(getBrowserService);
const importTrackedPlanFromPathMock = jest.mocked(importTrackedPlanFromPath);
const getWorktreePausedHookKeysMock = jest.mocked(getWorktreePausedHookKeys);
const listHooksMock = jest.mocked(listHooks);
const changeWorktreeHookPauseMock = jest.mocked(changeWorktreeHookPause);
const readWorkspaceWorktreesMock = jest.mocked(readWorkspaceWorktrees);
const updateWorkspaceWorktreeMock = jest.mocked(updateWorkspaceWorktree);
const readPreferencesFileMock = jest.mocked(readPreferencesFile);

function pipelineData(): PipelineData {
  return {
    info: {
      id: 'pipe-1',
      name: 'Test pipeline',
      description: '',
      filename: 'test.yml',
      source: 'user',
      readonly: false,
    },
    content: {
      name: 'Test pipeline',
      on: {
        dispatch: {},
        plan_ready: {},
        task_ready: {},
      },
      jobs: {},
    },
  };
}

function sharedPipelineData(): SharedPipelineDetail {
  return {
    id: 'shared-pipeline',
    name: 'Shared pipeline',
    description: 'Shared pipeline description',
    icon: 'build',
    version: '1',
    triggerTypes: ['dispatch', 'plan_ready'],
    scopes: ['directory'],
    createdBy: { id: 'me', name: 'Me' },
    shareScope: 'private',
    owner: { type: 'user', id: 'me', name: 'Me' },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    rawPipeline:
      'name: Shared pipeline\ndescription: Shared pipeline description\nscope: directory\non:\n  dispatch: {}\n  plan_ready: {}\njobs: {}\n',
  };
}

function executionState(
  overrides: Partial<ExecutionState> = {},
): ExecutionState {
  return {
    id: 'exec-1',
    pipeline_id: 'pipe-1',
    pipeline_snapshot: {
      name: 'Test pipeline',
      description: '',
      jobs: {},
    },
    status: 'completed',
    started_at: '2026-05-26T00:00:00.000Z',
    completed_at: '2026-05-26T00:01:00.000Z',
    cwd: '/tmp/worktree',
    project_id: 'project-1',
    worktree_id: 'worktree-1',
    event_name: 'plan_ready',
    event_data: {},
    inputs: {},
    jobs: {},
    ...overrides,
  } as ExecutionState;
}

function browserSnapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: 'browser-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000',
    title: 'Local',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

function hookSummary(
  overrides: Partial<PortalHookSummary> = {},
): PortalHookSummary {
  return {
    workspaceLocalId: 'project-1',
    worktreeLocalId: 'worktree-1',
    hookId: 'project:pr:create',
    hookKey: 'project:pr:create',
    name: 'Pull request created',
    triggerName: 'pr:create',
    target: 'project',
    paused: false,
    ...overrides,
  };
}

/** A newly created session's id: a fresh UUID, never a caller-supplied one. */
const FRESH_BROWSER_ID: unknown = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);

describe('worktree actions', () => {
  it.each(['worktree', 'directory'] as const)(
    'discovers sidebar group actions with trusted %s context',
    (executionScope) => {
      for (const actionType of [
        'sidebar.item_groups.list',
        'sidebar.item_groups.set_item',
        'sidebar.item_groups.update',
        'sidebar.item_groups.list_items',
      ]) {
        const result = searchWorktreeActions(
          { actionType },
          { executionScope },
        );
        expect(result.actions.map((entry) => entry.type)).toContain(actionType);
        expect(
          result.actions[0]?.fields.map((field) => field.name),
        ).not.toEqual(expect.arrayContaining(['scope']));
        expect(
          result.actions[0]?.fields.map((field) => field.name),
        ).not.toContain('itemId');
      }
    },
  );

  it('accepts current-item assignment and inline creation but rejects caller-selected scope', () => {
    for (const action of [
      { type: 'sidebar.item_groups.list' },
      { type: 'sidebar.item_groups.list_items', groupId: 'grp-one' },
      { type: 'sidebar.item_groups.set_item', groupId: 'grp-one' },
      { type: 'sidebar.item_groups.set_item', groupId: null },
      {
        type: 'sidebar.item_groups.set_item',
        newGroup: { name: 'Tasks', color: 'categorical-2' },
      },
      {
        type: 'sidebar.item_groups.update',
        groupId: 'grp-one',
        name: 'Renamed',
      },
    ])
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
    for (const extra of [
      { scope: { workspaceLocalId: 'other-project' } },
      { itemId: 'other-entry' },
      { newGroup: { name: 'Conflicting' } },
    ])
      expect(
        dispatchActionSchema.safeParse({
          action: {
            type: 'sidebar.item_groups.set_item',
            groupId: 'grp-one',
            ...extra,
          },
        }).success,
      ).toBe(false);
  });

  it('advertises browser focus and wait actions through DispatchAction search', () => {
    for (const actionType of ['browser.focus', 'browser.wait_for']) {
      const result = searchBrowserActions({ actionType });
      expect(result.actions.map((entry) => entry.type)).toContain(actionType);
    }
  });

  const executionScopes: Array<'worktree' | 'directory'> = [
    'worktree',
    'directory',
  ];

  describe.each(executionScopes)(
    '%s automation discovery',
    (executionScope) => {
      it.each([
        'schedule',
        'scheduled task',
        'recurring',
        'reminder',
        'remind me tomorrow',
      ])(
        'includes automation creation in the default result window for %s',
        (query): void => {
          const result = searchWorktreeActions({ query }, { executionScope });
          expect(result.actions.map((entry) => entry.type)).toContain(
            'automation.create',
          );
          expect(result.actions.map((entry) => entry.type)).not.toContain(
            'worktree-chat.schedule_message',
          );
        },
      );

      it('keeps exact automation creation lookup available', (): void => {
        const result = searchWorktreeActions(
          { actionType: 'automation.create' },
          { executionScope },
        );
        expect(result.actions.map((entry) => entry.type)).toEqual([
          'automation.create',
        ]);
        expect(
          searchWorktreeActions(
            { actionType: 'worktree-chat.schedule_message' },
            { executionScope },
          ).actions,
        ).toEqual([]);
      });
    },
  );

  const runtime: WorktreeActionRuntime = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    cwd: '/tmp/worktree',
    getWindow: () => null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(curatedCatalog.listManagedCuratedPipelines)
      .mockResolvedValue([]);
    assertCanopyCloudCapabilityMock.mockResolvedValue();
    jest
      .mocked(pipelineStore.listPipelines)
      .mockReturnValue({ success: true, data: [] });
    listSharedPipelinesMock.mockResolvedValue({
      data: [],
      nextCursor: null,
    });
    readPreferencesFileMock.mockResolvedValue(DEFAULT_PREFERENCES);
    getPipelineMock.mockReturnValue({ success: true, data: pipelineData() });
    getBrowserServiceMock.mockReturnValue(null);
    createElectronExecutionRuntimeMock.mockReturnValue({
      executionsDir: '/tmp/canopy-executions',
    } as ReturnType<typeof createElectronExecutionRuntime>);
    cancelPipelineExecutionFromMainMock.mockResolvedValue(
      executionState({ status: 'cancelled' }),
    );
    retryPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: executionState({ status: 'running', completed_at: undefined }),
    });
    resumePipelineExecutionFromMainMock.mockResolvedValue({
      status: 'started',
      state: executionState({ status: 'running', completed_at: undefined }),
    });
    importTrackedPlanFromPathMock.mockResolvedValue({
      plan: {
        id: 'plan-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        source: 'imported',
        title: 'Imported plan',
        content: '# Imported plan\n',
        reviewStatus: 'pending',
        createdAt: '2026-06-16T00:00:00.000Z',
        updatedAt: '2026-06-16T00:00:00.000Z',
        latestRevisionNumber: 1,
        revisions: [],
        linkedExecutionIds: [],
        sourceFilePath: 'plan.md',
      },
      trackedPlanFilePath: '/canopy/worktrees/worktree-1/tracked-plans.json',
    });
    listHooksMock.mockResolvedValue([]);
    getWorktreePausedHookKeysMock.mockResolvedValue([]);
    readWorkspaceWorktreesMock.mockResolvedValue([
      {
        id: 'worktree-1',
        branchName: 'feature/base-details',
        createdAt: '2026-09-02T00:00:00.000Z',
        trackedBaseBranch: 'main',
        trackedRepoBaseBranches: {
          __workspace_root__: 'main',
          'repo-a': 'release/next',
        },
      },
    ]);
    changeWorktreeHookPauseMock.mockRejectedValue(
      new Error('Unexpected hook pause persistence call'),
    );
    updateWorkspaceWorktreeMock.mockResolvedValue(false);
  });

  it('discovers tracked-plan import as a scoped worktree action', () => {
    const result = searchWorktreeActions({
      query: 'import plan file path',
      category: 'tracked-plan',
    });

    expect(result.categories).toEqual([
      'sidebar',
      'skills',
      'sharing',
      'pipeline',
      'worktree',
      'tracked-plan',
      'hook',
      'browser',
      'automations',
    ]);
    expect(result.actions.map((action) => action.type)).toContain(
      'tracked-plan.import',
    );
    const importAction = result.actions.find(
      (action) => action.type === 'tracked-plan.import',
    );
    expect(importAction?.requiredFields).toEqual(['filePath', 'repoId']);
    expect(importAction?.fields.map((field) => field.name)).not.toContain(
      'projectId',
    );
  });

  it('preserves browser profile authority fields through scoped tool validation', () => {
    const selection = { kind: 'named', profileId: 'work-profile' };
    const actions = [
      { type: 'browser.open', selection },
      { type: 'browser.profile.list', offset: 50 },
      { type: 'browser.profile.get', profileId: 'work-profile' },
      {
        type: 'browser.profile.switch',
        operationId: 'switch-op',
        browserId: 'browser-1',
        expectedRuntimeGeneration: 3,
        selection,
        mode: 'replace',
      },
      {
        type: 'browser.profile.preview_clear',
        profileId: 'work-profile',
        storageGeneration: 2,
        metadataRevision: 3,
        operation: { kind: 'cache' },
      },
      {
        type: 'browser.profile.clear',
        operationId: 'clear-op',
        token: 'preview-token',
      },
      { type: 'browser.profile.job_get', jobId: 'job-1' },
      { type: 'browser.profile.job_cancel', jobId: 'job-1' },
      {
        type: 'browser.fill',
        browserId: 'browser-1',
        expectedRuntimeGeneration: 3,
        locator: 'input',
        text: 'account-bound input',
      },
      {
        type: 'browser.handle_dialog',
        browserId: 'browser-1',
        expectedRuntimeGeneration: 3,
        dialogId: 'dialog-1',
        accept: false,
      },
    ];
    const advertised = JSON.stringify(dispatchActionJsonSchema);
    for (const action of actions) {
      expect(browserDispatchSchema.parse({ action })).toEqual({ action });
      expect(advertised).toContain(`"${action.type}"`);
    }
    expect(advertised).toContain('expectedRuntimeGeneration');
    expect(advertised).toContain('selection');
    for (const action of [
      { type: 'browser.open', selection: { kind: 'named' } },
      {
        type: 'browser.open',
        selection: { kind: 'named', profileId: 'work', allowEnable: true },
      },
      { type: 'browser.open', selection, focused: true },
      { type: 'browser.open', expectedRuntimeGeneration: 0 },
      { type: 'pipeline.list', selection },
    ])
      expect(browserDispatchSchema.safeParse({ action }).success).toBe(false);
  });

  it('exposes headless resource contracts and removes only trusted server scope', () => {
    for (const category of ['skills', 'pipeline', 'automations']) {
      const result = searchWorktreeActions({ category, limit: 50 });
      expect(result.actions.length).toBeGreaterThan(0);
      for (const action of result.actions) {
        expect(action.fields.map((field) => field.name)).not.toEqual(
          expect.arrayContaining([
            'route',
            'page',
            'panel',
            'focus',
            'selection',
            'currentUiState',
          ]),
        );
      }
    }

    const parsed = dispatchActionSchema.safeParse({
      action: {
        type: 'automation.create',
        projectId: 'untrusted-project',
        worktreeId: 'untrusted-worktree',
        input: {
          name: 'Daily review',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'legitimate-target',
            pipelineId: 'pipeline-1',
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('schema fixture');
    expect(parsed.data.action).not.toHaveProperty('projectId');
    expect(parsed.data.action).not.toHaveProperty('worktreeId');
    expect(parsed.data.action).toMatchObject({
      input: {
        action: {
          workspaceId: 'legitimate-target',
          pipelineId: 'pipeline-1',
        },
      },
    });

    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'skills.read',
          sourceId: 'custom:app',
          skillName: 'review',
          route: '/plugins',
        },
      }).success,
    ).toBe(false);

    const pipelineInputs = dispatchActionSchema.safeParse({
      action: {
        type: 'pipeline.run',
        pipelineId: 'pipeline-1',
        inputs: { page: 'overview', tab: 'activity' },
      },
    });
    expect(pipelineInputs.success).toBe(true);
    if (!pipelineInputs.success) throw new Error('pipeline inputs fixture');
    expect(pipelineInputs.data.action).toMatchObject({
      inputs: { page: 'overview', tab: 'activity' },
    });

    const nestedPipelineInputs = dispatchActionSchema.safeParse({
      action: {
        type: 'automation.create',
        input: {
          name: 'Pipeline activity',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'pipeline-1',
            inputs: { route: 'release', panel: 'build' },
          },
        },
      },
    });
    expect(nestedPipelineInputs.success).toBe(true);

    // Pipeline automations cannot run Ultra fast: agent writes are refused at
    // the schema, on update exactly as on create; Fast stays writable.
    const ultraPipelineAction = {
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'pipeline-1',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    };
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'automation.create',
          input: {
            name: 'Ultra fast pipeline',
            schedule: {
              kind: 'cron',
              expression: '0 9 * * *',
              timezone: 'local',
            },
            action: ultraPipelineAction,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'automation.update',
          id: 'activity-1',
          patch: { action: ultraPipelineAction },
        },
      }).success,
    ).toBe(false);
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'automation.update',
          id: 'activity-1',
          patch: {
            action: {
              ...ultraPipelineAction,
              modelConfig: { speed: 'fast', fastMode: true },
            },
          },
        },
      }).success,
    ).toBe(true);

    const rejectedUiField = dispatchActionSchema.safeParse({
      action: {
        type: 'skills.read',
        sourceId: 'custom:app',
        skillName: 'review',
        route: '/plugins',
      },
    });
    expect(rejectedUiField.success).toBe(false);
    if (rejectedUiField.success) throw new Error('UI field fixture');
    expect(rejectedUiField.error.issues[0]?.message).toContain(
      'UI-only field "route"',
    );
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'automation.create',
          input: {
            name: 'Invalid navigation payload',
            schedule: {
              kind: 'cron',
              expression: '0 9 * * *',
              timezone: 'local',
            },
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'workspace-1',
              pipelineId: 'pipeline-1',
              route: '/pipelines',
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      dispatchActionSchema.safeParse({
        action: { type: 'skills.open_shared_viewer', skillId: 'skill-1' },
      }).success,
    ).toBe(false);
    expect(
      dispatchActionSchema.safeParse({
        action: { type: 'automation.open_editor', id: 'activity-1' },
      }).success,
    ).toBe(false);
  });

  it('omits project definitions from agent lists when ownership is unavailable', async (): Promise<void> => {
    const enabled = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(true);
    const stored = jest
      .spyOn(installContext, 'filterStoredPipelineContexts')
      .mockResolvedValue([]);
    jest.mocked(discoverProjectPipelines).mockResolvedValue([
      {
        ...pipelineData().info,
        id: 'project--secret.yaml',
        source: 'project',
        filePath: '/missing/secret.yaml',
      },
    ]);
    jest
      .mocked(loadProjectPipelineFromDisk)
      .mockResolvedValue(pipelineData().content);
    try {
      const result = await dispatchWorktreeAction(
        { action: { type: 'pipeline.list' } },
        runtime,
      );
      expect(result).toMatchObject({ ok: true, result: { pipelines: [] } });
    } finally {
      enabled.mockRestore();
      stored.mockRestore();
      jest.mocked(discoverProjectPipelines).mockResolvedValue([]);
    }
  });

  it('lists managed curated metadata without hydration and honors hidden preferences', async () => {
    const info = {
      ...pipelineData().info,
      id: 'curated:reviewed',
      source: 'curated' as const,
      readonly: true,
      triggerTypes: ['dispatch' as const],
    };
    jest
      .mocked(curatedCatalog.listManagedCuratedPipelines)
      .mockResolvedValue([info]);
    const visible = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list' } },
      runtime,
    );
    expect(visible).toMatchObject({
      ok: true,
      result: {
        pipelines: [
          expect.objectContaining({
            id: info.id,
            source: 'curated',
            runModes: [{ mode: 'dispatch', inputCount: null }],
          }),
        ],
      },
    });
    expect(curatedCatalog.getManagedCuratedPipeline).not.toHaveBeenCalled();
    readPreferencesFileMock.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      disabledPipelineIds: [info.id],
    });
    expect(
      await dispatchWorktreeAction(
        { action: { type: 'pipeline.list' } },
        runtime,
      ),
    ).toMatchObject({ ok: true, result: { pipelines: [] } });
    expect(
      await dispatchWorktreeAction(
        { action: { type: 'pipeline.list', includeDisabled: true } },
        runtime,
      ),
    ).toMatchObject({
      ok: true,
      result: {
        pipelines: [expect.objectContaining({ id: info.id, enabled: false })],
      },
    });
  });

  it('gets and runs the selected managed curated definition with its reviewed hash', async () => {
    const data = pipelineData();
    data.info = {
      ...data.info,
      id: 'curated:reviewed',
      source: 'curated',
      readonly: true,
      curatedContentHash: 'a'.repeat(64),
    };
    getPipelineMock.mockReturnValue({ success: false, error: 'Not local' });
    jest
      .mocked(curatedCatalog.getManagedCuratedPipeline)
      .mockResolvedValue(data);
    expect(
      await dispatchWorktreeAction(
        { action: { type: 'pipeline.get', pipelineId: data.info.id } },
        runtime,
      ),
    ).toMatchObject({ ok: true });
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: executionState({ pipeline_id: data.info.id, status: 'running' }),
    });
    expect(
      await dispatchWorktreeAction(
        { action: { type: 'pipeline.run', pipelineId: data.info.id } },
        runtime,
      ),
    ).toMatchObject({ ok: true });
    const start = startPipelineExecutionFromMainMock.mock.calls[0]?.[0];
    expect(start?.pipeline).toEqual(data.content);
    expect(start?.options.pipelinePreferenceLocator).toEqual({
      type: 'stored',
      source: 'curated',
      value: data.info.id,
      contentHash: data.info.curatedContentHash,
    });
  });

  it.each(['bundled', 'user'] as const)(
    'records the stored %s locator the UI derives when an agent runs a pipeline',
    async (source) => {
      // Without it, watcher delivery cannot resolve the definition's owner and
      // denies the run as unverifiable, stranding the requesting chat.
      const data = pipelineData();
      data.info = {
        ...data.info,
        id: `${source}-review`,
        source,
        readonly: source === 'bundled',
      };
      getPipelineMock.mockReturnValue({ success: true, data });
      startPipelineExecutionFromMainMock.mockResolvedValue({
        success: true,
        data: executionState({ pipeline_id: data.info.id, status: 'running' }),
      });
      expect(
        await dispatchWorktreeAction(
          { action: { type: 'pipeline.run', pipelineId: data.info.id } },
          runtime,
        ),
      ).toMatchObject({ ok: true });
      expect(
        startPipelineExecutionFromMainMock.mock.calls[0]?.[0].options
          .pipelinePreferenceLocator,
      ).toEqual({ type: 'stored', source, value: data.info.id });
    },
  );

  it('includes shared pipelines in the scoped pipeline list', async () => {
    listSharedPipelinesMock.mockResolvedValue({
      data: [sharedPipelineData()],
      nextCursor: null,
    });

    const result = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list' } },
      runtime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        pipelines: [
          expect.objectContaining({
            id: 'shared:canopy-cloud:shared-pipeline',
            source: 'shared',
            enabled: true,
            runModes: [
              { mode: 'dispatch', inputCount: null },
              { mode: 'plan_ready', inputCount: null },
            ],
          }),
        ],
      },
    });
    expect(assertCanopyCloudCapabilityMock).toHaveBeenCalledWith(
      'pipelines-crud-v1',
    );
    expect(withPipelineCrudTelemetry).toHaveBeenCalledWith(
      { action: 'list', source: 'unknown' },
      expect.any(Function),
    );
  });

  it.each([
    'cloud-not-configured',
    'missing-api-key',
    'unsupported-capability',
  ])(
    'omits shared pipeline warnings when Cloud is unavailable with %s',
    async (code) => {
      assertCanopyCloudCapabilityMock.mockRejectedValue(
        new CanopyCloudClientError(code, 'Cloud is not configured.'),
      );

      const result = await dispatchWorktreeAction(
        { action: { type: 'pipeline.list' } },
        runtime,
      );

      expect(result).toMatchObject({
        ok: true,
        result: { warnings: [] },
      });
      expect(listSharedPipelinesMock).not.toHaveBeenCalled();
    },
  );

  it('emits pipeline CRUD telemetry from the live scoped get handler', async () => {
    const result = await dispatchWorktreeAction(
      { action: { type: 'pipeline.get', pipelineId: 'pipe-1' } },
      runtime,
    );

    expect(result).toMatchObject({ ok: true });
    expect(withPipelineCrudTelemetry).toHaveBeenCalledWith(
      { action: 'get', source: 'unknown', hasPipelineId: true },
      expect.any(Function),
    );
  });

  it('omits disabled pipelines by default and reports them when requested', async () => {
    jest
      .mocked(pipelineStore.listPipelines)
      .mockReturnValue({ success: true, data: [pipelineData().info] });
    readPreferencesFileMock.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      disabledPipelineIds: ['pipe-1'],
    });

    const hidden = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list' } },
      runtime,
    );
    const included = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list', includeDisabled: true } },
      runtime,
    );

    expect(hidden).toMatchObject({
      ok: true,
      result: { pipelines: [], totalMatches: 0 },
    });
    expect(included).toMatchObject({
      ok: true,
      result: {
        pipelines: [{ id: 'pipe-1', enabled: false }],
        totalMatches: 1,
      },
    });
  });

  it('reads current hook and intended base-branch settings without mutating them', async () => {
    getWorktreePausedHookKeysMock.mockResolvedValue(['project:pr:create']);
    listHooksMock.mockResolvedValue([hookSummary({ paused: true })]);

    const catalogResult = searchWorktreeActions({
      actionType: 'worktree.get_settings',
    });
    expect(catalogResult.actions).toHaveLength(1);
    const catalogAction = catalogResult.actions[0];
    expect(catalogAction).toMatchObject({
      type: 'worktree.get_settings',
      category: 'worktree',
      fields: [],
    });
    expect(catalogAction?.summary).toContain('intended base branch');
    expect(
      catalogAction?.notes?.some((note) =>
        note.includes('trackedBaseBranch and trackedRepoBaseBranches'),
      ),
    ).toBe(true);

    const result = await dispatchWorktreeAction(
      { action: { type: 'worktree.get_settings' } },
      runtime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pausedHookKeys: ['project:pr:create'],
        hooks: [expect.objectContaining({ paused: true })],
        trackedBaseBranch: 'main',
        trackedRepoBaseBranches: {
          __workspace_root__: 'main',
          'repo-a': 'release/next',
        },
      },
    });
    expect(changeWorktreeHookPauseMock).not.toHaveBeenCalled();
  });

  it('uses App Advisor-compatible defaults when no intended base is persisted', async () => {
    readWorkspaceWorktreesMock.mockResolvedValue([
      {
        id: 'worktree-1',
        branchName: 'feature/default-base',
        createdAt: '2026-09-02T00:00:00.000Z',
      },
    ]);

    const result = await dispatchWorktreeAction(
      { action: { type: 'worktree.get_settings' } },
      runtime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        trackedBaseBranch: null,
        trackedRepoBaseBranches: {},
      },
    });
  });

  it('imports a tracked plan for the current worktree scope', async () => {
    const response = await dispatchWorktreeAction(
      {
        action: {
          type: 'tracked-plan.import',
          filePath: 'docs/plan.md',
          repoId: '__workspace_root__',
        },
      },
      runtime,
    );

    expect(response.ok).toBe(true);
    expect(importTrackedPlanFromPathMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      filePath: 'docs/plan.md',
      repoId: '__workspace_root__',
    });
    expect(response.result).toMatchObject({
      plan: {
        id: 'plan-1',
        source: 'imported',
        title: 'Imported plan',
        sourceFilePath: 'plan.md',
      },
      trackedPlanFilePath: '/canopy/worktrees/worktree-1/tracked-plans.json',
    });
  });

  it('lists current worktree browsers with ids, URLs, titles, and active browser id', async () => {
    const snapshots = [
      browserSnapshot({
        id: 'browser-1',
        url: 'http://localhost:3000',
        title: 'Local app',
      }),
      browserSnapshot({
        id: 'browser-2',
        url: 'http://127.0.0.1:5173/settings',
        title: 'Settings',
      }),
    ];
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      listWorktreeBrowsers: jest.fn().mockReturnValue(snapshots),
      resolveActiveBrowserId: jest.fn().mockReturnValue('browser-2'),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      { action: { type: 'browser.list' } },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      activeBrowserId: 'browser-2',
      browsers: [
        { id: 'browser-1', url: 'http://localhost:3000', title: 'Local app' },
        {
          id: 'browser-2',
          url: 'http://127.0.0.1:5173/settings',
          title: 'Settings',
        },
      ],
    });
  });

  it('threads cancellation into scoped browser profile switching', async () => {
    const snapshot = browserSnapshot();
    const switchProfile = jest.fn().mockResolvedValue({
      status: 'complete',
      operationId: 'switch-op',
      browser: snapshot,
    });
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      listWorktreeBrowsers: jest.fn().mockReturnValue([snapshot]),
      resolveActiveBrowserId: jest.fn().mockReturnValue(snapshot.id),
      switchProfile,
    } as unknown as ReturnType<typeof getBrowserService>);
    const controller = new AbortController();
    const action = {
      type: 'browser.profile.switch' as const,
      operationId: 'switch-op',
      browserId: snapshot.id,
      expectedRuntimeGeneration: 1,
      selection: { kind: 'temporary' as const },
      mode: 'replace' as const,
    };

    await dispatchScopedBrowserAction({ action }, runtime, controller.signal);

    expect(switchProfile).toHaveBeenCalledWith(
      action,
      'agent',
      controller.signal,
    );
  });

  it('opens no browser for a chat driven from another computer', async () => {
    const create = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);
    noteChatDriver(runtime.chatId, 'controller-1');
    try {
      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'browser.open',
            expectedRuntimeGeneration: 1,
            url: 'http://localhost:3001',
          },
        },
        runtime,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message: "Open Browser from the other computer's own window.",
        },
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      resetChatDriversForTests();
    }
  });

  it('returns a repeated pending handoff without recreating a closed browser view', async () => {
    const snapshot = browserSnapshot({ id: 'browser-pending' });
    const create = jest.fn();
    const setActiveBrowser = jest.fn();
    const requestHandoff = jest.fn();
    const service = Object.assign(
      new BrowserService({ getWindow: (): null => null }),
      {
        loadWorktreeState: (): Promise<undefined> => Promise.resolve(undefined),
        hasLiveBrowser: (): boolean => false,
        withRuntimeTarget: <T>(
          _target: unknown,
          operation: () => Promise<T>,
        ): Promise<T> => operation(),
        listWorktreeBrowsers: (): BrowserSessionSnapshot[] => [snapshot],
        create,
        setActiveBrowser,
        requestHandoff,
      },
    );
    getBrowserServiceMock.mockReturnValue(service);
    const handoff = browserHandoffs.request(
      {
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        browserId: snapshot.id,
        runtimeGeneration: snapshot.profile?.runtimeGeneration,
        origin: {
          projectId: runtime.projectId,
          worktreeId: runtime.worktreeId,
          chatTabId: runtime.chatId,
        },
      },
      jest.fn(),
    );
    try {
      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'browser.open',
            browserId: snapshot.id,
            handoff: true,
          },
        },
        runtime,
      );
      expect(result).toMatchObject({
        ok: true,
        result: {
          handoff: { handoffId: handoff.handoffId },
          attention: 'pending',
        },
      });
      expect(create).not.toHaveBeenCalled();
      expect(setActiveBrowser).not.toHaveBeenCalled();
      expect(requestHandoff).not.toHaveBeenCalled();
    } finally {
      browserHandoffs.releaseWorktree(runtime.projectId, runtime.worktreeId);
    }
  });

  it('reuses an existing browser instance when browser.open receives a browser id', async () => {
    const snapshot = browserSnapshot({
      id: 'browser-2',
      url: 'http://localhost:3001',
      title: 'Existing app',
    });
    const create = jest.fn().mockResolvedValue(snapshot);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      setActiveBrowser,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([snapshot]),
    } as unknown as ReturnType<typeof getBrowserService>);
    const send = jest.fn();
    const runtimeWithBrowserWindow: WorktreeActionRuntime = {
      ...runtime,
      getWindow: () =>
        ({
          isDestroyed: (): boolean => false,
          webContents: {
            isDestroyed: (): boolean => false,
            isCrashed: (): boolean => false,
            mainFrame: {
              isDestroyed: (): boolean => false,
              detached: false,
            },
            send,
          },
        }) as never,
    };

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          browserId: 'browser-2',
          url: 'http://localhost:3001',
        },
      },
      runtimeWithBrowserWindow,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      browser: {
        id: 'browser-2',
        url: 'http://localhost:3001',
        title: 'Existing app',
      },
    });
    expect(create).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-2',
        url: 'http://localhost:3001',
      },
      'agent',
    );
    expect(setActiveBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-2',
    );
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.browserEvent, {
      type: 'open-requested',
      browserId: 'browser-2',
      snapshot,
      originChatTabId: 'chat-1',
      createdNewSession: false,
    });
    const activationOrder = setActiveBrowser.mock.invocationCallOrder[0];
    const eventOrder = send.mock.invocationCallOrder[0];
    expect(activationOrder).toBeDefined();
    expect(eventOrder).toBeDefined();
    if (activationOrder === undefined || eventOrder === undefined) {
      throw new Error('Expected activation and open-requested calls.');
    }
    expect(activationOrder).toBeLessThan(eventOrder);
  });

  it('marks an open-requested event as newly created for renderer rollback', async () => {
    const snapshot = browserSnapshot({ id: 'browser-new' });
    const create = jest.fn().mockResolvedValue(snapshot);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      setActiveBrowser,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);
    const send = jest.fn();
    const runtimeWithBrowserWindow: WorktreeActionRuntime = {
      ...runtime,
      getWindow: () =>
        ({
          isDestroyed: (): boolean => false,
          webContents: {
            isDestroyed: (): boolean => false,
            isCrashed: (): boolean => false,
            mainFrame: {
              isDestroyed: (): boolean => false,
              detached: false,
            },
            send,
          },
        }) as never,
    };

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      },
      runtimeWithBrowserWindow,
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.browserEvent,
      expect.objectContaining({
        type: 'open-requested',
        browserId: 'browser-new',
        createdNewSession: true,
      }),
    );
  });

  it('marks an empty browser id as newly created for renderer rollback', async () => {
    const snapshot = browserSnapshot({ id: 'browser-new' });
    let createdId: string | undefined;
    const create = jest.fn((request: { browserId?: string }) => {
      createdId = request.browserId;
      return Promise.resolve(snapshot);
    });
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      setActiveBrowser,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);
    const send = jest.fn();
    const runtimeWithBrowserWindow: WorktreeActionRuntime = {
      ...runtime,
      getWindow: () =>
        ({
          isDestroyed: (): boolean => false,
          webContents: {
            isDestroyed: (): boolean => false,
            isCrashed: (): boolean => false,
            mainFrame: {
              isDestroyed: (): boolean => false,
              detached: false,
            },
            send,
          },
        }) as never,
    };

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          browserId: '',
        },
      },
      runtimeWithBrowserWindow,
    );

    expect(result.ok).toBe(true);
    // A new session gets a fresh id (never the empty one), announced to the
    // renderer BEFORE the slow create so its tab appears immediately.
    expect(createdId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(create).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: createdId,
      },
      'agent',
    );
    expect(send.mock.calls[0]).toEqual([
      IPC_CHANNELS.browserEvent,
      {
        type: 'open-pending',
        browserId: createdId,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        originChatTabId: runtime.chatId,
      },
    ]);
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.browserEvent,
      expect.objectContaining({
        type: 'open-requested',
        browserId: 'browser-new',
        createdNewSession: true,
      }),
    );
  });

  it('tells the renderer to remove the announced tab when creation fails', async () => {
    const create = jest.fn().mockRejectedValue(new Error('Profile locked'));
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      setActiveBrowser: jest.fn(),
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);
    const send = jest.fn<void, [string, { browserId?: string }]>();
    const runtimeWithBrowserWindow: WorktreeActionRuntime = {
      ...runtime,
      getWindow: () =>
        ({
          isDestroyed: (): boolean => false,
          webContents: {
            isDestroyed: (): boolean => false,
            isCrashed: (): boolean => false,
            mainFrame: {
              isDestroyed: (): boolean => false,
              detached: false,
            },
            send,
          },
        }) as never,
    };

    await expect(
      dispatchWorktreeAction(
        {
          action: {
            type: 'browser.open',
            expectedRuntimeGeneration: 1,
            url: 'http://localhost:3001',
          },
        },
        runtimeWithBrowserWindow,
      ),
    ).rejects.toThrow('Profile locked');

    const events = send.mock.calls.map((call) => call[1]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'open-pending',
        url: 'http://localhost:3001',
      }),
      { type: 'destroyed', browserId: events[0]?.browserId },
    ]);
  });

  it('destroys the created session and drops the announced tab when activation fails', async () => {
    const create = jest
      .fn()
      .mockResolvedValue(browserSnapshot({ id: 'browser-created' }));
    const destroy = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      destroy,
      setActiveBrowser: jest
        .fn()
        .mockRejectedValue(new Error('browser-state write failed')),
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);
    const send = jest.fn<void, [string, { browserId?: string }]>();
    const runtimeWithBrowserWindow: WorktreeActionRuntime = {
      ...runtime,
      getWindow: () =>
        ({
          isDestroyed: (): boolean => false,
          webContents: {
            isDestroyed: (): boolean => false,
            isCrashed: (): boolean => false,
            mainFrame: {
              isDestroyed: (): boolean => false,
              detached: false,
            },
            send,
          },
        }) as never,
    };

    await expect(
      dispatchWorktreeAction(
        {
          action: {
            type: 'browser.open',
            expectedRuntimeGeneration: 1,
            url: 'http://localhost:3001',
          },
        },
        runtimeWithBrowserWindow,
      ),
    ).rejects.toThrow('browser-state write failed');

    const events = send.mock.calls.map((call) => call[1]);
    const announcedId = events[0]?.browserId;
    expect(events).toEqual([
      expect.objectContaining({ type: 'open-pending' }),
      { type: 'destroyed', browserId: announcedId },
    ]);
    expect(destroy).toHaveBeenCalledWith(announcedId);
  });

  it('creates a new binding instead of reusing a URL from an unspecified profile', async () => {
    const snapshot = browserSnapshot({
      id: 'browser-2',
      url: 'http://localhost:3001',
      title: 'Existing app',
    });
    const create = jest.fn().mockResolvedValue(snapshot);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      setActiveBrowser,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([snapshot]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'localhost:3001',
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      browser: {
        id: 'browser-2',
        url: 'http://localhost:3001',
        title: 'Existing app',
      },
    });
    expect(create).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        url: 'http://localhost:3001',
        browserId: FRESH_BROWSER_ID,
      },
      'agent',
    );
    expect(setActiveBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-2',
    );
  });

  it('routes external browser.open URLs through the system browser without creating a tab', async () => {
    const create = jest.fn();
    const openExternal = jest.fn().mockResolvedValue(undefined);
    const send = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      openExternal,
      isUrlAllowedInApp: jest.fn().mockReturnValue(false),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'https://example.com/docs',
        },
      },
      {
        ...runtime,
        getWindow: () =>
          ({
            isDestroyed: (): boolean => false,
            webContents: {
              isDestroyed: (): boolean => false,
              isCrashed: (): boolean => false,
              mainFrame: { isDestroyed: (): boolean => false, detached: false },
              send,
            },
          }) as never,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      browser: null,
      openedUrl: 'https://example.com/docs',
    });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.browserEvent, {
      type: 'app-link-local-only-conflict',
      url: 'https://example.com/docs',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('opens an absolute local path in-app without leaking it to the system browser', async () => {
    const snapshot = browserSnapshot({
      id: 'browser-file',
      url: 'file:///tmp/My%20Report/index.html',
      title: 'Local report',
    });
    const create = jest.fn().mockResolvedValue(snapshot);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    const openExternal = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      create,
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      setActiveBrowser,
      openExternal,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          url: '/tmp/My Report/index.html',
        },
      },
      runtime,
    );

    expect(result).toMatchObject({ ok: true, result: { browser: snapshot } });
    expect(create).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        url: 'file:///tmp/My%20Report/index.html',
        browserId: FRESH_BROWSER_ID,
      },
      'agent',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('refuses a network file URL instead of falling back to the system browser', async () => {
    const create = jest.fn();
    const openExternal = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      create,
      openExternal,
      isUrlAllowedInApp: jest.fn().mockReturnValue(false),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          url: 'file://fileserver/share/report.html',
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message:
          'Enter an http or https URL, or the full path to a local file.',
      },
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('opens remote browser.open URLs in-app when Browser settings allow them', async () => {
    const snapshot = browserSnapshot({
      id: 'browser-remote',
      url: 'https://example.com/docs',
      title: 'Docs',
    });
    const create = jest.fn().mockResolvedValue(snapshot);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    const openExternal = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      setActiveBrowser,
      openExternal,
      isUrlAllowedInApp: jest.fn().mockReturnValue(true),
      listWorktreeBrowsers: jest.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'https://example.com/docs',
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ browser: snapshot });
    expect(create).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        url: 'https://example.com/docs',
        browserId: FRESH_BROWSER_ID,
      },
      'agent',
    );
    expect(setActiveBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-remote',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('uses the provided browser id for browser.start_recording', async () => {
    const startRecording = jest.fn().mockResolvedValue({
      id: 'browser-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      createdAt: 1,
      updatedAt: 2,
      url: 'http://localhost:3000',
      title: 'App',
      status: 'ready',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      themeMode: 'light',
      pickMode: false,
      recording: true,
    });
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create: jest.fn().mockResolvedValue({ id: 'browser-1' }),
      waitForInitialLoad: jest.fn().mockResolvedValue({ id: 'browser-1' }),
      startRecording,
      resolveActiveBrowserId: jest.fn(),
      listWorktreeBrowsers: jest.fn().mockReturnValue([
        {
          id: 'browser-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.start_recording',
          expectedRuntimeGeneration: 1,
          browserId: 'browser-1',
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(startRecording).toHaveBeenCalledWith('browser-1');
  });

  it('falls back to the active browser for browser.stop_recording', async () => {
    const stopRecording = jest.fn().mockResolvedValue({
      browserId: 'browser-2',
      recording: false,
      steps: [],
      playwrightScript: '',
    });
    const create = jest.fn().mockResolvedValue({ id: 'browser-2' });
    const resolveActiveBrowserId = jest.fn().mockReturnValue('browser-2');
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      stopRecording,
      resolveActiveBrowserId,
      listWorktreeBrowsers: jest.fn().mockReturnValue([
        {
          id: 'browser-2',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          url: 'http://localhost:3000',
          themeMode: 'light',
        },
      ]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.stop_recording',
          expectedRuntimeGeneration: 1,
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(resolveActiveBrowserId).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(create).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    expect(stopRecording).toHaveBeenCalledWith('browser-2');
  });

  it('rehydrates a persisted active browser before dispatching browser actions', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'browser-persisted' });
    const navigate = jest.fn().mockResolvedValue({
      id: 'browser-persisted',
      url: 'http://localhost:3001',
    });
    const resolveActiveBrowserId = jest
      .fn()
      .mockReturnValue('browser-persisted');
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      navigate,
      resolveActiveBrowserId,
      listWorktreeBrowsers: jest.fn().mockReturnValue([
        {
          id: 'browser-persisted',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          url: 'http://localhost:3000',
          themeMode: 'dark',
        },
      ]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.navigate',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3001',
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-persisted',
    });
    expect(navigate).toHaveBeenCalledWith({
      browserId: 'browser-persisted',
      url: 'http://localhost:3001',
    });
  });

  it('returns not_found when a browser action has no target browser', async () => {
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      resolveActiveBrowserId: jest.fn().mockReturnValue(null),
      listWorktreeBrowsers: jest.fn(),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.reload',
          expectedRuntimeGeneration: 1,
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'not_found',
        message: 'No in-app browser is available for this worktree.',
      },
    });
  });

  it('rejects provided browser ids outside the current worktree', async () => {
    const screenshot = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      screenshot,
      resolveActiveBrowserId: jest.fn(),
      listWorktreeBrowsers: jest.fn().mockReturnValue([
        {
          id: 'browser-current',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ]),
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.screenshot',
          expectedRuntimeGeneration: 1,
          browserId: 'browser-other-worktree',
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'not_found',
        message: 'No in-app browser is available for this worktree.',
      },
    });
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('reads and handles pending browser JavaScript dialogs', async () => {
    const snapshot = browserSnapshot();
    const dialog = {
      id: 'dialog-1',
      browserId: 'browser-1',
      type: 'prompt' as const,
      message: 'Name',
      defaultPrompt: 'initial',
      url: snapshot.url,
      openedAt: 1,
    };
    const getDialog = jest.fn().mockReturnValue(dialog);
    const handleDialog = jest.fn().mockResolvedValue({
      dialog,
      accept: true,
      promptText: 'updated',
    });
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'getDialog').mockImplementation(getDialog);
    jest.spyOn(browserService, 'getFileChooser').mockReturnValue(null);
    jest.spyOn(browserService, 'getPrintRequest').mockReturnValue(null);
    jest.spyOn(browserService, 'getAuthRequest').mockReturnValue(null);
    jest.spyOn(browserService, 'handleDialog').mockImplementation(handleDialog);
    getBrowserServiceMock.mockReturnValue(browserService);

    const readResult = await dispatchWorktreeAction(
      { action: { type: 'browser.get_dialog' } },
      runtime,
    );
    expect(readResult).toMatchObject({
      ok: true,
      result: {
        browser: { id: 'browser-1' },
        dialog: { id: 'dialog-1', type: 'prompt' },
        fileChooser: null,
        printRequest: null,
        auth: null,
      },
    });

    const handleResult = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.handle_dialog',
          expectedRuntimeGeneration: 1,
          dialogId: 'dialog-1',
          accept: true,
          promptText: 'updated',
        },
      },
      runtime,
    );
    expect(handleDialog).toHaveBeenCalledWith({
      browserId: 'browser-1',
      dialogId: 'dialog-1',
      accept: true,
      promptText: 'updated',
    });
    expect(handleResult).toMatchObject({
      ok: true,
      result: {
        handled: {
          accept: true,
          promptText: 'updated',
          dialog: { id: 'dialog-1' },
        },
      },
    });
  });

  it('reports a pending file chooser and dismisses it, but refuses to accept it', async () => {
    const snapshot = browserSnapshot();
    const chooser = {
      id: 'chooser-1',
      browserId: 'browser-1',
      frameOrigin: 'http://localhost:3000',
      topOrigin: 'http://localhost:3000',
      multiple: false,
      openedAt: 1,
      expiresAt: 2,
    };
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'getDialog').mockReturnValue(null);
    jest.spyOn(browserService, 'getFileChooser').mockReturnValue(chooser);
    jest.spyOn(browserService, 'getPrintRequest').mockReturnValue(null);
    jest.spyOn(browserService, 'getAuthRequest').mockReturnValue(null);
    const handleDialog = jest.spyOn(browserService, 'handleDialog');
    const answerFileChooser = jest
      .spyOn(browserService, 'answerFileChooser')
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    getBrowserServiceMock.mockReturnValue(browserService);

    await expect(
      dispatchWorktreeAction(
        { action: { type: 'browser.get_dialog' } },
        runtime,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { dialog: null, fileChooser: { id: 'chooser-1' } },
    });

    const handle = (
      accept: boolean,
    ): ReturnType<typeof dispatchWorktreeAction> =>
      dispatchWorktreeAction(
        {
          action: {
            type: 'browser.handle_dialog',
            expectedRuntimeGeneration: 1,
            dialogId: 'chooser-1',
            accept,
          },
        },
        runtime,
      );
    await expect(handle(true)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        details: {
          error: { code: 'unsupported_control', next: 'browser.upload_files' },
        },
      },
    });
    expect(answerFileChooser).not.toHaveBeenCalled();
    await expect(handle(false)).resolves.toMatchObject({
      ok: true,
      result: { handled: { fileChooserId: 'chooser-1', accept: false } },
    });
    expect(answerFileChooser).toHaveBeenCalledWith({
      browserId: 'browser-1',
      chooserId: 'chooser-1',
      answer: 'dismiss',
    });
    await expect(handle(false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(handleDialog).not.toHaveBeenCalled();
  });

  it('reports a pending print request, saves it as a PDF on accept, and dismisses it otherwise', async () => {
    const snapshot = browserSnapshot();
    const request = {
      id: 'print-1',
      browserId: 'browser-1',
      frameOrigin: 'http://localhost:3000',
      topOrigin: 'http://localhost:3000',
      openedAt: 1,
      expiresAt: 2,
    };
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'getDialog').mockReturnValue(null);
    jest.spyOn(browserService, 'getFileChooser').mockReturnValue(null);
    jest.spyOn(browserService, 'getPrintRequest').mockReturnValue(request);
    jest.spyOn(browserService, 'getAuthRequest').mockReturnValue(null);
    const answerPrintRequest = jest
      .spyOn(browserService, 'answerPrintRequest')
      .mockResolvedValueOnce({
        ok: true,
        transfer: {
          kind: 'download',
          id: 'download-1',
          browserId: 'browser-1',
          source: 'print',
          origin: 'http://localhost:3000/',
          fileName: 'Lab.pdf',
          receivedBytes: 1,
          totalBytes: 1,
          status: 'complete',
          startedAt: 1,
        },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'download_failed', message: 'Printing failed.' },
      });
    getBrowserServiceMock.mockReturnValue(browserService);

    await expect(
      dispatchWorktreeAction(
        { action: { type: 'browser.get_dialog' } },
        runtime,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { printRequest: { id: 'print-1' } },
    });
    const handle = (
      accept: boolean,
    ): ReturnType<typeof dispatchWorktreeAction> =>
      dispatchWorktreeAction(
        {
          action: {
            type: 'browser.handle_dialog',
            expectedRuntimeGeneration: 1,
            dialogId: 'print-1',
            accept,
          },
        },
        runtime,
      );
    await expect(handle(true)).resolves.toMatchObject({
      ok: true,
      result: {
        handled: {
          printRequestId: 'print-1',
          accept: true,
          transfer: { id: 'download-1', source: 'print' },
        },
      },
    });
    await expect(handle(false)).resolves.toMatchObject({
      ok: true,
      result: { handled: { printRequestId: 'print-1', accept: false } },
    });
    await expect(handle(true)).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'Printing failed.' },
    });
    expect(answerPrintRequest.mock.calls.map(([call]) => call.answer)).toEqual([
      'save_pdf',
      'dismiss',
      'save_pdf',
    ]);
  });

  it('reports a pending sign-in, cancels it, and refuses to accept it for the user', async () => {
    const snapshot = browserSnapshot();
    const auth = {
      id: 'auth-1',
      browserId: 'browser-1',
      origin: 'http://localhost:3000',
      realm: 'Staff',
      isProxy: false,
      openedAt: 1,
      expiresAt: 2,
    };
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'getDialog').mockReturnValue(null);
    jest.spyOn(browserService, 'getFileChooser').mockReturnValue(null);
    jest.spyOn(browserService, 'getPrintRequest').mockReturnValue(null);
    jest.spyOn(browserService, 'getAuthRequest').mockReturnValue(auth);
    const answerAuthRequest = jest
      .spyOn(browserService, 'answerAuthRequest')
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false });
    getBrowserServiceMock.mockReturnValue(browserService);

    await expect(
      dispatchWorktreeAction(
        { action: { type: 'browser.get_dialog' } },
        runtime,
      ),
    ).resolves.toMatchObject({ ok: true, result: { auth: { id: 'auth-1' } } });
    const handle = (
      accept: boolean,
    ): ReturnType<typeof dispatchWorktreeAction> =>
      dispatchWorktreeAction(
        {
          action: {
            type: 'browser.handle_dialog',
            expectedRuntimeGeneration: 1,
            dialogId: 'auth-1',
            accept,
          },
        },
        runtime,
      );
    await expect(handle(true)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        details: { error: { code: 'policy_denied' } },
      },
    });
    expect(answerAuthRequest).not.toHaveBeenCalled();
    await expect(handle(false)).resolves.toMatchObject({
      ok: true,
      result: { handled: { authRequestId: 'auth-1', accept: false } },
    });
    await expect(handle(false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(answerAuthRequest).toHaveBeenCalledWith({
      browserId: 'browser-1',
      authRequestId: 'auth-1',
      answer: 'cancel',
    });
  });

  it('passes a pre-armed response to dialog-producing browser actions', async () => {
    const snapshot = browserSnapshot();
    const dialog = {
      id: 'dialog-2',
      browserId: 'browser-1',
      type: 'confirm' as const,
      message: 'Continue?',
      url: snapshot.url,
      openedAt: 1,
    };
    const automation = jest.fn().mockResolvedValue({
      ok: true,
      completed: false,
      browser: snapshot,
      dialog,
    });
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'automation').mockImplementation(automation);
    getBrowserServiceMock.mockReturnValue(browserService);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 1,
          ref: 'input-1',
          dialogResponse: { accept: false },
        },
      },
      runtime,
    );

    expect(automation).toHaveBeenCalledWith({
      browserId: 'browser-1',
      command: {
        kind: 'click',
        ref: 'input-1',
        dialogResponse: { accept: false },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        completed: false,
        dialog: { id: 'dialog-2', type: 'confirm' },
      },
    });

    automation.mockResolvedValueOnce({
      ok: true,
      completed: true,
      browser: snapshot,
      handledDialog: {
        dialog,
        accept: false,
      },
    });
    const handledResult = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 1,
          ref: 'input-1',
          dialogResponse: { accept: false },
        },
      },
      runtime,
    );
    expect(handledResult).toMatchObject({
      ok: true,
      result: {
        completed: true,
        handledDialog: {
          accept: false,
          dialog: { id: 'dialog-2', type: 'confirm' },
        },
      },
    });
  });

  it('dispatches browser automation actions and projects replay and wait results', async () => {
    const snapshot = browserSnapshot();
    const waitFor = {
      satisfied: true,
      elapsedMs: 12,
      observed: { url: 'http://localhost:3000/ready', matchCount: 1 },
    };
    const receipt = {
      actionId: 'wait-locator-action',
      sequence: 2,
      kind: 'wait_for' as const,
      status: 'executed' as const,
      durationMs: 12,
    };
    const pointerReceipt: BrowserActionReceipt = {
      actionId: 'pointer',
      sequence: 3,
      kind: 'scroll',
      status: 'executed',
      durationMs: 10,
      effects: {
        scroll: {
          container: 'page',
          axis: 'y',
          x: 0,
          y: 200,
          maxX: 0,
          maxY: 500,
          atStart: false,
          atEnd: false,
          moved: true,
          contentGrew: true,
        },
      },
      target: {
        ref: 'card',
        tagName: 'div',
        disabled: false,
        focused: false,
        inViewport: true,
        bounds: { x: 0, y: 100, width: 20, height: 20 },
      },
    };
    const selectReceipt: BrowserActionReceipt = {
      actionId: 'select-action',
      sequence: 4,
      kind: 'select_option',
      status: 'executed',
      durationMs: 16,
      target: {
        ref: 'country',
        tagName: 'select',
        disabled: false,
        focused: false,
        inViewport: true,
        bounds: { x: 10, y: 20, width: 120, height: 32 },
        options: [
          { value: 'ca', label: 'Canada', selected: true, disabled: false },
        ],
      },
      readback: {
        code: 'state_unchanged',
        next: 'Review the reported value before retrying.',
      },
    };
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'hasLiveBrowser').mockReturnValue(true);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue(snapshot.id);
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    const withRuntimeTarget = jest
      .spyOn(browserService, 'withRuntimeTarget')
      .mockImplementation((_target, operation) => operation());
    const automation = jest
      .spyOn(browserService, 'automation')
      .mockImplementation((request) =>
        Promise.resolve({
          ok: true,
          completed: true,
          browser: snapshot,
          repeated: true,
          ...(request.command.kind === 'wait_for' ? { waitFor, receipt } : {}),
          ...(request.command.kind === 'select_option'
            ? { receipt: selectReceipt }
            : {}),
          ...(['hover', 'scroll', 'drag'].includes(request.command.kind)
            ? { receipt: { ...pointerReceipt, kind: request.command.kind } }
            : {}),
        }),
      );
    getBrowserServiceMock.mockReturnValue(browserService);

    const actions: Array<{
      action: DispatchWorktreeActionInput['action'];
      command: Record<string, unknown>;
    }> = [
      {
        action: {
          type: 'browser.hover',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          locator: '#menu',
          frame: 'f',
          actionId: 'hover',
          timeoutMs: 123,
        },
        command: {
          kind: 'hover',
          locator: '#menu',
          frame: 'f',
          actionId: 'hover',
          timeoutMs: 123,
        },
      },
      {
        action: {
          type: 'browser.scroll',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          direction: 'left',
          pages: 0.5,
          ref: 'list',
          actionId: 'scroll',
        },
        command: {
          kind: 'scroll',
          direction: 'left',
          pages: 0.5,
          ref: 'list',
          actionId: 'scroll',
        },
      },
      {
        action: {
          type: 'browser.drag',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          from: { ref: 'card' },
          to: { dx: -20, dy: 0 },
          steps: 4,
          modifiers: ['Shift'],
        },
        command: {
          kind: 'drag',
          from: { ref: 'card' },
          to: { dx: -20, dy: 0 },
          steps: 4,
          modifiers: ['Shift'],
        },
      },

      {
        action: {
          type: 'browser.click',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          ref: 'submit-ref',
          button: 'right',
          clickCount: 2,
          modifiers: ['Control', 'Shift'],
          position: { x: 1, y: 2 },
          dialogResponse: { accept: true, promptText: 'confirm' },
          actionId: 'click-action',
          timeoutMs: 12_345,
        },
        command: {
          kind: 'click',
          ref: 'submit-ref',
          button: 'right',
          clickCount: 2,
          modifiers: ['Control', 'Shift'],
          position: { x: 1, y: 2 },
          dialogResponse: { accept: true, promptText: 'confirm' },
          actionId: 'click-action',
          timeoutMs: 12_345,
        },
      },
      {
        action: {
          type: 'browser.click',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          frame: '  iframe.checkout  ',
          locator: 'button#force',
          force: true,
          actionId: 'click-force-action',
        },
        command: {
          kind: 'click',
          frame: '  iframe.checkout  ',
          locator: 'button#force',
          force: true,
          actionId: 'click-force-action',
        },
      },
      {
        action: {
          type: 'browser.fill',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          frame: '  iframe.checkout  ',
          locator: 'input[name=email]',
          text: 'person@example.test',
          actionId: 'fill-action',
          timeoutMs: 23_456,
        },
        command: {
          kind: 'fill',
          frame: '  iframe.checkout  ',
          locator: 'input[name=email]',
          text: 'person@example.test',
          actionId: 'fill-action',
          timeoutMs: 23_456,
        },
      },
      {
        action: {
          type: 'browser.set_checked',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          locator: '#terms',
          checked: true,
          actionId: 'checked-action',
          timeoutMs: 24_567,
        },
        command: {
          kind: 'set_checked',
          locator: '#terms',
          checked: true,
          actionId: 'checked-action',
          timeoutMs: 24_567,
        },
      },
      {
        action: {
          type: 'browser.select_option',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          locator: '#country',
          values: ['ca'],
          searchText: 'Canada',
          actionId: 'select-action',
          timeoutMs: 25_678,
        },
        command: {
          kind: 'select_option',
          locator: '#country',
          values: ['ca'],
          searchText: 'Canada',
          actionId: 'select-action',
          timeoutMs: 25_678,
        },
      },
      {
        action: {
          type: 'browser.type',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          locator: '#search',
          text: 'query',
          delayMs: 37,
          actionId: 'type-action',
          timeoutMs: 26_789,
        },
        command: {
          kind: 'type',
          locator: '#search',
          text: 'query',
          delayMs: 37,
          actionId: 'type-action',
          timeoutMs: 26_789,
        },
      },
      {
        action: {
          type: 'browser.press',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          key: 'Enter',
          locator: '#input',
          frame: 'f-checkout-1',
          dialogResponse: { accept: false },
          actionId: 'press-action',
          timeoutMs: 34_567,
        },
        command: {
          kind: 'press',
          key: 'Enter',
          locator: '#input',
          frame: 'f-checkout-1',
          dialogResponse: { accept: false },
          actionId: 'press-action',
          timeoutMs: 34_567,
        },
      },
      {
        action: {
          type: 'browser.focus',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          ref: 'input-ref',
          actionId: 'focus-ref-action',
          timeoutMs: 45_678,
        },
        command: {
          kind: 'focus',
          ref: 'input-ref',
          actionId: 'focus-ref-action',
          timeoutMs: 45_678,
        },
      },
      {
        action: {
          type: 'browser.focus',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          frame: '  iframe.checkout  ',
          locator: 'input[name=email]',
          actionId: 'focus-locator-action',
          timeoutMs: 56_789,
        },
        command: {
          kind: 'focus',
          frame: '  iframe.checkout  ',
          locator: 'input[name=email]',
          actionId: 'focus-locator-action',
          timeoutMs: 56_789,
        },
      },
      {
        action: {
          type: 'browser.wait_for',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          frame: '  iframe.checkout  ',
          locator: '#ready',
          state: 'hidden',
          actionId: 'wait-locator-action',
          timeoutMs: 67_890,
        },
        command: {
          kind: 'wait_for',
          frame: '  iframe.checkout  ',
          locator: '#ready',
          state: 'hidden',
          actionId: 'wait-locator-action',
          timeoutMs: 67_890,
        },
      },
      {
        action: {
          type: 'browser.wait_for',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          frame: 'f-checkout-1',
          text: 'Ready',
          state: 'attached',
          actionId: 'wait-text-action',
        },
        command: {
          kind: 'wait_for',
          frame: 'f-checkout-1',
          text: 'Ready',
          state: 'attached',
          actionId: 'wait-text-action',
        },
      },
      {
        action: {
          type: 'browser.wait_for',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          url: '**/ready',
          actionId: 'wait-url-action',
        },
        command: {
          kind: 'wait_for',
          url: '**/ready',
          actionId: 'wait-url-action',
        },
      },
      {
        action: {
          type: 'browser.wait_for',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          loadState: 'network_idle',
          actionId: 'wait-load-state-action',
        },
        command: {
          kind: 'wait_for',
          loadState: 'network_idle',
          actionId: 'wait-load-state-action',
        },
      },
      {
        action: {
          type: 'browser.wait_for',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          download: { downloadId: 'download-1' },
          actionId: 'wait-download-action',
          timeoutMs: 120000,
        },
        command: {
          kind: 'wait_for',
          download: { downloadId: 'download-1' },
          actionId: 'wait-download-action',
          timeoutMs: 120000,
        },
      },
      {
        action: {
          type: 'browser.wait_for',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          download: {},
          actionId: 'wait-next-download-action',
        },
        command: {
          kind: 'wait_for',
          download: {},
          actionId: 'wait-next-download-action',
        },
      },
    ];
    const signal = new AbortController().signal;

    for (let index = 0; index < actions.length; index += 1) {
      const entry = actions[index];
      if (!entry) throw new Error(`Missing browser action case ${index}`);
      const { action, command } = entry;
      expect(browserDispatchSchema.safeParse({ action }).success).toBe(true);
      const result = await dispatchWorktreeAction(
        { action },
        { ...runtime, signal },
      );

      expect(result).toMatchObject({
        ok: true,
        result: { browser: { id: snapshot.id }, repeated: true },
      });
      if (
        action.type === 'browser.hover' ||
        action.type === 'browser.scroll' ||
        action.type === 'browser.drag'
      )
        expect(result.result).toMatchObject({
          receipt: { ...pointerReceipt, kind: command.kind },
        });
      if (action.type === 'browser.select_option')
        expect(result.result).toHaveProperty('receipt', selectReceipt);
      if (action.type === 'browser.wait_for') {
        expect(result.result).toMatchObject({ waitFor });
        if (action.actionId === 'wait-locator-action')
          expect(result.result).toMatchObject({ receipt });
      }
      expect(automation).toHaveBeenNthCalledWith(
        index + 1,
        { browserId: snapshot.id, command },
        signal,
      );
    }

    expect(withRuntimeTarget).toHaveBeenCalledWith(
      {
        browserId: snapshot.id,
        expectedRuntimeGeneration: 9,
      },
      expect.any(Function),
      { dialog: false, rehydrate: true },
    );
    expect(withRuntimeTarget.mock.calls).toHaveLength(actions.length);
    expect(withRuntimeTarget.mock.calls.map(([target]) => target)).toEqual(
      actions.map(() => ({
        browserId: snapshot.id,
        expectedRuntimeGeneration: 9,
      })),
    );
    expect(automation.mock.calls).toHaveLength(actions.length);
  });

  it.each(['timeout', 'invalid_payload'] as const)(
    'preserves browser automation %s errors and receipt details',
    async (errorCode) => {
      const snapshot = browserSnapshot();
      const receipt = {
        actionId: 'wait-failure',
        sequence: 4,
        kind: 'wait_for' as const,
        status: 'not_executed' as const,
        durationMs: 20,
      };
      const browserService = new BrowserService({
        getWindow: (): null => null,
      });
      jest
        .spyOn(browserService, 'loadWorktreeState')
        .mockResolvedValue({ status: 'missing', state: null });
      jest.spyOn(browserService, 'hasLiveBrowser').mockReturnValue(true);
      jest
        .spyOn(browserService, 'resolveActiveBrowserId')
        .mockReturnValue(snapshot.id);
      jest
        .spyOn(browserService, 'listWorktreeBrowsers')
        .mockReturnValue([snapshot]);
      jest
        .spyOn(browserService, 'withRuntimeTarget')
        .mockImplementation(async (_target, operation) => await operation());
      jest.spyOn(browserService, 'automation').mockResolvedValue({
        ok: false,
        error: {
          code: errorCode,
          message: `Browser ${errorCode}`,
          details: receipt,
        },
      });
      getBrowserServiceMock.mockReturnValue(browserService);

      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'browser.wait_for',
            browserId: snapshot.id,
            expectedRuntimeGeneration: 4,
            locator: '#ready',
            actionId: 'wait-failure',
          },
        },
        runtime,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: errorCode,
          message: `Browser ${errorCode}`,
          details: receipt,
        },
      });
    },
  );

  it.each([
    {
      outerCode: 'invalid_target' as const,
      receiptCode: 'unsupported_control' as const,
    },
    {
      outerCode: 'validation_failed' as const,
      receiptCode: 'option_not_found' as const,
    },
  ])(
    'preserves service-supplied $outerCode and the complete browser receipt through MCP worktree dispatch',
    async ({ outerCode, receiptCode }) => {
      const snapshot = browserSnapshot();
      const receipt = {
        actionId: 'select-failure',
        sequence: 5,
        kind: 'select_option' as const,
        status: 'not_executed' as const,
        durationMs: 18,
        error: {
          code: receiptCode,
          message: 'The requested choice could not be applied.',
          retryable: false,
          next: 'Inspect the available options and choose a supported value.',
          options: [
            {
              value: 'ca',
              label: 'Canada',
              selected: false,
              disabled: false,
            },
          ],
          candidatesRedacted: true,
        },
      };
      const browserService = new BrowserService({
        getWindow: (): null => null,
      });
      jest
        .spyOn(browserService, 'loadWorktreeState')
        .mockResolvedValue({ status: 'missing', state: null });
      jest.spyOn(browserService, 'hasLiveBrowser').mockReturnValue(true);
      jest
        .spyOn(browserService, 'resolveActiveBrowserId')
        .mockReturnValue(snapshot.id);
      jest
        .spyOn(browserService, 'listWorktreeBrowsers')
        .mockReturnValue([snapshot]);
      jest
        .spyOn(browserService, 'withRuntimeTarget')
        .mockImplementation(async (_target, operation) => await operation());
      jest.spyOn(browserService, 'automation').mockResolvedValue({
        ok: false,
        error: {
          code: outerCode,
          message: 'The requested choice could not be applied.',
          details: receipt,
        },
      });
      getBrowserServiceMock.mockReturnValue(browserService);

      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'browser.select_option',
            browserId: snapshot.id,
            expectedRuntimeGeneration: 4,
            locator: '#ready',
            values: ['missing'],
            actionId: 'select-failure',
          },
        },
        runtime,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: outerCode,
          message: 'The requested choice could not be applied.',
          details: receipt,
        },
      });
    },
  );

  it('preserves pipeline receipts and error details through the MCP adapter', async () => {
    const snapshot = browserSnapshot();
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue(snapshot.id);
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    const receipt = {
      actionId: 'receipt-1',
      sequence: 1,
      kind: 'fill' as const,
      status: 'not_executed' as const,
      durationMs: 10,
      error: {
        code: 'not_editable' as const,
        message: 'Readonly',
        retryable: false,
      },
    };
    const automation = jest
      .spyOn(browserService, 'automation')
      .mockResolvedValue({
        ok: false,
        receipt,
        error: {
          code: 'invalid_target',
          message: 'Readonly',
          details: receipt,
        },
      });
    getBrowserServiceMock.mockReturnValue(browserService);
    const input = {
      action: {
        type: 'browser.fill' as const,
        expectedRuntimeGeneration: 1,
        ref: 'input-1',
        text: 'private',
      },
    };
    const failed = await dispatchWorktreeAction(input, runtime);
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'invalid_target', details: receipt },
    });
    expect(JSON.stringify(failed)).not.toContain('private');
    const unknownReceipt = {
      actionId: 'unknown-1',
      sequence: 2,
      kind: 'fill' as const,
      status: 'outcome_unknown' as const,
      outcomeReason: 'runtime_lost' as const,
      durationMs: 10,
    };
    automation.mockResolvedValueOnce({
      kind: 'post-dispatch-unknown',
      capturedRuntimeGeneration: 1,
      receipt: unknownReceipt,
    });
    const unknown = await dispatchWorktreeAction(input, runtime);
    expect(unknown).toMatchObject({
      ok: true,
      result: { ok: true, completed: false, receipt: unknownReceipt },
    });
    expect(unknown.result).not.toHaveProperty('browser');
    // A replayed actionId keeps its retained dialog and replay marker on MCP.
    const retainedDialog = {
      id: 'dialog-1',
      type: 'alert' as const,
      message: 'Saved',
      url: 'https://example.test/',
      openedAt: 1,
    };
    const replayedUnknown = {
      kind: 'post-dispatch-unknown' as const,
      capturedRuntimeGeneration: 1,
      receipt: unknownReceipt,
      repeated: true as const,
      dialog: retainedDialog,
    };
    automation.mockResolvedValueOnce(replayedUnknown);
    const replayed = await dispatchWorktreeAction(input, runtime);
    expect(replayed).toMatchObject({
      ok: true,
      result: {
        ok: true,
        completed: false,
        receipt: unknownReceipt,
        repeated: true,
        dialog: retainedDialog,
      },
    });
    automation.mockResolvedValueOnce({
      ok: true,
      completed: true,
      browser: snapshot,
      receipt: {
        ...unknownReceipt,
        status: 'executed',
        outcomeReason: undefined,
      },
    });
    const executed = await dispatchWorktreeAction(input, runtime);
    expect(executed).toMatchObject({
      ok: true,
      result: {
        browser: snapshot,
        completed: true,
        receipt: { actionId: 'unknown-1', status: 'executed' },
      },
    });
  });

  it('restores the focused chat renderer after browser automation', async () => {
    const snapshot = browserSnapshot();
    const focus = jest.fn();
    const isRendererFocused = jest
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const isWindowFocused = jest.fn(() => true);
    const automation = jest
      .fn()
      .mockResolvedValue({ ok: true, completed: true, browser: snapshot });
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'automation').mockImplementation(automation);
    getBrowserServiceMock.mockReturnValue(browserService);
    const actionWindow = new BrowserWindow();
    jest
      .spyOn(actionWindow.webContents, 'isFocused')
      .mockImplementation(isRendererFocused);
    jest.spyOn(actionWindow.webContents, 'focus').mockImplementation(focus);
    jest.spyOn(actionWindow, 'isFocused').mockImplementation(isWindowFocused);
    const focusedRuntime: WorktreeActionRuntime = {
      ...runtime,
      getWindow: () => actionWindow,
    };

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.fill',
          expectedRuntimeGeneration: 1,
          ref: 'input-1',
          text: 'agent text',
        },
      },
      focusedRuntime,
    );

    expect(result.ok).toBe(true);
    expect(automation).toHaveBeenCalledTimes(1);
    expect(isRendererFocused).toHaveBeenCalledTimes(2);
    expect(isRendererFocused).toHaveNthReturnedWith(1, true);
    expect(isRendererFocused).toHaveNthReturnedWith(2, false);
    expect(isWindowFocused).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not restore chat focus after browser-page user interaction', async () => {
    const snapshot = browserSnapshot();
    const browserService = new BrowserService({ getWindow: (): null => null });
    jest
      .spyOn(browserService, 'loadWorktreeState')
      .mockResolvedValue({ status: 'missing', state: null });
    jest.spyOn(browserService, 'create').mockResolvedValue(snapshot);
    jest
      .spyOn(browserService, 'resolveActiveBrowserId')
      .mockReturnValue('browser-1');
    jest
      .spyOn(browserService, 'listWorktreeBrowsers')
      .mockReturnValue([snapshot]);
    jest.spyOn(browserService, 'automation').mockResolvedValue({
      ok: true,
      completed: true,
      browser: snapshot,
    });
    jest
      .spyOn(browserService, 'getUserInteractionGeneration')
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    getBrowserServiceMock.mockReturnValue(browserService);
    const actionWindow = new BrowserWindow();
    jest
      .spyOn(actionWindow.webContents, 'isFocused')
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const focus = jest.spyOn(actionWindow.webContents, 'focus');

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.fill',
          expectedRuntimeGeneration: 1,
          ref: 'input-1',
          text: 'agent text',
        },
      },
      { ...runtime, getWindow: () => actionWindow },
    );

    expect(result.ok).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.test/page?secret=token#private-fragment',
    'file:///Users/private/local-report.csv',
  ])('phase07 transfer outputs omit snapshot URL %s', async (url) => {
    const snapshot = browserSnapshot({ url });
    const transfer = {
      kind: 'download',
      id: 'download-1',
      browserId: snapshot.id,
      source: 'agent',
      origin: 'https://example.test/export',
      fileName: 'report.csv',
      receivedBytes: 10,
      totalBytes: 20,
      status: 'in_progress',
      startedAt: 1,
    };
    const listTransfers = jest.fn().mockReturnValue({
      transfers: [transfer],
      total: 1,
      offset: 2,
      limit: 50,
    });
    const cancelTransfer = jest.fn().mockResolvedValue({
      ok: true,
      transfer: { ...transfer, status: 'cancelled' },
    });
    const withRuntimeTarget = jest.fn(
      (_target: unknown, operation: () => unknown) => operation(),
    );
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(true),
      resolveActiveBrowserId: jest.fn().mockReturnValue(snapshot.id),
      listWorktreeBrowsers: jest.fn(() => [snapshot]),
      withRuntimeTarget,
      listTransfers,
      cancelTransfer,
    } as unknown as ReturnType<typeof getBrowserService>);
    const list = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.list_transfers',
          expectedRuntimeGeneration: 9,
          kind: 'download',
          status: 'in_progress',
          offset: 2,
          limit: 50,
        },
      },
      runtime,
    );
    expect(list).toMatchObject({
      ok: true,
      result: {
        transfers: [transfer],
        total: 1,
        offset: 2,
        limit: 50,
      },
    });
    expect(listTransfers).toHaveBeenCalledWith({
      browserId: snapshot.id,
      kind: 'download',
      status: 'in_progress',
      offset: 2,
      limit: 50,
    });
    const cancel = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.cancel_transfer',
          browserId: snapshot.id,
          expectedRuntimeGeneration: 9,
          transferId: transfer.id,
        },
      },
      runtime,
    );
    expect(cancel).toMatchObject({
      ok: true,
      result: {
        ok: true,
        transfer: { id: transfer.id, status: 'cancelled' },
      },
    });
    expect(cancelTransfer).toHaveBeenCalledWith({
      browserId: snapshot.id,
      transferId: transfer.id,
    });
    expect(withRuntimeTarget.mock.calls.map(([target]) => target)).toEqual(
      Array(2).fill({ browserId: snapshot.id, expectedRuntimeGeneration: 9 }),
    );
    for (const response of [list, cancel]) {
      expect(response.result).not.toHaveProperty('browser');
      expect(response.result).toHaveProperty('browserId', snapshot.id);
      expect(JSON.stringify(response.result)).not.toMatch(
        /secret|private-fragment|file:\/\/|\/Users\/|[?#]/,
      );
      expect(JSON.stringify(response.result)).not.toMatch(
        /stagingPath|localPath|absolutePath|browser-files\//,
      );
    }
    const foreign = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.cancel_transfer',
          browserId: 'other-browser',
          expectedRuntimeGeneration: 9,
          transferId: transfer.id,
        },
      },
      runtime,
    );
    expect(foreign).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(cancelTransfer).toHaveBeenCalledTimes(1);
    for (const actionType of [
      'browser.list_transfers',
      'browser.cancel_transfer',
    ])
      expect(
        searchBrowserActions({ actionType }).actions.map((entry) => entry.type),
      ).toContain(actionType);
  });

  it('phase07b save_download asks the calling chat for the write and returns the copy', async () => {
    const snapshot = browserSnapshot();
    const copy = {
      kind: 'copy',
      id: 'copy-1',
      browserId: snapshot.id,
      sourceId: 'download-1',
      source: 'agent',
      destinationName: 'exports/report.csv',
      copiedBytes: 10,
      totalBytes: 10,
      status: 'complete',
      startedAt: 2,
      endedAt: 3,
    };
    const saveDownload = jest.fn().mockResolvedValue({
      ok: true,
      transfer: copy,
    });
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(true),
      resolveActiveBrowserId: jest.fn().mockReturnValue(snapshot.id),
      listWorktreeBrowsers: jest.fn(() => [snapshot]),
      withRuntimeTarget: jest.fn((_target: unknown, operation: () => unknown) =>
        operation(),
      ),
      saveDownload,
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.save_download',
          expectedRuntimeGeneration: 9,
          downloadId: 'download-1',
          path: 'exports/report.csv',
          overwrite: true,
          actionId: 'save-1',
          timeoutMs: 5000,
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: { browserId: snapshot.id, ok: true, transfer: copy },
    });
    expect(result.result).not.toHaveProperty('browser');
    expect(saveDownload).toHaveBeenCalledWith(
      {
        browserId: snapshot.id,
        downloadId: 'download-1',
        path: 'exports/report.csv',
        overwrite: true,
        timeoutMs: 5000,
        actionId: 'save-1',
        approvalChat: {
          projectId: runtime.projectId,
          worktreeId: runtime.worktreeId,
          chatId: runtime.chatId,
        },
      },
      runtime.signal ? { signal: runtime.signal } : {},
    );
    expect(
      searchBrowserActions({ actionType: 'browser.save_download' }).actions.map(
        (entry) => entry.type,
      ),
    ).toContain('browser.save_download');
  });

  it('phase07b save_download asks the chat the runtime names for approvals over its target scope', async () => {
    const snapshot = browserSnapshot();
    const saveDownload = jest
      .fn<Promise<{ ok: boolean }>, [unknown, unknown]>()
      .mockResolvedValue({ ok: true });
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(true),
      resolveActiveBrowserId: jest.fn().mockReturnValue(snapshot.id),
      listWorktreeBrowsers: jest.fn(() => [snapshot]),
      withRuntimeTarget: jest.fn((_target: unknown, operation: () => unknown) =>
        operation(),
      ),
      saveDownload,
    } as unknown as ReturnType<typeof getBrowserService>);
    const advisorChat = {
      projectId: 'app-advisor',
      worktreeId: 'advisor-entry',
      chatId: 'advisor-chat',
    };

    await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.save_download',
          expectedRuntimeGeneration: 9,
          downloadId: 'download-1',
          path: 'report.csv',
        },
      },
      { ...runtime, approvalChat: advisorChat },
    );

    expect(saveDownload.mock.calls[0]?.[0]).toMatchObject({
      approvalChat: advisorChat,
    });
  });

  it('includes the affected browser on specialized browser action successes', async () => {
    let snapshot = browserSnapshot();
    const listWorktreeBrowsers = jest.fn(() => [snapshot]);
    const create = jest.fn().mockResolvedValue(snapshot);
    const resolveActiveBrowserId = jest.fn().mockReturnValue('browser-1');
    const screenshot = jest.fn().mockResolvedValue({
      attachmentPath: '/tmp/shot.png',
      dataUrl: 'data:image/png;base64,large',
    });
    const inspect = jest.fn().mockResolvedValue({
      browserId: 'browser-1',
      tagName: 'button',
      accessibleName: undefined,
    });
    const getConsole = jest.fn().mockReturnValue([
      {
        id: 'console-1',
        browserId: 'browser-1',
        timestamp: 1,
        level: 'error',
        text: 'boom',
      },
    ]);
    const getNetwork = jest.fn().mockReturnValue([
      {
        id: 'network-1',
        browserId: 'browser-1',
        requestId: 'request-1',
        timestamp: 1,
        method: 'GET',
        url: 'http://localhost:3000/api',
      },
    ]);
    const stopRecording = jest.fn().mockImplementation(() => {
      snapshot = { ...snapshot, recording: false, updatedAt: 3 };
      return {
        browserId: 'browser-1',
        recording: false,
        steps: [],
        playwrightScript: '',
      };
    });
    const openExternal = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create,
      resolveActiveBrowserId,
      listWorktreeBrowsers,
      screenshot,
      inspect,
      getConsole,
      getNetwork,
      stopRecording,
      openExternal,
    } as unknown as ReturnType<typeof getBrowserService>);

    const cases: Array<{
      action: DispatchWorktreeActionInput['action'];
      expected: Record<string, unknown>;
    }> = [
      {
        action: { type: 'browser.screenshot' },
        expected: { screenshot: { attachmentPath: '/tmp/shot.png' } },
      },
      {
        action: {
          type: 'browser.inspect',
          expectedRuntimeGeneration: 1,
          locator: 'button',
          frame: 'f-checkout-1',
        },
        expected: { element: { browserId: 'browser-1', tagName: 'button' } },
      },
      {
        action: {
          type: 'browser.get_console',
          expectedRuntimeGeneration: 1,
          level: 'error',
        },
        expected: { entries: [expect.objectContaining({ text: 'boom' })] },
      },
      {
        action: { type: 'browser.get_network' },
        expected: {
          entries: [
            expect.objectContaining({ url: 'http://localhost:3000/api' }),
          ],
        },
      },
      {
        action: { type: 'browser.stop_recording' },
        expected: { recording: { browserId: 'browser-1', recording: false } },
      },
      {
        action: { type: 'browser.open_external' },
        expected: { openedUrl: 'http://localhost:3000' },
      },
    ];

    for (const { action, expected } of cases) {
      const result = await dispatchWorktreeAction({ action }, runtime);

      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({
        browser: { id: 'browser-1' },
        ...expected,
      });
      if (action.type === 'browser.screenshot') {
        const screenshotResult = result.result as {
          screenshot?: { dataUrl?: unknown };
        };
        expect(screenshotResult.screenshot?.dataUrl).toBeUndefined();
        expect(result.toolImageDataUrl).toBe('data:image/png;base64,large');
      }
      if (action.type === 'browser.inspect') {
        expect(inspect).toHaveBeenCalledWith(
          expect.objectContaining({ frame: 'f-checkout-1' }),
        );
        const inspectResult = result.result as { element?: unknown };
        expect(inspectResult.element).toEqual(
          JSON.parse(JSON.stringify(inspectResult.element)),
        );
      }
    }
  });

  // The image goes back as image content; repeating it as base64 in the text
  // pushed results past the agent's tool-output limit, so the image was lost.
  it('never repeats an unsaved screenshot as base64 in the result text', async () => {
    const snapshot = browserSnapshot();
    const screenshot = jest
      .fn()
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,large' });
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create: jest.fn().mockResolvedValue(snapshot),
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      listWorktreeBrowsers: jest.fn(() => [snapshot]),
      resolveActiveBrowserId: jest.fn().mockReturnValue('browser-1'),
      screenshot,
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      { action: { type: 'browser.screenshot', saveToAttachments: false } },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.result)).not.toContain('base64');
    expect(result.toolImageDataUrl).toBe('data:image/png;base64,large');
  });

  it('returns filtered and paginated browser input snapshots', async () => {
    const snapshot = browserSnapshot();
    const inputSnapshot = jest.fn().mockResolvedValue({
      browserId: 'browser-1',
      url: snapshot.url,
      title: snapshot.title,
      viewport: { width: 800, height: 600 },
      scroll: { x: 1, y: 2, maxX: 30, maxY: 400 },
      capturedAt: '2026-07-16T00:00:00.000Z',
      filter: { frame: 'f-checkout-1', role: 'textbox', name: 'search' },
      offset: 0,
      limit: 1,
      total: 2,
      returned: 1,
      truncated: true,
      nextOffset: 1,
      inputs: [
        {
          ref: 'input-1',
          tagName: 'input',
          frame: 'f-checkout-1',
          role: 'textbox',
          inputType: 'search',
          name: 'Search domains',
          disabled: false,
          bounds: { x: 0, y: 0, width: 100, height: 30 },
        },
      ],
    });
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create: jest.fn().mockResolvedValue(snapshot),
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      resolveActiveBrowserId: jest.fn().mockReturnValue('browser-1'),
      listWorktreeBrowsers: jest.fn().mockReturnValue([snapshot]),
      inputSnapshot,
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.input_snapshot',
          expectedRuntimeGeneration: 1,
          frame: 'f-checkout-1',
          role: 'textbox',
          name: 'search',
          limit: 1,
        },
      },
      runtime,
    );

    expect(inputSnapshot).toHaveBeenCalledWith({
      browserId: 'browser-1',
      filter: { frame: 'f-checkout-1', role: 'textbox', name: 'search' },
      offset: 0,
      limit: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        inputSnapshot: {
          viewport: { width: 800, height: 600 },
          scroll: { x: 1, y: 2, maxX: 30, maxY: 400 },
          returned: 1,
          truncated: true,
          nextOffset: 1,
          inputs: [{ ref: 'input-1' }],
        },
      },
    });
  });

  it.each([
    ['browser.input_snapshot', 'frame_unavailable'],
    ['browser.inspect', 'target_stale'],
    ['browser.inspect', 'invalid_locator'],
  ] as const)(
    'returns a %s read failure (%s) as an action failure, not a thrown error (E3)',
    async (type, code) => {
      const snapshot = browserSnapshot();
      const message = 'Plain message for the agent.';
      const failure = jest
        .fn()
        .mockRejectedValue(new BrowserReadTargetError(code, message));
      getBrowserServiceMock.mockReturnValue({
        loadWorktreeState: jest.fn().mockResolvedValue(undefined),
        hasLiveBrowser: jest.fn().mockReturnValue(false),
        withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
          operation(),
        create: jest.fn().mockResolvedValue(snapshot),
        waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
        resolveActiveBrowserId: jest.fn().mockReturnValue('browser-1'),
        listWorktreeBrowsers: jest.fn().mockReturnValue([snapshot]),
        inputSnapshot: failure,
        inspect: failure,
      } as unknown as ReturnType<typeof getBrowserService>);
      const result = await dispatchWorktreeAction(
        {
          action:
            type === 'browser.input_snapshot'
              ? { type, frame: 'iframe#missing' }
              : { type, ref: 'r-gone' },
        },
        runtime,
      );
      const invalidLocator = code === 'invalid_locator';
      expect(result).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: invalidLocator ? 'execution_failed' : 'invalid_target',
          message,
          details: {
            error: {
              code: invalidLocator ? 'execution_failed' : code,
              message,
              retryable: false,
              ...(invalidLocator ? {} : { next: 'browser.input_snapshot' }),
            },
          },
        },
      });
    },
  );

  it('still lets other browser read errors through', async () => {
    const snapshot = browserSnapshot();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      create: jest.fn().mockResolvedValue(snapshot),
      waitForInitialLoad: jest.fn().mockResolvedValue(snapshot),
      resolveActiveBrowserId: jest.fn().mockReturnValue('browser-1'),
      listWorktreeBrowsers: jest.fn().mockReturnValue([snapshot]),
      inspect: jest.fn().mockRejectedValue(new Error('Browser is destroyed.')),
    } as unknown as ReturnType<typeof getBrowserService>);
    await expect(
      dispatchWorktreeAction(
        { action: { type: 'browser.inspect', ref: 'r-1' } },
        runtime,
      ),
    ).rejects.toThrow('Browser is destroyed.');
  });

  it('returns browser null for explicit browser.open_external URLs with no browser target', async () => {
    const openExternal = jest.fn().mockResolvedValue(undefined);
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      hasLiveBrowser: jest.fn().mockReturnValue(false),
      withRuntimeTarget: (_target: unknown, operation: () => unknown) =>
        operation(),
      openExternal,
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open_external',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      requestId: '',
      ok: true,
      result: {
        browser: null,
        openedUrl: 'http://localhost:3000',
      },
    });
    expect(openExternal).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('refuses local files for browser.open_external', async () => {
    const openExternal = jest.fn();
    getBrowserServiceMock.mockReturnValue({
      loadWorktreeState: jest.fn().mockResolvedValue(undefined),
      openExternal,
    } as unknown as ReturnType<typeof getBrowserService>);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'browser.open_external',
          url: '/tmp/report.html',
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Enter an http or https URL.',
      },
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'pauses hooks and broadcasts the updated row (all: %s)',
    async (all) => {
      const configuredHooks = all
        ? [
            hookSummary({
              hookKey: 'workspace-root:pr:create',
              target: 'workspace-root',
            }),
            ...['canopy', 'ud-internal-hub'].map((repoId) =>
              hookSummary({
                hookKey: `workspace-repo:${repoId}:pr:create`,
                target: 'workspace-repo',
                repoId,
              }),
            ),
          ]
        : [hookSummary()];
      const expectedKeys = configuredHooks.map((hook) => hook.hookKey).sort();
      const send = jest.fn();
      const window: SendableBrowserWindow = {
        isDestroyed: (): boolean => false,
        webContents: {
          isDestroyed: (): boolean => false,
          isCrashed: (): boolean => false,
          mainFrame: {
            isDestroyed: (): boolean => false,
            detached: false,
          },
          send,
        },
      };
      const runtimeWithWindow: WorktreeActionRuntime = {
        ...runtime,
        getSendableWindow: () => window,
      };
      const persistedWorktree: WorktreeData = {
        id: 'worktree-1',
        branchName: 'feature/hooks',
        createdAt: '2026-07-10T00:00:00.000Z',
      };
      let pausedHookKeys: string[] = [];
      let updatedWorktree: WorktreeData | null = null;
      listHooksMock.mockImplementation(() =>
        Promise.resolve(
          configuredHooks.map((hook) => ({
            ...hook,
            paused: pausedHookKeys.includes(hook.hookKey),
          })),
        ),
      );
      changeWorktreeHookPauseMock.mockImplementation((input) => {
        // The change names the keys; the boundary applies it to the row.
        expect(input).toMatchObject({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          change: { kind: 'pause' },
          source: 'app_advisor',
        });
        if (input.change.kind === 'pause') {
          pausedHookKeys = Array.from(
            new Set<string>([...pausedHookKeys, ...input.change.hookKeys]),
          ).sort();
        }
        updatedWorktree = {
          ...persistedWorktree,
          pausedHookKeys,
        };
        return Promise.resolve({ worktree: updatedWorktree, pausedHookKeys });
      });

      const result = await dispatchWorktreeAction(
        {
          action: {
            type: 'hook.pause',
            ...(all ? { all: true } : { hookKey: 'project:pr:create' }),
          },
        },
        runtimeWithWindow,
      );

      expect(result).toMatchObject({
        ok: true,
        result: {
          pausedHookKeys: expectedKeys,
          hooks: configuredHooks.map((hook) => ({ ...hook, paused: true })),
        },
      });
      expect(updatedWorktree).toMatchObject({
        id: 'worktree-1',
        pausedHookKeys: expectedKeys,
      });
      expect(send).toHaveBeenCalledWith(
        IPC_CHANNELS.workspaceWorktreesUpdated,
        {
          workspaceId: 'project-1',
          worktree: updatedWorktree,
        },
      );
    },
  );

  it('rejects pipeline.run plan paths outside the worktree and executions dir', async () => {
    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'pipe-1',
          runMode: 'plan_ready',
          planPath: '/tmp/private-plan.md',
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          'planPath must be inside the current worktree or pipeline executions directory.',
      },
    });
    expect(startPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a worktree chat', {}, 'agent'],
    // A Portal-opened runtime is still the agent chat (usage attribution aside).
    ['a Portal-opened chat', { pipelineInitiationSource: 'portal' }, 'agent'],
    ['App Advisor', { projectId: APP_ADVISOR_PROJECT_ID }, 'app_advisor'],
  ] as const)(
    'records the chat that started pipeline.run from %s',
    async (_label, overrides, kind) => {
      startPipelineExecutionFromMainMock.mockResolvedValue({
        success: false,
        error: 'stopped after dispatch',
      });
      const chatRuntime: WorktreeActionRuntime = { ...runtime, ...overrides };

      await dispatchWorktreeAction(
        { action: { type: 'pipeline.run', pipelineId: 'pipe-1' } },
        chatRuntime,
      );

      const options: unknown =
        startPipelineExecutionFromMainMock.mock.calls[0]?.[0].options;
      expect(options).toMatchObject({
        initiator: {
          kind,
          chat: {
            projectId: chatRuntime.projectId,
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          },
        },
      });
    },
  );

  it('resolves allowed pipeline.run event paths before dispatching', async () => {
    loadExecutionStateMock.mockResolvedValue(executionState());
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: false,
      error: 'stopped after dispatch',
    });

    await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'pipe-1',
          runMode: 'task_ready',
          taskPath: 'tasks/task.md',
          planPath: '/tmp/canopy-executions/exec-1/plan.md',
        },
      },
      runtime,
    );

    const expectedOptions: unknown = expect.objectContaining({
      initiationSource: 'app_advisor',
      initiator: {
        kind: 'agent',
        chat: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      },
      eventData: {
        task_ready: {
          task_path: path.resolve('/tmp/worktree/tasks/task.md'),
          plan_path: '/tmp/canopy-executions/exec-1/plan.md',
        },
      },
    });
    expect(startPipelineExecutionFromMainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expectedOptions,
      }),
    );
  });

  it('emits a pipeline-run receipt only after execution creation succeeds', async () => {
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: executionState({
        status: 'running',
        completed_at: undefined,
        event_name: 'dispatch',
      }),
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'pipe-1',
          runMode: 'dispatch',
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        execution: { id: 'exec-1', status: 'running' },
        agentArtifacts: [
          {
            kind: 'pipeline_run',
            operation: 'pipeline.run',
            executionId: 'exec-1',
            pipelineId: 'pipe-1',
            pipelineName: 'Test pipeline',
            initialStatus: 'running',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
        ],
      },
    });
  });

  it('runs a shared Cloud pipeline through the generic pipeline action', async () => {
    getPipelineMock.mockReturnValue({
      success: false,
      error: 'Pipeline not found',
    });
    getSharedPipelineMock.mockResolvedValue(sharedPipelineData());
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: executionState({
        pipeline_id: 'shared:canopy-cloud:shared-pipeline',
        status: 'running',
        completed_at: undefined,
        event_name: 'dispatch',
      }),
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'shared:canopy-cloud:shared-pipeline',
          runMode: 'dispatch',
        },
      },
      runtime,
    );

    expect(assertCanopyCloudCapabilityMock).toHaveBeenCalledWith(
      'pipelines-crud-v1',
    );
    expect(getSharedPipelineMock).toHaveBeenCalledWith('shared-pipeline');
    const sharedStart = startPipelineExecutionFromMainMock.mock.calls[0]?.[0];
    expect(sharedStart?.pipeline.name).toBe('Shared pipeline');
    expect(sharedStart?.options.pipelineId).toBe(
      'shared:canopy-cloud:shared-pipeline',
    );
    expect(sharedStart?.options.sharedPipeline).toEqual({
      serverId: 'canopy-cloud',
      remoteId: 'shared-pipeline',
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        agentArtifacts: [
          expect.objectContaining({
            kind: 'pipeline_run',
            pipelineId: 'shared:canopy-cloud:shared-pipeline',
          }),
        ],
      },
    });
  });

  it('rejects undeclared run modes for shared Cloud pipelines', async () => {
    getPipelineMock.mockReturnValue({
      success: false,
      error: 'Pipeline not found',
    });
    const sharedPipeline = sharedPipelineData();
    sharedPipeline.triggerTypes = ['plan_ready'];
    sharedPipeline.rawPipeline =
      'name: Shared pipeline\nscope: directory\non:\n  plan_ready: {}\njobs: {}\n';
    getSharedPipelineMock.mockResolvedValue(sharedPipeline);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'shared:canopy-cloud:shared-pipeline',
          runMode: 'dispatch',
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_target',
        message:
          'Pipeline shared:canopy-cloud:shared-pipeline does not declare the dispatch run mode.',
      },
    });
    expect(startPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it('rejects pipeline.run event paths from another worktree execution', async () => {
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        id: 'other-exec',
        project_id: 'other-project',
        worktree_id: 'other-worktree',
      }),
    );

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'pipe-1',
          runMode: 'task_ready',
          taskPath: '/tmp/canopy-executions/other-exec/task.md',
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          'taskPath must be inside the current worktree or pipeline executions directory.',
      },
    });
    expect(startPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it('does not include unsafe persisted plan content in execution_get', async () => {
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        event_data: {
          plan_ready: {
            plan_path: '/tmp/private-plan.md',
          },
        },
      }) as Awaited<ReturnType<typeof loadExecutionState>>,
    );

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_get',
          executionId: 'exec-1',
          includePlan: true,
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      plan: null,
    });
  });

  it('describes pending input requests and resumes with supplied answers', async () => {
    const pausedState = executionState({
      status: 'paused',
      completed_at: undefined,
      pending_pauses: [
        {
          id: 'checkpoint-1',
          kind: 'input',
          job_id: 'review',
          logical_job_id: 'review',
          step_id: 'approval',
          attempt: 0,
          iteration: 1,
          detected_at: '2026-05-26T00:00:30.000Z',
          request: {
            title: 'Approval required',
            message: 'Choose a reviewer.',
            fields: [
              {
                key: 'reviewer',
                label: 'Reviewer',
                type: 'string',
                required: true,
              },
            ],
          },
        },
      ],
      status_reasons: [
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          kind: 'input_required',
          code: 'input_requested',
          detected_at: '2026-05-26T00:00:30.000Z',
          source: {
            job_id: 'review',
            step_id: 'approval',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
    });
    loadExecutionStateMock.mockResolvedValue(pausedState);

    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'pipeline.execution_resume',
          executionId: pausedState.id,
        },
      }).success,
    ).toBe(false);
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'pipeline.execution_resume',
          executionId: pausedState.id,
          pauseResponses: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'review',
              stepId: 'approval',
              answers: { reviewer: 'Ada' },
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'pipeline.execution_resume',
          executionId: pausedState.id,
          pauseResponses: [
            {
              jobId: 'review',
              stepId: 'approval',
              answers: { reviewer: 'Ada' },
            },
          ],
        },
      }).success,
    ).toBe(false);

    const inspected = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_get',
          executionId: pausedState.id,
        },
      },
      runtime,
    );
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        execution: {
          status: 'paused',
          inputRequested: true,
          inputRequests: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'review',
              stepId: 'approval',
              request: {
                title: 'Approval required',
                message: 'Choose a reviewer.',
              },
            },
          ],
        },
      },
    });

    const resumed = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_resume',
          executionId: pausedState.id,
          pauseResponses: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'review',
              stepId: 'approval',
              answers: { reviewer: 'Ada' },
            },
          ],
        },
      },
      runtime,
    );

    expect(resumePipelineExecutionFromMainMock).toHaveBeenCalledWith({
      executionId: pausedState.id,
      pauseResponses: [
        {
          checkpoint_id: 'checkpoint-1',
          job_id: 'review',
          step_id: 'approval',
          answers: { reviewer: 'Ada' },
        },
      ],
      initiationSource: 'automation',
      persistInitiationSource: true,
      getWindow: runtime.getWindow,
    });
    expect(resumed).toMatchObject({
      ok: true,
      result: { execution: { status: 'running' } },
    });
  });

  it('returns null for missing persisted report and plan artifacts', async () => {
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        report_outputs: {
          report_file: '/tmp/canopy-executions/exec-1/missing-report.md',
        },
        event_data: {
          plan_ready: {
            plan_path: '/tmp/worktree/missing-plan.md',
          },
        },
      }) as Awaited<ReturnType<typeof loadExecutionState>>,
    );

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_get',
          executionId: 'exec-1',
          includeReport: true,
          includePlan: true,
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      report: null,
      plan: null,
    });
  });

  it('cancels stored paused executions through the main pipeline event path', async () => {
    const pausedState = executionState({ status: 'paused' });
    const cancelledState = executionState({
      status: 'cancelled',
      completed_at: '2026-05-26T00:02:00.000Z',
    });
    loadExecutionStateMock.mockResolvedValue(pausedState);
    cancelPipelineExecutionFromMainMock.mockResolvedValue(cancelledState);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_cancel',
          executionId: pausedState.id,
        },
      },
      runtime,
    );

    expect(cancelPipelineExecutionFromMainMock).toHaveBeenCalledWith({
      executionId: pausedState.id,
      getWindow: runtime.getWindow,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        execution: {
          id: cancelledState.id,
          status: 'cancelled',
        },
      },
    });
  });

  it('retries failed executions through the main pipeline event path', async () => {
    const failedState = executionState({ status: 'failure' });
    const retryingState = executionState({
      status: 'running',
      completed_at: undefined,
    });
    loadExecutionStateMock.mockResolvedValue(failedState);
    retryPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: retryingState,
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_retry',
          executionId: failedState.id,
        },
      },
      runtime,
    );

    expect(retryPipelineExecutionFromMainMock).toHaveBeenCalledWith({
      executionId: failedState.id,
      getWindow: runtime.getWindow,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        execution: {
          id: retryingState.id,
          status: 'running',
        },
        agentArtifacts: [
          expect.objectContaining({
            kind: 'pipeline_run',
            operation: 'pipeline.execution_retry',
            executionId: retryingState.id,
          }),
        ],
      },
    });
  });

  it('retries matrix variants through the main pipeline event path', async () => {
    const failedState = executionState({ status: 'failure' });
    const retryingState = executionState({
      status: 'running',
      completed_at: undefined,
    });
    loadExecutionStateMock.mockResolvedValue(failedState);
    retryMatrixJobFromMainMock.mockResolvedValue(retryingState);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_retry_matrix_job',
          executionId: failedState.id,
          jobId: 'review',
          mode: 'failed',
        },
      },
      runtime,
    );

    expect(retryMatrixJobFromMainMock).toHaveBeenCalledWith({
      request: {
        executionId: failedState.id,
        jobId: 'review',
        mode: 'failed',
      },
      getWindow: runtime.getWindow,
    });
    expect(result).toMatchObject({
      ok: true,
      result: { execution: { status: 'running' } },
    });
  });

  it('cancels a matrix variant through the main pipeline event path', async () => {
    const runningState = executionState({ status: 'running' });
    const updatedState = executionState({ status: 'running' });
    loadExecutionStateMock.mockResolvedValue(runningState);
    cancelMatrixVariantFromMainMock.mockResolvedValue(updatedState);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_cancel_matrix_variant',
          executionId: runningState.id,
          jobId: 'review',
          variantJobId: '__matrix__review__0',
        },
      },
      runtime,
    );

    expect(cancelMatrixVariantFromMainMock).toHaveBeenCalledWith({
      request: {
        executionId: runningState.id,
        jobId: 'review',
        variantJobId: '__matrix__review__0',
      },
      getWindow: runtime.getWindow,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects retries for executions outside the current worktree', async () => {
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        status: 'failure',
        worktree_id: 'worktree-2',
      }),
    );

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_retry',
          executionId: 'exec-1',
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'That pipeline execution does not belong to this worktree.',
      },
    });
    expect(retryPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it('rejects execution_chain when the source plan path is unsafe', async () => {
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        event_data: {
          plan_ready: {
            plan_path: '/tmp/private-plan.md',
          },
        },
      }) as Awaited<ReturnType<typeof loadExecutionState>>,
    );

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_chain',
          executionId: 'exec-1',
          pipelineId: 'pipe-1',
        },
      },
      runtime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'not_found',
        message:
          'This pipeline execution does not have a safe saved plan file.',
      },
    });
    expect(startPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it('chains Cowork pipeline executions with an explicit directory target', async () => {
    const coworkRuntime: WorktreeActionRuntime = {
      ...runtime,
      cwd: '/tmp/cowork',
      executionScope: 'directory',
    };
    getPipelineMock.mockReturnValue({
      success: true,
      data: {
        ...pipelineData(),
        info: {
          ...pipelineData().info,
          scopes: ['directory'],
        },
        content: {
          ...pipelineData().content,
          scope: 'directory',
        },
      },
    });
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        cwd: '/tmp/cowork',
        worktree_id: 'directory',
        event_data: {
          plan_ready: { plan_path: '/tmp/cowork/plan.md' },
        },
      }),
    );
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: executionState({
        cwd: '/tmp/cowork',
        worktree_id: 'directory',
        status: 'running',
        completed_at: undefined,
      }),
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_chain',
          executionId: 'exec-1',
          pipelineId: 'pipe-1',
        },
      },
      coworkRuntime,
    );

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      result: {
        agentArtifacts: [
          expect.objectContaining({
            kind: 'pipeline_run',
            operation: 'pipeline.execution_chain',
          }),
        ],
      },
    });
    const chainedStart = startPipelineExecutionFromMainMock.mock.calls[0]?.[0];
    expect(chainedStart?.options).toMatchObject({
      cwd: '/tmp/cowork',
      scope: 'directory',
      target: { scope: 'directory', path: '/tmp/cowork' },
    });
  });

  it('preserves shared pipeline provenance when chaining executions', async () => {
    getPipelineMock.mockReturnValue({
      success: false,
      error: 'Pipeline not found',
    });
    getSharedPipelineMock.mockResolvedValue(sharedPipelineData());
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        event_data: { plan_ready: { plan_path: '/tmp/worktree/plan.md' } },
      }),
    );
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: executionState({ status: 'running', completed_at: undefined }),
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_chain',
          executionId: 'exec-1',
          pipelineId: 'shared:canopy-cloud:shared-pipeline',
        },
      },
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(
      startPipelineExecutionFromMainMock.mock.calls[0]?.[0].options
        .sharedPipeline,
    ).toEqual({ serverId: 'canopy-cloud', remoteId: 'shared-pipeline' });
  });

  it('rejects worktree-only chain targets in Cowork', async () => {
    getPipelineMock.mockReturnValue({
      success: true,
      data: {
        ...pipelineData(),
        info: {
          ...pipelineData().info,
          scopes: ['worktree'],
        },
        content: {
          ...pipelineData().content,
          scope: 'worktree',
        },
      },
    });
    loadExecutionStateMock.mockResolvedValue(
      executionState({
        cwd: '/tmp/cowork',
        event_data: {
          plan_ready: { plan_path: '/tmp/cowork/plan.md' },
        },
      }),
    );

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_chain',
          executionId: 'exec-1',
          pipelineId: 'pipe-1',
        },
      },
      { ...runtime, cwd: '/tmp/cowork', executionScope: 'directory' },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(startPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });
});

describe('worktree script action contracts', () => {
  const SCRIPT_ACTION_TYPES = ['worktree.list_scripts', 'worktree.run_script'];
  const scriptRuntime: WorktreeActionRuntime = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    cwd: '/tmp/worktree',
    getWindow: () => null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(curatedCatalog.listManagedCuratedPipelines)
      .mockResolvedValue([]);
    assertCanopyCloudCapabilityMock.mockResolvedValue();
    jest
      .mocked(pipelineStore.listPipelines)
      .mockReturnValue({ success: true, data: [] });
    listSharedPipelinesMock.mockResolvedValue({ data: [], nextCursor: null });
    readPreferencesFileMock.mockResolvedValue(DEFAULT_PREFERENCES);
    getBrowserServiceMock.mockReturnValue(null);
  });

  it.each([
    ['run script', 'worktree.run_script'],
    ['run the tests', 'worktree.run_script'],
    ['rerun setup script', 'worktree.run_script'],
    ['start the dev server launch script', 'worktree.run_script'],
    ['list scripts', 'worktree.list_scripts'],
    ['which scripts are configured', 'worktree.list_scripts'],
  ])('finds "%s" through SearchActions', (query, expected) => {
    const result = searchWorktreeActions({ query });
    expect(result.actions.slice(0, 3).map((action) => action.type)).toContain(
      expected,
    );
  });

  it('describes script actions without the server-supplied scope', () => {
    const [runAction] = searchWorktreeActions({
      actionType: 'worktree.run_script',
    }).actions;
    expect(runAction).toMatchObject({
      type: 'worktree.run_script',
      category: 'worktree',
      requiredFields: ['scriptId'],
      optionalFields: ['repo', 'waitSeconds'],
    });
    expect(runAction?.fields.map((field) => field.name)).toEqual([
      'scriptId',
      'repo',
      'waitSeconds',
    ]);
    const [listAction] = searchWorktreeActions({
      actionType: 'worktree.list_scripts',
    }).actions;
    expect(listAction).toMatchObject({
      type: 'worktree.list_scripts',
      requiredFields: [],
      optionalFields: [],
    });
  });

  it('keeps script actions out of the Cowork catalog', () => {
    for (const actionType of SCRIPT_ACTION_TYPES) {
      expect(
        searchWorktreeActions({ actionType }, { executionScope: 'directory' })
          .actions,
      ).toEqual([]);
    }
    expect(
      searchWorktreeActions(
        { query: 'run script' },
        { executionScope: 'directory' },
      ).actions.map((action) => action.type),
    ).not.toEqual(expect.arrayContaining(['worktree.run_script']));
  });

  it.each(['browser.set_checked', 'browser.select_option', 'browser.type'])(
    'advertises %s through SearchActions',
    (actionType) => {
      expect(
        searchBrowserActions({ actionType }).actions.map(
          (action) => action.type,
        ),
      ).toContain(actionType);
    },
  );

  it('validates script payloads and strips caller-supplied scope', () => {
    expect(
      dispatchActionSchema.parse({
        action: {
          type: 'worktree.list_scripts',
          projectId: 'untrusted-project',
          worktreeId: 'untrusted-worktree',
        },
      }),
    ).toEqual({ action: { type: 'worktree.list_scripts' } });
    expect(
      dispatchActionSchema.parse({
        action: {
          type: 'worktree.run_script',
          scriptId: 'test',
          repo: 'api',
          waitSeconds: 600,
          worktreeId: 'untrusted-worktree',
        },
      }),
    ).toEqual({
      action: {
        type: 'worktree.run_script',
        scriptId: 'test',
        repo: 'api',
        waitSeconds: 600,
      },
    });
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'worktree.run_script',
          scriptId: 'test',
          waitSeconds: 0,
        },
      }).success,
    ).toBe(true);
    for (const action of [
      { type: 'worktree.run_script' },
      { type: 'worktree.run_script', scriptId: '' },
      { type: 'worktree.run_script', scriptId: 'test', waitSeconds: 601 },
      { type: 'worktree.run_script', scriptId: 'test', waitSeconds: -1 },
      { type: 'worktree.run_script', scriptId: 'test', waitSeconds: 1.5 },
      { type: 'worktree.run_script', scriptId: 'test', waitSeconds: '10' },
    ]) {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(false);
    }
    const advertised = JSON.stringify(dispatchActionJsonSchema);
    for (const token of [
      '"worktree.list_scripts"',
      '"worktree.run_script"',
      '"scriptId"',
      '"waitSeconds"',
    ]) {
      expect(advertised).toContain(token);
    }
  });

  it('limits SearchActions to allowedActionTypes', () => {
    const options = { allowedActionTypes: SCRIPT_ACTION_TYPES };

    const everything = searchWorktreeActions({ limit: 50 }, options);
    expect(everything.actions.map((action) => action.type).sort()).toEqual(
      SCRIPT_ACTION_TYPES,
    );
    expect(everything.categories).toEqual(['worktree']);

    const pipelineQuery = searchWorktreeActions(
      { query: 'run pipeline' },
      options,
    );
    expect(
      pipelineQuery.actions.every((action) =>
        SCRIPT_ACTION_TYPES.includes(action.type),
      ),
    ).toBe(true);
    expect(pipelineQuery.actions.map((action) => action.type)).toContain(
      'worktree.run_script',
    );
    expect(
      searchWorktreeActions({ actionType: 'pipeline.run' }, options).actions,
    ).toEqual([]);
    expect(
      searchWorktreeActions({ actionType: 'worktree.run_script' }, options)
        .actions,
    ).toHaveLength(1);
  });

  it('rejects dispatches outside allowedActionTypes before any handler runs', async () => {
    const restricted: WorktreeActionRuntime = {
      ...scriptRuntime,
      allowedActionTypes: SCRIPT_ACTION_TYPES,
    };

    const rejected = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list' } },
      restricted,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(rejected.error?.message).toBe(
      'pipeline.list is not available here. Available actions: worktree.list_scripts, worktree.run_script.',
    );
    expect(pipelineStore.listPipelines).not.toHaveBeenCalled();

    for (const result of [
      await dispatchWorktreeAction(
        { action: { type: 'browser.list' } },
        restricted,
      ),
      await dispatchScopedBrowserAction(
        { action: { type: 'browser.list' } },
        restricted,
      ),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'unsupported_action' },
      });
    }
    expect(getBrowserServiceMock).not.toHaveBeenCalled();

    const allowed = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list' } },
      { ...scriptRuntime, allowedActionTypes: ['pipeline.list'] },
    );
    expect(allowed.ok).toBe(true);
    expect(pipelineStore.listPipelines).toHaveBeenCalled();
  });
});

describe('searchWorktreeActions ranking characterization', () => {
  type SearchInput = NonNullable<Parameters<typeof searchWorktreeActions>[0]>;
  type SearchOptions = NonNullable<Parameters<typeof searchWorktreeActions>[1]>;

  const describeResult = (
    input: SearchInput,
    options: SearchOptions,
  ): object => {
    const result = searchWorktreeActions(input, options);
    return {
      query: result.query,
      category: result.category,
      actionType: result.actionType,
      totalMatches: result.totalMatches,
      returned: result.returned,
      categories: result.categories.join(','),
      actions: result.actions.map((action) =>
        [
          action.type,
          `[${action.category}]`,
          `fields=${action.fields.map((field) => field.name).join(',')}`,
          `req=${action.requiredFields.join(',')}`,
          `opt=${action.optionalFields.join(',')}`,
          `example=${Object.keys(action.example).join(',')}`,
          `notes=${action.notes?.length ?? 0}`,
        ].join(' '),
      ),
    };
  };

  const worktree: SearchOptions = { executionScope: 'worktree' };
  const directory: SearchOptions = { executionScope: 'directory' };
  const restricted: SearchOptions = {
    allowedActionTypes: [
      'pipeline.run',
      'pipeline.list',
      'worktree.run_script',
      'hook.pause',
      'browser.open',
    ],
  };

  const cases: Array<[string, SearchInput, SearchOptions]> = [
    ['worktree empty input', {}, worktree],
    ['directory empty input', {}, directory],
    ['worktree pipeline query', { query: 'run pipeline' }, worktree],
    ['directory pipeline query', { query: 'run pipeline' }, directory],
    ['worktree hook query', { query: 'pause hook' }, worktree],
    ['directory hook query', { query: 'pause hook' }, directory],
    ['worktree browser query', { query: 'open browser page' }, worktree],
    ['worktree skills query', { query: 'create skill' }, worktree],
    ['worktree sidebar group query', { query: 'group sidebar item' }, worktree],
    [
      'directory sidebar group query',
      { query: 'group sidebar item' },
      directory,
    ],
    ['worktree automation query', { query: 'schedule recurring' }, worktree],
    ['worktree settings query', { query: 'base branch settings' }, worktree],
    ['worktree plan query', { query: 'import tracked plan' }, worktree],
    ['worktree share query', { query: 'share pipeline' }, worktree],
    ['worktree unmatched query', { query: 'zzzz qqqq' }, worktree],
    ['worktree category', { category: 'pipeline' }, worktree],
    ['worktree category alias', { category: 'automation' }, worktree],
    ['directory worktree-only category', { category: 'hook' }, directory],
    ['worktree exact type', { actionType: 'worktree.get_settings' }, worktree],
    [
      'directory worktree-only type',
      { actionType: 'worktree.get_settings' },
      directory,
    ],
    ['worktree unsupported type', { actionType: 'workspace.list' }, worktree],
    ['worktree partial type', { actionType: 'pipeline' }, worktree],
    ['worktree small limit', { query: 'pipeline', limit: 3 }, worktree],
    ['worktree large limit', { limit: 500 }, worktree],
    ['restricted empty input', { limit: 50 }, restricted],
    ['restricted query', { query: 'run' }, restricted],
    ['restricted category', { category: 'browser' }, restricted],
    ['restricted excluded type', { actionType: 'pipeline.get' }, restricted],
    [
      'restricted directory query',
      { query: 'run' },
      { ...restricted, executionScope: 'directory' },
    ],
    ['empty restriction', { query: 'pipeline' }, { allowedActionTypes: [] }],
  ];

  it.each(cases)('ranks %s', (_name, input, options) => {
    expect(describeResult(input, options)).toMatchSnapshot();
  });

  it.each([
    ['worktree.get_settings', worktree],
    ['sidebar.item_groups.set_item', worktree],
    ['sidebar.item_groups.set_item', directory],
    ['pipeline.run', directory],
    ['hook.pause', worktree],
  ] as const)('scopes the %s catalog entry for %o', (actionType, options) => {
    const result = searchWorktreeActions(
      { actionType, query: 'pr review' },
      options,
    );
    expect(result.actions).toHaveLength(1);
    const [action] = result.actions;
    expect(Object.keys(action ?? {})).toMatchSnapshot();
    expect(action).toMatchSnapshot();
  });
});
