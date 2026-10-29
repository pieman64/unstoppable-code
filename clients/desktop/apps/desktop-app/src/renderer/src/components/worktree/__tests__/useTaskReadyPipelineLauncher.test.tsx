/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type { PipelinePluginCollectionRunContext } from '@/components/activity/PipelineTriggerModal';
import { useChatStore } from '@/stores/chatStore';
import {
  useProjectsStore,
  type CreateWorktreeOptions,
} from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useTaskReadyPipelineLauncher } from '../useTaskReadyPipelineLauncher';

function makeWorktree(overrides?: Partial<WorktreeData>): WorktreeData {
  return {
    id: 'wt-1',
    branchName: 'feature/wt-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSingleRepoProject(
  id: string,
  overrides?: Partial<SingleRepoSidebarItem>,
): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/repos/${id}`,
    color: '#123456',
    order: 0,
    collapsed: false,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    ...overrides,
  };
}

function makeMultiRepoProject(
  id: string,
  overrides?: Partial<MultiRepoSidebarItem>,
): MultiRepoSidebarItem {
  return {
    id,
    type: 'multi-repo',
    name: id,
    color: '#123456',
    order: 0,
    collapsed: false,
    repos: [],
    worktrees: [],
    ...overrides,
  };
}

function makeCoworkProject(
  id: string,
  overrides?: Partial<CoworkSidebarItem>,
): CoworkSidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#123456',
    order: 0,
    collapsed: false,
    ...overrides,
  };
}

function makePipeline(overrides?: {
  info?: Partial<PipelineData['info']>;
}): PipelineData {
  const info: PipelineData['info'] = {
    id: 'pipeline-1',
    name: 'Task pipeline',
    filename: 'task-pipeline.yaml',
    description: '',
    icon: 'workflow',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    readonly: false,
    ...overrides?.info,
  };
  return {
    info,
    content: { name: 'Task pipeline', on: 'task_ready', jobs: {} },
  };
}

const PLUGIN_CONTEXT: PipelinePluginCollectionRunContext = {
  preferences: {
    'collection-1': {
      disabledDefaultKeys: [],
      extraSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    },
  },
  modelConfig: { fastMode: true },
  pipelinePreferenceLocator: { type: 'pipeline', pipelineId: 'pipeline-1' },
};

const originalSelectWorktree = useChatStore.getState().selectWorktree;

interface HookProbe {
  current: ReturnType<typeof useTaskReadyPipelineLauncher> | null;
}

function HookHarness({ probe }: { probe: HookProbe }): JSX.Element | null {
  probe.current = useTaskReadyPipelineLauncher();
  return null;
}

function renderHookHarness(): { probe: HookProbe; cleanup: () => void } {
  const probe: HookProbe = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<HookHarness probe={probe} />);
  });
  return {
    probe,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('useTaskReadyPipelineLauncher', () => {
  let originalApi: Window['api'] | undefined;
  let originalPipelines: Window['pipelines'] | undefined;
  let getWorktreePathMock: jest.Mock;
  let homeGetCoworkRootMock: jest.Mock;
  let executePipelineMock: jest.Mock<
    Promise<{ success: boolean; error?: string }>,
    [unknown, Record<string, unknown>]
  >;
  let createWorktreeMock: jest.Mock<
    Promise<{ id: string } | undefined>,
    [string, CreateWorktreeOptions?]
  >;
  let enqueuePendingTaskBranchNamingMock: jest.Mock;
  let enqueuePendingExecutionMock: jest.Mock;
  let navigateMock: jest.Mock;
  let selectWorktreeMock: jest.Mock;

  beforeEach(() => {
    originalApi = window.api;
    originalPipelines = window.pipelines;
    getWorktreePathMock = jest.fn().mockResolvedValue('/worktrees/wt-1');
    homeGetCoworkRootMock = jest.fn().mockResolvedValue('/cowork/root');
    executePipelineMock = jest
      .fn<
        Promise<{ success: boolean; error?: string }>,
        [unknown, Record<string, unknown>]
      >()
      .mockResolvedValue({ success: true });
    createWorktreeMock = jest.fn(
      (_workspaceId: string, options?: CreateWorktreeOptions) => {
        options?.onRegistered?.(makeWorktree({ id: 'created-wt' }));
        return Promise.resolve({ id: 'created-wt' });
      },
    );
    enqueuePendingTaskBranchNamingMock = jest.fn();
    enqueuePendingExecutionMock = jest.fn().mockReturnValue('pending-1');
    navigateMock = jest.fn();
    selectWorktreeMock = jest.fn();

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(originalApi ?? {}),
        getWorktreePath: getWorktreePathMock,
        homeGetCoworkRoot: homeGetCoworkRootMock,
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        ...(originalPipelines ?? {}),
        execute: executePipelineMock,
      },
    });

    useProjectsStore.setState({
      projects: [],
      createWorktree: createWorktreeMock,
      enqueuePendingTaskBranchNaming: enqueuePendingTaskBranchNamingMock,
    });
    usePipelineRunsStore.setState({
      enqueuePendingExecution: enqueuePendingExecutionMock,
    });
    useNavigationStore.setState({ navigate: navigateMock });
    useChatStore.setState({
      selectedWorktree: null,
      selectWorktree: selectWorktreeMock,
    });
  });

  afterEach(() => {
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
    if (originalPipelines === undefined) {
      Reflect.deleteProperty(window, 'pipelines');
    } else {
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: originalPipelines,
      });
    }
    document.body.replaceChildren();
    useChatStore.setState({
      selectedWorktree: null,
      selectWorktree: originalSelectWorktree,
    });
  });

  describe('open', () => {
    it('resolves the project repoPath for new-worktree targets with executionScope worktree', async () => {
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = false;
      await act(async () => {
        opened =
          (await probe.current?.open('ws-1', 'Do the task', {
            kind: 'new-worktree',
          })) ?? false;
      });

      expect(opened).toBe(true);
      expect(probe.current?.ctx).toEqual({
        workspaceId: 'ws-1',
        taskText: 'Do the task',
        cwd: '/repos/ws-1',
        repoChoices: [],
        target: { kind: 'new-worktree' },
        executionScope: 'worktree',
      });
      cleanup();
    });

    it('builds repo choices for source-backed multi-repo projects', async () => {
      useProjectsStore.setState({
        projects: [
          makeMultiRepoProject('ws-multi', {
            sourceRepoPath: '/repos/source',
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                repoPath: '/repos/a',
              },
            ],
          }),
        ],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = false;
      await act(async () => {
        opened =
          (await probe.current?.open('ws-multi', 'Task', {
            kind: 'branch',
            branchName: 'existing/branch',
          })) ?? false;
      });

      expect(opened).toBe(true);
      expect(probe.current?.ctx?.cwd).toBe('/repos/source');
      expect(probe.current?.ctx?.repoChoices).toEqual([
        { repoId: '__workspace_root__', repoName: 'Project root' },
        { repoId: 'repo-a', repoName: 'Repo A' },
      ]);
      cleanup();
    });

    it('resolves the worktree checkout path for worktree targets', async () => {
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = false;
      await act(async () => {
        opened =
          (await probe.current?.open('ws-1', 'Task', {
            kind: 'worktree',
            worktreeId: 'wt-1',
          })) ?? false;
      });

      expect(opened).toBe(true);
      expect(getWorktreePathMock).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
      expect(probe.current?.ctx).toEqual({
        workspaceId: 'ws-1',
        taskText: 'Task',
        cwd: '/worktrees/wt-1',
        repoChoices: [],
        target: { kind: 'worktree', worktreeId: 'wt-1' },
        executionScope: 'worktree',
      });
      cleanup();
    });

    it('returns false for worktree targets whose worktree no longer exists', async () => {
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1', { worktrees: [] })],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = true;
      await act(async () => {
        opened =
          (await probe.current?.open('ws-1', 'Task', {
            kind: 'worktree',
            worktreeId: 'missing-wt',
          })) ?? true;
      });

      expect(opened).toBe(false);
      expect(getWorktreePathMock).not.toHaveBeenCalled();
      expect(probe.current?.ctx).toBeNull();
      cleanup();
    });

    it('resolves the cowork root for cowork targets with executionScope directory', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = false;
      await act(async () => {
        opened =
          (await probe.current?.open('cowork-1', 'Task', {
            kind: 'cowork',
          })) ?? false;
      });

      expect(opened).toBe(true);
      expect(homeGetCoworkRootMock).toHaveBeenCalledWith({
        workspaceId: 'cowork-1',
      });
      expect(probe.current?.ctx).toEqual({
        workspaceId: 'cowork-1',
        taskText: 'Task',
        cwd: '/cowork/root',
        repoChoices: [],
        target: { kind: 'cowork' },
        executionScope: 'directory',
      });
      cleanup();
    });

    it('returns false for cowork targets on non-cowork projects', async () => {
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = true;
      await act(async () => {
        opened =
          (await probe.current?.open('ws-1', 'Task', { kind: 'cowork' })) ??
          true;
      });

      expect(opened).toBe(false);
      expect(homeGetCoworkRootMock).not.toHaveBeenCalled();
      cleanup();
    });

    it('returns false when the cowork root IPC rejects', async () => {
      homeGetCoworkRootMock.mockRejectedValueOnce(new Error('nope'));
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      let opened = true;
      await act(async () => {
        opened =
          (await probe.current?.open('cowork-1', 'Task', {
            kind: 'cowork',
          })) ?? true;
      });

      expect(opened).toBe(false);
      expect(probe.current?.ctx).toBeNull();
      cleanup();
    });
  });

  describe('run — new-worktree target', () => {
    it('creates a worktree, enqueues branch naming AND the deferred execution', async () => {
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1')],
      });
      const pipeline = makePipeline();
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Build it', {
          kind: 'new-worktree',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          pipeline,
          { answer: 'yes' },
          'repo-a',
          PLUGIN_CONTEXT,
        );
      });

      expect(navigateMock).toHaveBeenCalledWith('main');
      expect(createWorktreeMock).toHaveBeenCalledTimes(1);
      expect(createWorktreeMock.mock.calls[0]?.[0]).toBe('ws-1');
      expect(
        createWorktreeMock.mock.calls[0]?.[1]?.onRegistered,
      ).toBeInstanceOf(Function);
      // Task G1 fix round 2: create (and auto-select) BEFORE navigating, so
      // the Code page never mounts in a no-selection/stale-selection state
      // while the createWorktree IPC round-trip is still in flight.
      expect(createWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
        navigateMock.mock.invocationCallOrder[0],
      );
      expect(enqueuePendingTaskBranchNamingMock).toHaveBeenCalledWith(
        'ws-1',
        'created-wt',
        'Build it',
      );
      expect(enqueuePendingExecutionMock).toHaveBeenCalledTimes(1);
      expect(enqueuePendingExecutionMock).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'created-wt',
        pipelineId: 'pipeline-1',
        pipelineContent: pipeline.content,
        selectedRepoId: 'repo-a',
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Build it' } },
        inputs: { answer: 'yes' },
        pluginCollectionPreferences: PLUGIN_CONTEXT.preferences,
        modelConfig: PLUGIN_CONTEXT.modelConfig,
        pipelinePreferenceLocator: PLUGIN_CONTEXT.pipelinePreferenceLocator,
        pipelineName: 'Task pipeline',
        taskText: 'Build it',
      });
      expect(executePipelineMock).not.toHaveBeenCalled();
      expect(probe.current?.ctx).toBeNull();
      expect(probe.current?.runError).toBeNull();
      cleanup();
    });

    it('forwards an explicit base branch while keeping new-worktree naming', async () => {
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Build it', {
          kind: 'new-worktree',
          baseBranch: 'release',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          makePipeline(),
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      expect(createWorktreeMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ baseBranch: 'release' }),
      );
      expect(enqueuePendingTaskBranchNamingMock).toHaveBeenCalledWith(
        'ws-1',
        'created-wt',
        'Build it',
      );
      cleanup();
    });

    it('surfaces a createWorktree failure as runError and keeps ctx open', async () => {
      createWorktreeMock.mockResolvedValueOnce(undefined);
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Build it', {
          kind: 'new-worktree',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          makePipeline(),
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      expect(probe.current?.runError).toBe('Failed to create worktree');
      expect(probe.current?.ctx).not.toBeNull();
      expect(enqueuePendingExecutionMock).not.toHaveBeenCalled();
      // Task G1 fix round 2: navigation now happens only after a successful
      // createWorktree, so a failure leaves the user where they launched
      // from (with runError shown in the still-open modal).
      expect(navigateMock).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('run — branch target', () => {
    it('creates the worktree from the existing branch WITHOUT branch naming', async () => {
      useProjectsStore.setState({
        projects: [makeSingleRepoProject('ws-1')],
      });
      const pipeline = makePipeline();
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Fix it', {
          kind: 'branch',
          branchName: 'existing/branch',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          pipeline,
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      expect(createWorktreeMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          existingBranch: 'existing/branch',
        }),
      );
      expect(enqueuePendingTaskBranchNamingMock).not.toHaveBeenCalled();
      expect(enqueuePendingExecutionMock).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'created-wt',
        pipelineId: 'pipeline-1',
        pipelineContent: pipeline.content,
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Fix it' } },
        pluginCollectionPreferences: PLUGIN_CONTEXT.preferences,
        modelConfig: PLUGIN_CONTEXT.modelConfig,
        pipelinePreferenceLocator: PLUGIN_CONTEXT.pipelinePreferenceLocator,
        pipelineName: 'Task pipeline',
        taskText: 'Fix it',
      });
      expect(executePipelineMock).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('run — worktree target (immediate)', () => {
    it('executes immediately against the worktree cwd with projectId/worktreeId', async () => {
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      const pipeline = makePipeline();
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Ship it', {
          kind: 'worktree',
          worktreeId: 'wt-1',
        });
      });
      let dispatched: boolean | undefined;
      await act(async () => {
        dispatched = await probe.current?.run(
          'pipeline-1',
          pipeline,
          { answer: 'yes' },
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      // Callers (the Home onboarding task-plan preset) key one-shot
      // cleanup on this: true means genuinely dispatched.
      expect(dispatched).toBe(true);
      expect(createWorktreeMock).not.toHaveBeenCalled();
      expect(enqueuePendingTaskBranchNamingMock).not.toHaveBeenCalled();
      expect(enqueuePendingExecutionMock).not.toHaveBeenCalled();
      expect(executePipelineMock).toHaveBeenCalledTimes(1);
      expect(executePipelineMock).toHaveBeenCalledWith(pipeline.content, {
        cwd: '/worktrees/wt-1',
        pipelineFilePath: undefined,
        repoPath: undefined,
        pipelineId: 'pipeline-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Ship it' } },
        inputs: { answer: 'yes' },
        pluginCollectionPreferences: PLUGIN_CONTEXT.preferences,
        modelConfig: PLUGIN_CONTEXT.modelConfig,
        pipelinePreferenceLocator: PLUGIN_CONTEXT.pipelinePreferenceLocator,
      });
      expect(selectWorktreeMock).toHaveBeenCalledWith('ws-1', 'wt-1');
      expect(selectWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
        navigateMock.mock.invocationCallOrder[0],
      );
      expect(navigateMock).toHaveBeenCalledWith('main');
      expect(probe.current?.ctx).toBeNull();
      cleanup();
    });

    it('sets repoPath/pipelineFilePath for project-sourced pipelines', async () => {
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      const pipeline = makePipeline({
        info: { source: 'project', filePath: '/repo/.canopy/p.yaml' },
      });
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Ship it', {
          kind: 'worktree',
          worktreeId: 'wt-1',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          pipeline,
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      expect(executePipelineMock).toHaveBeenCalledWith(
        pipeline.content,
        expect.objectContaining({
          pipelineFilePath: '/repo/.canopy/p.yaml',
          repoPath: '/worktrees/wt-1',
        }),
      );
      cleanup();
    });

    it('surfaces an execute failure as runError, keeps ctx open, and does not navigate', async () => {
      executePipelineMock.mockResolvedValueOnce({
        success: false,
        error: 'Pipeline blew up',
      });
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('ws-1', 'Ship it', {
          kind: 'worktree',
          worktreeId: 'wt-1',
        });
      });
      let dispatched: boolean | undefined;
      await act(async () => {
        dispatched = await probe.current?.run(
          'pipeline-1',
          makePipeline(),
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      // False = the modal stays open on runError; callers must not treat
      // the click as consumed (staged presets survive for the retry).
      expect(dispatched).toBe(false);
      expect(probe.current?.runError).toBe('Pipeline blew up');
      expect(probe.current?.ctx).not.toBeNull();
      expect(probe.current?.running).toBe(false);
      expect(navigateMock).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('run — cowork target (immediate, directory scope)', () => {
    it('executes immediately against the cowork root with NO projectId/worktreeId', async () => {
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-1')],
      });
      const pipeline = makePipeline();
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('cowork-1', 'Organize notes', {
          kind: 'cowork',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          pipeline,
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      expect(createWorktreeMock).not.toHaveBeenCalled();
      expect(enqueuePendingTaskBranchNamingMock).not.toHaveBeenCalled();
      expect(enqueuePendingExecutionMock).not.toHaveBeenCalled();
      expect(executePipelineMock).toHaveBeenCalledTimes(1);
      expect(executePipelineMock).toHaveBeenCalledWith(pipeline.content, {
        cwd: '/cowork/root',
        pipelineFilePath: undefined,
        repoPath: undefined,
        pipelineId: 'pipeline-1',
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Organize notes' } },
        pluginCollectionPreferences: PLUGIN_CONTEXT.preferences,
        modelConfig: PLUGIN_CONTEXT.modelConfig,
        pipelinePreferenceLocator: PLUGIN_CONTEXT.pipelinePreferenceLocator,
      });
      const executeOptions = executePipelineMock.mock.calls[0]?.[1];
      expect(executeOptions).not.toHaveProperty('projectId');
      expect(executeOptions).not.toHaveProperty('worktreeId');
      expect(navigateMock).toHaveBeenCalledWith('workflows-library');
      expect(probe.current?.ctx).toBeNull();
      cleanup();
    });

    it('surfaces a thrown execute error via extractIpcErrorMessage', async () => {
      executePipelineMock.mockRejectedValueOnce(new Error('IPC exploded'));
      useProjectsStore.setState({
        projects: [makeCoworkProject('cowork-1')],
      });
      const { probe, cleanup } = renderHookHarness();

      await act(async () => {
        await probe.current?.open('cowork-1', 'Organize notes', {
          kind: 'cowork',
        });
      });
      await act(async () => {
        await probe.current?.run(
          'pipeline-1',
          makePipeline(),
          undefined,
          undefined,
          PLUGIN_CONTEXT,
        );
      });

      expect(probe.current?.runError).toBe('IPC exploded');
      expect(probe.current?.ctx).not.toBeNull();
      expect(navigateMock).not.toHaveBeenCalled();
      cleanup();
    });
  });
});
