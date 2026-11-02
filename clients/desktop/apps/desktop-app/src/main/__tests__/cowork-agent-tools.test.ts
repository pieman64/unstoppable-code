// Cowork (directory-scoped) agent tooling: per-surface action catalog
// filtering, worktree-only action rejection, directory-scoped pipeline
// listing/dispatch, the cowork base-branch-env no-op, and Claude/Codex tool
// surface parity with the `native-sdk-standalone` allowlist.

import {
  dispatchWorktreeAction,
  searchWorktreeActions,
  type WorktreeActionRuntime,
} from '../canopy-tools/worktree-actions';
import * as pipelineStore from '../pipelines/pipeline-service';
import {
  retryPipelineExecutionFromMain,
  startPipelineExecutionFromMain,
} from '../pipelines/pipeline-handlers';
import {
  listExecutionSummaries,
  loadExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import { buildPipelineBaseBranchEnv } from '../pipelines/worktree-base-branch-env';
import { resolveEffectiveBaseBranchesForWorktree } from '../lib/worktree-base-branches';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  buildCanopyDynamicToolSpecs,
  immediateTurnRestartCodexToolName,
} from '../codex/canopy-dynamic-tools';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  isLedgerInjectedToolKey,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type {
  PipelineData,
  ExecutionState,
  PipelineExecutionScope,
} from '@canopy/desktop-shared/types/pipeline';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { pinOrgProjectsFlagOff } from './helpers/org-projects-flag';
import {
  createAgentActionSurface,
  createBrowserActionFamily,
  createInMemoryAgentActionReceipts,
  createPipelinesActionFamily,
  type AgentPipelineRunResult,
  type PipelineRunAction,
} from '@canopy/agent-actions';
import { desktopCapabilities } from '../agent-actions/desktop-capabilities';
import { desktopPipelinesPort } from '../agent-actions/desktop-pipelines-port';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
});

jest.mock(
  '../canopy-runtime/pipeline-definition-dispatch',
  (): object =>
    jest.requireActual<{ pipelineWriteDispatchFake: object }>(
      './helpers/pipeline-write-dispatch-fake',
    ).pipelineWriteDispatchFake,
);
jest.mock('../pipelines/pipeline-service', () => ({
  getPipeline: jest.fn(),
  listPipelines: jest.fn(),
  savePipeline: jest.fn(),
  updatePipeline: jest.fn(),
}));

jest.mock('../pipelines/project-pipeline-discovery', () => ({
  discoverProjectPipelines: jest.fn().mockResolvedValue([]),
  loadProjectPipelineFromDisk: jest.fn(),
}));

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn().mockResolvedValue([]),
    loadExecutionState: jest.fn(),
  }),
);

jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/tmp/canopy-executions',
  })),
}));

jest.mock('../pipelines/pipeline-handlers', () => ({
  retryPipelineExecutionFromMain: jest.fn(),
  startPipelineExecutionFromMain: jest.fn(),
}));

// Importing worktree-actions loads pipeline-install-context, which reaches
// canopy-tools/core -> desktop-surface -> desktop-host -> desktop-pipelines-port
// -> desktop-legacy-family -> worktree-actions. The legacy family constructs a
// Set from DESKTOP_LEGACY_ACTION_TYPES during module initialization, while
// worktree-actions is still evaluating; SWC's live export getter therefore
// throws before the constant initializes. This is a live-binding cycle, not a
// requireActual spread in this test mock, so descriptor-safe copying cannot
// fix it. Stub only the unrelated legacy family: the suite tests worktree
// search/dispatch and pipeline.run actions without watchers, so neither the
// family nor inlineWatcherSetupJson is exercised.
jest.mock('../agent-actions/desktop-legacy-family', () => ({
  desktopLegacyActionFamily: {},
  inlineWatcherSetupJson: (): undefined => undefined,
}));

jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(() => null),
}));

jest.mock('../lib/plan-import', () => ({
  importedPlanResult: jest.fn(),
  importTrackedPlanFromPath: jest.fn(),
}));

