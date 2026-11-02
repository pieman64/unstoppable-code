/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import type * as ReactModule from 'react';
import {
  PIPELINE_NOW_OWNED_MESSAGE,
  type PipelineData,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  DispatchPipelinePluginCollectionContext,
  PipelineRunDestination,
} from '../DispatchPipelineModal';

const ORG_A = 'org:11111111-1111-4111-8111-111111111111';

jest.mock('../DispatchPipelineModal', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const pipeline = {
    info: { id: 'global-pipeline', source: 'user' },
    content: { name: 'Global pipeline', on: 'dispatch' },
  } as PipelineData;
  const context: DispatchPipelinePluginCollectionContext = {
    preferences: {},
    modelConfig: { fastMode: false },
  };
  const destinations: Record<string, PipelineRunDestination> = {
    'workflows-run-chosen-owner': {
      kind: 'global',
      requestedOwner: 'org:11111111-1111-4111-8111-111111111111',
      ownerLabel: 'Acme',
      outsideNavigation: true,
    },
    'workflows-run-saved-owner': {
      kind: 'global',
      ownerLabel: 'Personal',
      outsideNavigation: false,
    },
    'workflows-run-task': {
      kind: 'current-task',
      projectId: 'project-2',
      worktreeId: 'worktree-2',
    },
  };

  return {
    WorkflowsRunPipelineModal: ({
      onRun,
      runError,
      reloadToken,
      currentTarget,
    }: {
      onRun: (
        pipeline: PipelineData,
        inputs: Record<string, string>,
        selectedRepoId: string | undefined,
        pluginCollectionContext: DispatchPipelinePluginCollectionContext,
        destination: PipelineRunDestination,
      ) => Promise<void>;
      runError?: string | null;
      reloadToken?: number;
      currentTarget?: { projectId: string; worktreeId: string };
    }): JSX.Element =>
      React.createElement(
        'div',
        {
          'data-testid': 'workflows-run-modal',
          'data-reload-token': String(reloadToken ?? 0),
          'data-current-project': currentTarget?.projectId ?? '',
        },
        runError
          ? React.createElement(
              'div',
              { 'data-testid': 'workflows-run-error' },
              runError,
            )
          : null,
        ...Object.entries(destinations).map(([testId, destination]) =>
          React.createElement('button', {
            key: testId,
            type: 'button',
            'data-testid': testId,
            onClick: (): void => {
              void onRun(
                pipeline,
                { topic: 'release' },
                'repo-1',
                context,
                destination,
              );
            },
          }),
        ),
      ),
    DispatchPipelineModal: ({
      projectId,
      worktreeId,
      onClose,
      onRun,
      isRunning,
      runError,
      onClearError,
    }: {
      projectId?: string;
      worktreeId?: string;
      onClose: () => void;
      onRun: (
        pipeline: PipelineData,
        inputs: Record<string, string>,
        selectedRepoId: string | undefined,
        pluginCollectionContext: DispatchPipelinePluginCollectionContext,
      ) => Promise<void>;
      isRunning?: boolean;
      runError?: string | null;
      onClearError?: () => void;
    }): JSX.Element =>
      React.createElement(
        'div',
        {
          'data-testid': 'dispatch-modal',
          'data-project-id': projectId,
          'data-worktree-id': worktreeId,
          'data-running': isRunning ? 'true' : 'false',
        },
        runError
          ? React.createElement(
              'div',
              { 'data-testid': 'dispatch-error' },
              runError,
            )
          : null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'dispatch-run',
            onClick: (): void => {
              void onRun(
                {
                  info: { id: 'pipeline-1', source: 'bundled' },
                  content: { name: 'Dispatch pipeline', on: 'dispatch' },
                } as PipelineData,
                { input_name: 'input value' },
                'repo-1',
                {
                  preferences: {
                    'agent-prompt': {
                      disabledDefaultKeys: ['agent-prompt-default'],
                      extraSelections: {
                        collectionIds: [],
                        skillRefs: [],
                        pluginRefs: [],
                      },
                    },
                  },
                  modelAliasPreferences: {
                    reviewer: {
                      mode: 'inline',
                      base: 'claude-sonnet-4-6',
                    },
                  },
                  modelConfig: { fastMode: true },
                  pipelinePreferenceLocator: {
                    type: 'stored',
                    source: 'user',
                    value: 'pipeline-1',
                  },
                },
              );
            },
          },
          'Run',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'dispatch-close',
            onClick: onClose,
          },
          'Close',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'dispatch-clear',
            onClick: onClearError,
          },
          'Clear',
        ),
      ),
  };
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useGitHubStore } from '@/stores/githubStore';
import {
  PIPELINE_STARTED_TOAST,
  useDispatchPipelineModal,
} from '../useDispatchPipelineModal';

