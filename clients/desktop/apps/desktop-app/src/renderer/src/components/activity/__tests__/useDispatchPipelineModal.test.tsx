/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import type * as ReactModule from 'react';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type { DispatchPipelinePluginCollectionContext } from '../DispatchPipelineModal';

jest.mock('../DispatchPipelineModal', () => {
  const React = jest.requireActual<typeof ReactModule>('react');

  return {
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
                  preferences: { 'agent-prompt': 'codex' },
                  modelAliasPreferences: {
                    reviewer: {
                      mode: 'inline',
                      base: 'claude-sonnet-4-6',
                    },
                  },
                  modelConfig: { fastMode: true },
                  pipelinePreferenceLocator: {
                    type: 'pipeline',
                    pipelineId: 'pipeline-1',
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
import { useDispatchPipelineModal } from '../useDispatchPipelineModal';

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
        pluginCollectionPreferences: { 'agent-prompt': 'codex' },
        modelAliasPreferences: {
          reviewer: {
            mode: 'inline',
            base: 'claude-sonnet-4-6',
          },
        },
        modelConfig: { fastMode: true },
        pipelinePreferenceLocator: {
          type: 'pipeline',
          pipelineId: 'pipeline-1',
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
});