jest.mock('../services/hooks-service', () => ({
  listHooks: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  updateWorkspaceWorktree: jest.fn(),
  readWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => false),
  isMultiRepoWorkspace: jest.fn(() => false),
  getWorkspaceType: jest.fn(() => null),
  getWorkspaceExternalPath: jest.fn(() => null),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchesForWorktree: jest.fn(),
}));

const getPipelineMock = jest.mocked(pipelineStore.getPipeline);
const listPipelinesMock = jest.mocked(pipelineStore.listPipelines);
const savePipelineMock = jest.mocked(pipelineStore.savePipeline);
const updatePipelineMock = jest.mocked(pipelineStore.updatePipeline);
const startPipelineExecutionFromMainMock = jest.mocked(
  startPipelineExecutionFromMain,
);
const retryPipelineExecutionFromMainMock = jest.mocked(
  retryPipelineExecutionFromMain,
);
const listExecutionSummariesMock = jest.mocked(listExecutionSummaries);
const loadExecutionStateMock = jest.mocked(loadExecutionState);
const isCoworkWorkspaceMock = jest.mocked(isCoworkWorkspace);
const resolveEffectiveBaseBranchesMock = jest.mocked(
  resolveEffectiveBaseBranchesForWorktree,
);

function pipelineData(scopes?: PipelineExecutionScope[]): PipelineData {
  return {
    info: {
      id: 'pipe-1',
      name: 'Test pipeline',
      description: '',
      icon: 'build',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      filename: 'test.yml',
      source: 'user',
      readonly: false,
      ...(scopes !== undefined ? { scopes } : {}),
    },
    content: {
      name: 'Test pipeline',
      on: { dispatch: {} },
      jobs: {},
    },
  };
}

const coworkRuntime: WorktreeActionRuntime = {
  projectId: 'cowork-ws-1',
  worktreeId: 'home',
  chatId: 'cowork-chat',
  cwd: '/tmp/cowork-home',
  executionScope: 'directory',
  getWindow: () => null,
};

const legacyCoworkRuntime: WorktreeActionRuntime = {
  projectId: STANDALONE_CHAT_PROJECT_ID,
  worktreeId: 'legacy-ws-1',
  chatId: 'legacy-chat',
  cwd: '/tmp/legacy-cowork-home',
  executionScope: 'directory',
  getWindow: () => null,
};

const worktreeRuntime: WorktreeActionRuntime = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  cwd: '/tmp/worktree',
  getWindow: () => null,
};

beforeEach(() => {
  jest.clearAllMocks();
  getPipelineMock.mockReturnValue({ success: true, data: pipelineData() });
  listPipelinesMock.mockReturnValue({ success: true, data: [] });
  savePipelineMock.mockReturnValue({
    success: true,
    data: pipelineData(['directory']).info,
  });
  updatePipelineMock.mockReturnValue({
    success: true,
    data: pipelineData(['directory']).info,
  });
  listExecutionSummariesMock.mockResolvedValue([]);
});