interface HookProbe {
  current: ReturnType<typeof useDispatchPipelineModal> | null;
}

function HookHarness({ probe }: { probe: HookProbe }): JSX.Element | null {
  probe.current = useDispatchPipelineModal();
  return probe.current.dispatchPipelineModal;
}

function renderHookHarness(): {
  probe: HookProbe;
  cleanup: () => void;
} {
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(selector: string): Promise<void> {
  const element = document.body.querySelector(selector);
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDispatchPipelineModal', () => {
  let originalApi: Window['api'] | undefined;
  let originalPipelines: Window['pipelines'] | undefined;
  let getWorktreePathMock: jest.Mock;
  let executePipelineMock: jest.Mock;

  beforeEach(() => {
    originalApi = window.api;
    originalPipelines = window.pipelines;
    getWorktreePathMock = jest.fn().mockResolvedValue('/repo/worktree');
    executePipelineMock = jest.fn().mockResolvedValue({ success: true });

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(originalApi ?? {}),
        getWorktreePath: getWorktreePathMock,
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        ...(originalPipelines ?? {}),
        execute: executePipelineMock,
      },
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
  });

  it('shows a path resolution failure and keeps the modal open', async () => {
    getWorktreePathMock.mockRejectedValueOnce(new Error('Missing worktree'));
    const { probe, cleanup } = renderHookHarness();

    act(() => {
      probe.current?.openDispatchPipelineModal({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    });
    await click('[data-testid="dispatch-run"]');
    await flush();

    expect(getWorktreePathMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'repo-1',
    });
    expect(executePipelineMock).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="dispatch-modal"]'),
    ).toBeTruthy();
    expect(
      document.body.querySelector('[data-testid="dispatch-error"]')
        ?.textContent,
    ).toBe('Missing worktree');
    expect(
      document.body
        .querySelector('[data-testid="dispatch-modal"]')
        ?.getAttribute('data-running'),
    ).toBe('false');

    cleanup();
  });

  it('shows an execution failure and keeps the modal open', async () => {
    executePipelineMock.mockResolvedValueOnce({
      success: false,
      error: 'Dispatch failed',
    });
    const { probe, cleanup } = renderHookHarness();

    act(() => {
      probe.current?.openDispatchPipelineModal({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    });
    await click('[data-testid="dispatch-run"]');
    await flush();

    expect(executePipelineMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cwd: '/repo/worktree',
        pipelineId: 'pipeline-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoPath: undefined,
        eventName: 'dispatch',
        inputs: { input_name: 'input value' },
        pluginCollectionPreferences: {
          'agent-prompt': {
            disabledDefaultKeys: ['agent-prompt-default'],
            extraSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        },
        modelAliasPreferences: {
          reviewer: {
            mode: 'inline',
            base: 'claude-sonnet-4-6',
          },
        },
        modelConfig: { fastMode: true },
        pipelinePreferenceLocator: {
          type: 'stored',
          source: 'user',
          value: 'pipeline-1',
        },
      }),
    );
    expect(
      document.body.querySelector('[data-testid="dispatch-modal"]'),
    ).toBeTruthy();
    expect(
      document.body.querySelector('[data-testid="dispatch-error"]')
        ?.textContent,
    ).toBe('Dispatch failed');

    cleanup();
  });

  it('closes the modal after a successful dispatch', async () => {
    const { probe, cleanup } = renderHookHarness();

    act(() => {
      probe.current?.openDispatchPipelineModal({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    });
    await click('[data-testid="dispatch-run"]');
    await flush();

    expect(executePipelineMock).toHaveBeenCalledTimes(1);
    expect(
      document.body.querySelector('[data-testid="dispatch-modal"]'),
    ).toBeNull();

    cleanup();
  });

  describe('Workflows Run', () => {
    let addToast: jest.Mock;

    beforeEach(() => {
      addToast = jest.fn();
      useGitHubStore.setState({ addToast });
    });

    it('opens without a selected task', () => {
      const { probe, cleanup } = renderHookHarness();

      act(() => {
        probe.current?.openWorkflowsRunModal();
      });

      const modal = document.body.querySelector(
        '[data-testid="workflows-run-modal"]',
      );
      expect(modal?.getAttribute('data-current-project')).toBe('');
      cleanup();
    });

    it('starts a run with no project under the chosen owner', async () => {
      const { probe, cleanup } = renderHookHarness();

      act(() => {
        probe.current?.openWorkflowsRunModal();
      });
      await click('[data-testid="workflows-run-chosen-owner"]');
      await flush();

      expect(getWorktreePathMock).not.toHaveBeenCalled();
      expect(executePipelineMock).toHaveBeenCalledTimes(1);
      const [, options] = executePipelineMock.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(options).toEqual({
        pipelineId: 'global-pipeline',
        scope: 'global',
        target: { scope: 'global' },
        eventName: 'dispatch',
        inputs: { topic: 'release' },
        requestedOwner: ORG_A,
        pluginCollectionPreferences: {},
        modelConfig: { fastMode: false },
      });
      // No project, task, folder, or watcher goes with a global run.
      for (const key of [
        'cwd',
        'projectId',
        'worktreeId',
        'repoPath',
        'pipelineFilePath',
        'appAdvisorPipelineWatchers',
      ]) {
        expect(options).not.toHaveProperty(key);
      }
      expect(
        document.body.querySelector('[data-testid="workflows-run-modal"]'),
      ).toBeNull();
      expect(addToast).toHaveBeenCalledWith(
        'Pipeline started. Find it in Acme › Workflows › Runs.',
        'success',
        undefined,
        { category: 'Pipeline' },
      );
      cleanup();
    });

    it('sends no owner for a pipeline with a saved owner', async () => {
      const { probe, cleanup } = renderHookHarness();

      act(() => {
        probe.current?.openWorkflowsRunModal();
      });
      await click('[data-testid="workflows-run-saved-owner"]');
      await flush();

      const [, options] = executePipelineMock.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(options).not.toHaveProperty('requestedOwner');
      expect(addToast).toHaveBeenCalledWith(
        PIPELINE_STARTED_TOAST,
        'success',
        undefined,
        { category: 'Pipeline' },
      );
      cleanup();
    });

    it('keeps the dialog and re-reads the pipeline when a start is refused', async () => {
      executePipelineMock.mockResolvedValueOnce({
        success: false,
        error: PIPELINE_NOW_OWNED_MESSAGE,
        errorCode: 'pipeline_now_owned',
      });
      const { probe, cleanup } = renderHookHarness();

      act(() => {
        probe.current?.openWorkflowsRunModal();
      });
      await click('[data-testid="workflows-run-chosen-owner"]');
      await flush();

      const modal = document.body.querySelector(
        '[data-testid="workflows-run-modal"]',
      );
      expect(modal).toBeTruthy();
      expect(
        document.body.querySelector('[data-testid="workflows-run-error"]')
          ?.textContent,
      ).toBe(PIPELINE_NOW_OWNED_MESSAGE);
      expect(modal?.getAttribute('data-reload-token')).toBe('1');
      expect(addToast).not.toHaveBeenCalled();
      cleanup();
    });

    it('re-reads only on a now-owned refusal and clears the error on retry', async () => {
      // The same text without the now-owned code is an ordinary failure.
      executePipelineMock.mockResolvedValueOnce({
        success: false,
        error: PIPELINE_NOW_OWNED_MESSAGE,
      });
      const { probe, cleanup } = renderHookHarness();

      act(() => {
        probe.current?.openWorkflowsRunModal();
      });
      await click('[data-testid="workflows-run-chosen-owner"]');
      await flush();

      const modal = (): Element | null =>
        document.body.querySelector('[data-testid="workflows-run-modal"]');
      // Only a refusal coded as now owned re-reads the pipeline.
      expect(modal()?.getAttribute('data-reload-token')).toBe('0');
      expect(
        document.body.querySelector('[data-testid="workflows-run-error"]')
          ?.textContent,
      ).toBe(PIPELINE_NOW_OWNED_MESSAGE);

      let resolveRetry: (value: { success: true; data: object }) => void = () =>
        undefined;
      executePipelineMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      );
      await click('[data-testid="workflows-run-chosen-owner"]');
      // The earlier error is cleared while the retry starts.
      expect(
        document.body.querySelector('[data-testid="workflows-run-error"]'),
      ).toBeNull();
      resolveRetry({ success: true, data: {} });
      await flush();
      cleanup();
    });

    it('runs in the current task through its worktree path', async () => {
      const { probe, cleanup } = renderHookHarness();

      act(() => {
        probe.current?.openWorkflowsRunModal({
          currentTarget: { projectId: 'project-2', worktreeId: 'worktree-2' },
        });
      });
      await click('[data-testid="workflows-run-task"]');
      await flush();

      expect(getWorktreePathMock).toHaveBeenCalledWith({
        projectId: 'project-2',
        worktreeId: 'worktree-2',
        repoId: 'repo-1',
      });
      expect(executePipelineMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cwd: '/repo/worktree',
          projectId: 'project-2',
          worktreeId: 'worktree-2',
        }),
      );
      const [, options] = executePipelineMock.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(options).not.toHaveProperty('scope');
      expect(options).not.toHaveProperty('requestedOwner');
      cleanup();
    });
  });
});