describe('per-surface action catalog', () => {
  it('hides worktree-only actions and categories from directory-scoped catalogs', async () => {
    const hookResult = searchWorktreeActions(
      { query: 'pause hook', category: 'hook' },
      { executionScope: 'directory' },
    );
    expect(hookResult.actions).toEqual([]);
    expect(hookResult.categories).toEqual([
      'sidebar',
      'skills',
      'sharing',
      'pipeline',
      'browser',
      'automations',
    ]);

    const planResult = searchWorktreeActions(
      { query: 'import plan file path', category: 'tracked-plan' },
      { executionScope: 'directory' },
    );
    expect(planResult.actions).toEqual([]);

    // pipeline.run is a shared family, so Cowork finds it through the agent
    // action surface rather than the legacy catalog.
    const pipelineResult = await createAgentActionSurface<null>({
      brand: { displayName: 'TestBrand', toolNamespace: 'testbrand' },
      capabilities: desktopCapabilities({ executionScope: 'directory' }),
      families: [
        createPipelinesActionFamily<null>({
          port: { run: () => Promise.reject(new Error('unused')) },
          receipts: createInMemoryAgentActionReceipts<null>(),
        }),
      ],
    }).execute(
      'search_actions',
      { query: 'run pipeline', category: 'pipeline' },
      {
        host: null,
        scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' },
        actorKey: 'a',
        turnKey: 'turn',
        toolUseId: 'tool',
      },
    );
    expect(pipelineResult.text).toContain('"pipeline.run"');

    // Browser actions are a shared family, so Cowork finds them through the
    // agent action surface rather than the legacy catalog.
    const browserResult = await createAgentActionSurface<null>({
      brand: { displayName: 'TestBrand', toolNamespace: 'testbrand' },
      capabilities: desktopCapabilities({ executionScope: 'directory' }),
      families: [
        createBrowserActionFamily<null>({
          port: { dispatch: () => Promise.reject(new Error('unused')) },
        }),
      ],
    }).execute(
      'search_actions',
      { query: 'browser screenshot', category: 'browser' },
      {
        host: null,
        scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' },
        actorKey: 'a',
        turnKey: 'turn',
        toolUseId: 'tool',
      },
    );
    expect(browserResult.text).toContain('"browser.screenshot"');
  });

  it('keeps worktree-only actions on the worktree catalog', () => {
    const result = searchWorktreeActions(
      { query: 'import plan file path', category: 'tracked-plan' },
      { executionScope: 'worktree' },
    );
    const types = result.actions.map((action) => action.type);
    expect(types).toContain('tracked-plan.import');
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
  });

  it.each(['directory', 'worktree'] as const)(
    'offers the share dialog action on %s catalogs',
    (executionScope) => {
      const result = searchWorktreeActions(
        { category: 'sharing' },
        { executionScope },
      );
      expect(result.actions.map((action) => action.type)).toEqual([
        'sharing.open_dialog',
      ]);
    },
  );

  it('offers cowork agents the same pipeline action set as worktree agents', () => {
    const coworkActions = searchWorktreeActions(
      { category: 'pipeline', limit: 50 },
      { executionScope: 'directory' },
    ).actions.map((action) => action.type);
    const worktreeActions = searchWorktreeActions(
      { category: 'pipeline', limit: 50 },
      { executionScope: 'worktree' },
    ).actions.map((action) => action.type);

    expect(coworkActions).toEqual(worktreeActions);
    expect(coworkActions).toContain('pipeline.execution_retry');
  });

  it('returns no matches for a worktree-only actionType on the directory surface', () => {
    const result = searchWorktreeActions(
      { actionType: 'hook.pause' },
      { executionScope: 'directory' },
    );
    expect(result.totalMatches).toBe(0);
    expect(result.actions).toEqual([]);
  });

  it('does not expose worktree hook settings on the directory surface', () => {
    const result = searchWorktreeActions(
      { actionType: 'worktree.get_settings' },
      { executionScope: 'directory' },
    );
    expect(result.totalMatches).toBe(0);
    expect(result.actions).toEqual([]);
  });
});

/** Starts pipeline.run through the desktop pipelines port. */
function runPipeline(
  action: PipelineRunAction,
  runtime: WorktreeActionRuntime,
): Promise<AgentPipelineRunResult> {
  const host: CanopyInjectedToolRuntime = {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.reject(new Error('unused')),
    worktreeActionRuntime: runtime,
  };
  return desktopPipelinesPort.run(action, { host, actorKey: 'test' });
}

describe('directory-scoped dispatch', () => {
  it('rejects worktree-only actions with invalid_target', async () => {
    const result = await dispatchWorktreeAction(
      { action: { type: 'hook.pause', all: true } },
      coworkRuntime,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe('invalid_target');
    }
  });

  it('runs pipelines directory-scoped at the cowork root', async () => {
    const execution: ExecutionState = {
      version: 5,
      id: 'exec-1',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'Test pipeline',
        description: '',
        scope: ['directory'],
        jobs: {},
      },
      status: 'running',
      started_at: '2026-07-14T00:00:00.000Z',
      cwd: '/tmp/cowork-home',
      env: {},
      inputs: {},
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
    };
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: execution,
    });

    const result = await runPipeline(
      { type: 'pipeline.run', pipelineId: 'pipe-1' },
      coworkRuntime,
    );
    expect(result.status).toBe('started');
    expect(startPipelineExecutionFromMainMock).toHaveBeenCalledTimes(1);
    const { options } = startPipelineExecutionFromMainMock.mock.calls[0][0];
    expect(options.scope).toBe('directory');
    expect(options.target).toEqual({
      scope: 'directory',
      path: '/tmp/cowork-home',
    });
    expect(options.projectId).toBe('cowork-ws-1');
    expect(options.worktreeId).toBe('home');
  });

  it('creates and refines a saved pipeline from a cowork chat', async () => {
    const initialYaml =
      'name: Release\ndescription: Prepare a release\nscope: directory\non: dispatch\njobs:\n  prepare:\n    steps:\n      - uses: builtin/agent-prompt\n        with:\n          prompt: Prepare the release.\n';
    const refinedYaml = initialYaml.replace(
      'Prepare a release',
      'Prepare and verify a release',
    );

    const created = await dispatchWorktreeAction(
      { action: { type: 'pipeline.create', rawYaml: initialYaml } },
      coworkRuntime,
    );
    expect(created.ok).toBe(true);
    expect(savePipelineMock).toHaveBeenCalledTimes(1);

    const updated = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.update',
          pipelineId: 'pipe-1',
          rawYaml: refinedYaml,
        },
      },
      coworkRuntime,
    );
    expect(updated.ok).toBe(true);
    expect(updatePipelineMock).toHaveBeenCalledTimes(1);
    expect(updatePipelineMock.mock.calls[0]?.[0]).toBe('pipe-1');
    expect(updatePipelineMock.mock.calls[0]?.[1].content).toMatchObject({
      name: 'Release',
      description: 'Prepare and verify a release',
    });
  });

  it('refuses to run worktree-only pipelines from a directory runtime', async () => {
    getPipelineMock.mockReturnValue({
      success: true,
      data: pipelineData(['worktree']),
    });
    const result = await runPipeline(
      { type: 'pipeline.run', pipelineId: 'pipe-1' },
      coworkRuntime,
    );
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('unsupported_scope');
      expect(result.message).toContain('worktree');
    }
    expect(startPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it('keeps worktree scope for worktree runtimes', async () => {
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: false,
      error: 'not relevant',
    });
    await runPipeline(
      { type: 'pipeline.run', pipelineId: 'pipe-1' },
      worktreeRuntime,
    );
    const { options } = startPipelineExecutionFromMainMock.mock.calls[0][0];
    expect(options.scope).toBe('worktree');
    expect(options.target).toEqual({
      scope: 'worktree',
      workspace_id: 'project-1',
      worktree_id: 'worktree-1',
      path: '/tmp/worktree',
      created: false,
    });
  });

  it('filters pipeline.list to directory-satisfiable pipelines', async () => {
    listPipelinesMock.mockReturnValue({
      success: true,
      data: [
        pipelineData(['directory']).info,
        { ...pipelineData(['worktree']).info, id: 'pipe-worktree' },
      ],
    });
    getPipelineMock.mockImplementation((id: string) => ({
      success: true,
      data:
        id === 'pipe-worktree'
          ? {
              ...pipelineData(['worktree']),
              info: { ...pipelineData(['worktree']).info, id },
            }
          : pipelineData(['directory']),
    }));

    const result = await dispatchWorktreeAction(
      { action: { type: 'pipeline.list' } },
      coworkRuntime,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        scope: {
          projectId: 'cowork-ws-1',
          worktreeId: 'home',
          cwd: '/tmp/cowork-home',
        },
        filters: { query: '', runModes: [], limit: 20 },
        totalMatches: 1,
        returned: 1,
        pipelines: [{ id: 'pipe-1' }],
      });
    }
  });

  it('keeps pipeline.get bounded to the documented metadata projection', async () => {
    const result = await dispatchWorktreeAction(
      { action: { type: 'pipeline.get', pipelineId: 'pipe-1' } },
      worktreeRuntime,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        pipeline: { id: 'pipe-1', name: 'Test pipeline' },
        jobCount: 0,
        stepCount: 0,
        runModes: [{ mode: 'dispatch', inputs: [] }],
      });
      expect(result.result).not.toHaveProperty('content');
      expect(result.result).not.toHaveProperty('yamlDefinition');
    }
  });

  it('lists executions across work entries in the same cowork project', async () => {
    const otherEntryState: ExecutionState = {
      version: 5,
      id: 'exec-other-entry',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'Test pipeline',
        description: '',
        scope: ['directory'],
        jobs: {},
      },
      status: 'failure',
      started_at: '2026-07-14T00:00:00.000Z',
      completed_at: '2026-07-14T00:01:00.000Z',
      cwd: '/tmp/cowork-home',
      project_id: 'cowork-ws-1',
      worktree_id: 'entry-2',
      scope: 'directory',
      env: {},
      inputs: {},
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
    };
    listExecutionSummariesMock.mockResolvedValue([
      {
        id: otherEntryState.id,
        pipeline_id: otherEntryState.pipeline_id,
        pipeline_name: otherEntryState.pipeline_snapshot.name,
        status: otherEntryState.status,
        status_reasons: [],
        started_at: otherEntryState.started_at,
        completed_at: otherEntryState.completed_at,
        cwd: otherEntryState.cwd,
        project_id: otherEntryState.project_id,
        worktree_id: otherEntryState.worktree_id,
      },
      {
        id: 'exec-other-workspace',
        pipeline_id: 'pipe-1',
        pipeline_name: 'Other project pipeline',
        status: 'failure',
        status_reasons: [],
        started_at: '2026-07-14T00:00:00.000Z',
        cwd: '/tmp/other-cowork-home',
        project_id: 'cowork-ws-2',
        worktree_id: 'entry-2',
      },
    ]);
    loadExecutionStateMock.mockResolvedValue(otherEntryState);

    const result = await dispatchWorktreeAction(
      { action: { type: 'pipeline.execution_list' } },
      coworkRuntime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        scope: {
          projectId: 'cowork-ws-1',
          cwd: '/tmp/cowork-home',
        },
        totalMatches: 1,
        executions: [{ id: 'exec-other-entry' }],
      },
    });
  });

  it('isolates legacy cowork execution lists by project id', async () => {
    listExecutionSummariesMock.mockResolvedValue([
      {
        id: 'exec-current-legacy-workspace',
        pipeline_id: 'pipe-1',
        pipeline_name: 'Current legacy project pipeline',
        status: 'failure',
        status_reasons: [],
        started_at: '2026-07-14T00:00:00.000Z',
        cwd: '/tmp/legacy-cowork-home',
        project_id: STANDALONE_CHAT_PROJECT_ID,
        worktree_id: 'legacy-ws-1',
      },
      {
        id: 'exec-other-legacy-workspace',
        pipeline_id: 'pipe-1',
        pipeline_name: 'Other legacy project pipeline',
        status: 'failure',
        status_reasons: [],
        started_at: '2026-07-14T00:00:00.000Z',
        cwd: '/tmp/other-legacy-cowork-home',
        project_id: STANDALONE_CHAT_PROJECT_ID,
        worktree_id: 'legacy-ws-2',
      },
    ]);

    const result = await dispatchWorktreeAction(
      { action: { type: 'pipeline.execution_list' } },
      legacyCoworkRuntime,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        totalMatches: 1,
        executions: [{ id: 'exec-current-legacy-workspace' }],
      },
    });
  });

  it('retries executions from another work entry in the same cowork project', async () => {
    const failedState: ExecutionState = {
      version: 5,
      id: 'exec-other-entry',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'Test pipeline',
        description: '',
        scope: ['directory'],
        jobs: {},
      },
      status: 'failure',
      started_at: '2026-07-14T00:00:00.000Z',
      completed_at: '2026-07-14T00:01:00.000Z',
      cwd: '/tmp/cowork-home',
      project_id: 'cowork-ws-1',
      worktree_id: 'entry-2',
      scope: 'directory',
      env: {},
      inputs: {},
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
    };
    const retryingState = {
      ...failedState,
      status: 'running' as const,
      completed_at: undefined,
    };
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
      coworkRuntime,
    );

    expect(retryPipelineExecutionFromMainMock).toHaveBeenCalledWith({
      executionId: failedState.id,
      getWindow: coworkRuntime.getWindow,
    });
    expect(result).toMatchObject({
      ok: true,
      result: { execution: { id: failedState.id, status: 'running' } },
    });
  });

  it('rejects legacy cowork retries from another project', async () => {
    const failedState: ExecutionState = {
      version: 5,
      id: 'exec-other-legacy-workspace',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'Test pipeline',
        description: '',
        scope: ['directory'],
        jobs: {},
      },
      status: 'failure',
      started_at: '2026-07-14T00:00:00.000Z',
      completed_at: '2026-07-14T00:01:00.000Z',
      cwd: '/tmp/other-legacy-cowork-home',
      project_id: STANDALONE_CHAT_PROJECT_ID,
      worktree_id: 'legacy-ws-2',
      scope: 'directory',
      env: {},
      inputs: {},
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
    };
    loadExecutionStateMock.mockResolvedValue(failedState);

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_retry',
          executionId: failedState.id,
        },
      },
      legacyCoworkRuntime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_target',
        message:
          'That pipeline execution does not belong to this cowork project.',
      },
    });
    expect(retryPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });

  it('chains executions across cowork work entries without resolving repo ids', async () => {
    const sourceState: ExecutionState = {
      version: 5,
      id: 'exec-other-entry',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'Test pipeline',
        description: '',
        scope: ['directory'],
        jobs: {},
      },
      status: 'success',
      started_at: '2026-07-14T00:00:00.000Z',
      completed_at: '2026-07-14T00:01:00.000Z',
      cwd: '/tmp/cowork-home',
      project_id: 'cowork-ws-1',
      worktree_id: 'entry-2',
      scope: 'directory',
      event_data: {
        plan_ready: {
          plan_path:
            '/tmp/canopy-executions/exec-other-entry/generated-plan.md',
        },
      },
      env: {},
      inputs: {},
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
    };
    loadExecutionStateMock.mockResolvedValue(sourceState);
    getPipelineMock.mockReturnValue({
      success: true,
      data: {
        ...pipelineData(['directory']),
        content: {
          ...pipelineData(['directory']).content,
          on: { dispatch: {}, plan_ready: {} },
        },
      },
    });
    startPipelineExecutionFromMainMock.mockResolvedValue({
      success: true,
      data: {
        ...sourceState,
        id: 'exec-chained',
        status: 'running',
        completed_at: undefined,
        worktree_id: coworkRuntime.worktreeId,
      },
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_chain',
          executionId: sourceState.id,
          pipelineId: 'pipe-1',
          repoId: 'repo-not-valid-in-cowork',
        },
      },
      coworkRuntime,
    );

    expect(
      startPipelineExecutionFromMainMock.mock.calls[0]?.[0].options,
    ).toMatchObject({
      cwd: '/tmp/cowork-home',
      projectId: 'cowork-ws-1',
      worktreeId: 'home',
      eventName: 'plan_ready',
    });
    expect(result).toMatchObject({
      ok: true,
      result: { execution: { id: 'exec-chained', status: 'running' } },
    });
  });

  it('rejects cowork execution actions outside the current project', async () => {
    loadExecutionStateMock.mockResolvedValue({
      version: 5,
      id: 'exec-other-workspace',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'Test pipeline',
        description: '',
        scope: ['directory'],
        jobs: {},
      },
      status: 'failure',
      started_at: '2026-07-14T00:00:00.000Z',
      cwd: '/tmp/other-cowork-home',
      project_id: 'cowork-ws-2',
      worktree_id: 'entry-2',
      scope: 'directory',
      env: {},
      inputs: {},
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
    });

    const result = await dispatchWorktreeAction(
      {
        action: {
          type: 'pipeline.execution_retry',
          executionId: 'exec-other-workspace',
        },
      },
      coworkRuntime,
    );

    expect(result).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_target',
        message:
          'That pipeline execution does not belong to this cowork project.',
      },
    });
    expect(retryPipelineExecutionFromMainMock).not.toHaveBeenCalled();
  });
});

describe('cowork base-branch env', () => {
  it('is a no-op for cowork projects (no git calls)', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    resolveEffectiveBaseBranchesMock.mockRejectedValue(
      new Error('git must not run for cowork'),
    );
    await expect(
      buildPipelineBaseBranchEnv({
        cwd: '/tmp/cowork-home',
        projectId: 'cowork-ws-1',
        worktreeId: 'home',
      }),
    ).resolves.toEqual({});
    expect(resolveEffectiveBaseBranchesMock).not.toHaveBeenCalled();
  });
});

describe('Claude/Codex cowork tool surface parity', () => {
  it('codex cowork dynamic specs add Codex controls to the native-sdk-standalone allowlist', () => {
    const coworkSpecNames = buildCanopyDynamicToolSpecs({
      includeChatVisuals: true,
      mode: 'cowork',
      includeLedger: true,
    })
      .map((tool) => tool.name)
      .sort();
    const expected = [
      // Codex advertises ask-user on the main surface; Claude splits it onto
      // the dedicated native-sdk-ui surface.
      CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.codexToolName,
      immediateTurnRestartCodexToolName,
      ...CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'].map(
        (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].codexToolName,
      ),
    ].sort();
    expect(coworkSpecNames).toEqual(expected);
  });

  it('codex cowork dynamic specs omit the Ledger tools unless the session exposes them', () => {
    const coworkSpecNames = buildCanopyDynamicToolSpecs({
      includeChatVisuals: true,
      mode: 'cowork',
    })
      .map((tool) => tool.name)
      .sort();
    const expected = [
      CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.codexToolName,
      immediateTurnRestartCodexToolName,
      ...CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone']
        .filter((key) => !isLedgerInjectedToolKey(key))
        .map((key) => CANOPY_INJECTED_TOOL_REGISTRY[key].codexToolName),
    ].sort();
    expect(coworkSpecNames).toEqual(expected);
  });

  it('advertises same-entry forks for Cowork but never branch creation', () => {
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
    ).toContain('start_forked_agent');
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp-standalone'],
    ).not.toContain('start_forked_agent');
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
    ).not.toContain('start_branched_agent');
    expect(
      buildCanopyDynamicToolSpecs({
        includeChatVisuals: false,
        mode: 'cowork',
      }).map((tool) => tool.name),
    ).toContain(CANOPY_INJECTED_TOOL_REGISTRY.start_forked_agent.codexToolName);
  });

  it('cowork mode supports watcher output but drops git/code-graph tools', () => {
    const worktreeNames = new Set(
      buildCanopyDynamicToolSpecs({
        includeChatVisuals: false,
        mode: 'worktree',
      }).map((tool) => tool.name),
    );
    const coworkNames = new Set(
      buildCanopyDynamicToolSpecs({
        includeChatVisuals: false,
        mode: 'cowork',
      }).map((tool) => tool.name),
    );
    expect(
      coworkNames.has(
        CANOPY_INJECTED_TOOL_REGISTRY.get_script_output.codexToolName,
      ),
    ).toBe(true);
    expect(
      coworkNames.has(
        CANOPY_INJECTED_TOOL_REGISTRY.get_git_preferences.codexToolName,
      ),
    ).toBe(false);
    expect(
      coworkNames.has(
        CANOPY_INJECTED_TOOL_REGISTRY.query_code_graph.codexToolName,
      ),
    ).toBe(false);
    coworkNames.forEach((name) => {
      expect(worktreeNames.has(name)).toBe(true);
    });
  });
});
