/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BackgroundTaskStopOutcome,
  BackgroundTaskStopRequest,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type {
  BackgroundTaskHostActions,
  BackgroundTaskDetail,
  BackgroundTaskFullOutput,
} from '../background-tasks-section';
import {
  BackgroundTaskDetailModal,
  TERMINAL_OUTPUT_FLUSH_WINDOW_MS,
} from '../BackgroundTaskDetailModal';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const OUTPUT_FILE = '/tmp/canopy-bg/task-1.log';
const OUTPUT_NOTICE = '[data-testid="bg-process-output-notice"]';

type OutputListener = {
  key: string;
  onLines: (lines: readonly string[]) => void;
};

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'tool-1',
    ownerToolUseId: 'tool-1',
    parentTaskId: null,
    settledAt: null,
    lastDescription: null,
    summary: null,
    kind: 'bash',
    title: 'Build project',
    status: 'running',
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    outputLines: [],
    canStop: true,
    ...overrides,
  };
}

function createStopClient(
  stopCommands: CommandMap['activity.stopBackgroundTask']['args'][],
): CanopyClient {
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    if (
      name === 'activity.stopBackgroundTask' &&
      'projectId' in args &&
      'worktreeId' in args &&
      'chatId' in args &&
      'taskId' in args &&
      typeof args.projectId === 'string' &&
      typeof args.worktreeId === 'string' &&
      typeof args.chatId === 'string' &&
      typeof args.taskId === 'string'
    ) {
      stopCommands.push({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        chatId: args.chatId,
        taskId: args.taskId,
      });
      return Promise.resolve<BackgroundTaskStopOutcome>('stopped');
    }
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  return {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
      backgroundTaskStop: true,
    },
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void args;
      return Promise.reject(new Error(`Unexpected query: ${name}`));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('BackgroundTaskDetailModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let readFullOutput: jest.Mock;
  let actions: BackgroundTaskHostActions;
  let detail: BackgroundTaskDetail;
  let stopCommands: CommandMap['activity.stopBackgroundTask']['args'][];
  let client: CanopyClient;
  let unsubscribeOutput: jest.Mock;
  let listeners: OutputListener[];

  beforeEach(() => {
    jest.useFakeTimers();
    listeners = [];
    readFullOutput = jest.fn(() =>
      Promise.resolve({ lines: [], truncated: false }),
    );
    stopCommands = [];
    client = createStopClient(stopCommands);
    detail = {
      providerTaskId: 'task-1',
      toolName: 'Bash',
      outputLocationLabel: OUTPUT_FILE,
      outputSource: OUTPUT_FILE,
      outputStreamKey: 'task-1',
    };
    unsubscribeOutput = jest.fn();
    actions = {
      getDetail: (): BackgroundTaskDetail => detail,
      readFullOutput,
      subscribeOutput: jest.fn(
        (key: string, onLines: (lines: readonly string[]) => void) => {
          const listener = { key, onLines };
          listeners.push(listener);
          return (): void => {
            listeners = listeners.filter((entry) => entry !== listener);
            unsubscribeOutput();
          };
        },
      ),
      renderWorkflowRun: (): JSX.Element => <div data-testid="workflow-body" />,
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.useRealTimers();
  });

  /** Let the pending `readFullOutput` promise settle into state. */
  async function flushReads(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function renderModal(
    task: BackgroundTask,
    onClose: () => void = (): void => {},
  ): Promise<void> {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <BackgroundTaskDetailModal
            task={task}
            actions={actions}
            onClose={onClose}
          />
        </CanopyClientProvider>,
      );
    });
    await flushReads();
  }

  function emitOutput(lines: string[]): void {
    act(() => {
      for (const listener of [...listeners]) {
        if (listener.key === 'task-1') listener.onLines(lines);
      }
    });
  }

  // The modal is portaled onto the document body, so read the whole body.
  function modalText(): string {
    return document.body.textContent ?? '';
  }

  async function advanceFlushWindow(): Promise<void> {
    act(() => {
      jest.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_WINDOW_MS);
    });
    await flushReads();
  }

  it('follows the task output when the host supplies no loader or subscription', async () => {
    actions = {};
    const task = makeTask({ outputLines: ['first'] });
    await renderModal(task);
    expect(modalText()).toContain('first');
    await renderModal({ ...task, outputLines: ['first', 'second'] });
    expect(modalText()).toContain('first');
    expect(modalText()).toContain('second');
  });

  it('shows the output file row, "not set" without one, and omits it when the host has none', async () => {
    await renderModal(makeTask());
    expect(modalText()).toContain(`Output file${OUTPUT_FILE}`);
    detail = { providerTaskId: 'task-1' };
    await renderModal(makeTask());
    expect(modalText()).toContain('Output filenot set');
    detail = { providerTaskId: 'task-1', outputLocationLabel: null };
    await renderModal(makeTask());
    expect(modalText()).not.toContain('Output file');
    expect(modalText()).toContain('task-1');
  });

  it('keeps live subscription output when the task output changes', async () => {
    readFullOutput.mockResolvedValue({
      lines: ['from file'],
      truncated: false,
    });
    const task = makeTask({ outputLines: ['captured'] });
    await renderModal(task);
    emitOutput(['streamed']);
    await renderModal({ ...task, outputLines: ['captured', 'more'] });
    expect(modalText()).toContain('from file');
    expect(modalText()).toContain('streamed');
    expect(modalText()).not.toContain('more');
  });

  it('keeps appending live output through the post-terminal flush window', async () => {
    readFullOutput.mockResolvedValue({ lines: ['line 1'], truncated: false });

    await renderModal(makeTask());
    expect(modalText()).toContain('line 1');

    emitOutput(['streamed while running']);
    expect(modalText()).toContain('streamed while running');

    // The task finishes. The store keeps polling the output file for two more
    // seconds and those lines reach the card; an open modal must get them too.
    await renderModal(makeTask({ status: 'completed' }));
    emitOutput(['flushed after completion']);
    expect(modalText()).toContain('flushed after completion');
  });

  it('uses the shared task stop action with the host stop target', async () => {
    actions = {
      ...actions,
      stopTarget: (): BackgroundTaskStopRequest => ({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      }),
    };
    await renderModal(makeTask());

    const stop = document.querySelector<HTMLButtonElement>(
      '[data-testid="bg-process-detail-stop"]',
    );
    expect(stop?.getAttribute('aria-label')).toBe('Stop shell command');
    if (!stop) throw new Error('Expected a task stop button');

    await act(async () => {
      stop.click();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });

    expect(stopCommands).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      },
    ]);
  });

  it('offers no Stop when the host has no stop target for the task', async () => {
    actions = { ...actions, stopTarget: (): null => null };
    await renderModal(makeTask());

    expect(
      document.querySelector('[data-testid="bg-process-detail-stop"]'),
    ).toBeNull();
  });

  it('closes on Escape while its Stop button has focus', async () => {
    const onClose = jest.fn();
    actions = {
      ...actions,
      stopTarget: (): BackgroundTaskStopRequest => ({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        taskId: 'task-1',
      }),
    };
    await renderModal(makeTask(), onClose);
    const stop = document.querySelector<HTMLButtonElement>(
      '[data-testid="bg-process-detail-stop"]',
    );
    if (!stop) throw new Error('Expected a task stop button');

    act(() => {
      stop.focus();
      stop.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('re-reads the finished output file once the flush window closes', async () => {
    readFullOutput.mockResolvedValue({ lines: ['line 1'], truncated: false });
    await renderModal(makeTask());
    expect(readFullOutput).toHaveBeenCalledTimes(1);

    readFullOutput.mockResolvedValue({
      lines: ['line 1', 'final file tail'],
      truncated: false,
    });
    await renderModal(makeTask({ status: 'completed' }));
    expect(readFullOutput).toHaveBeenCalledTimes(1);

    await advanceFlushWindow();

    expect(readFullOutput).toHaveBeenCalledTimes(2);
    expect(modalText()).toContain('final file tail');
    // Polling has stopped by now, so the live subscription is released.
    expect(unsubscribeOutput).toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });

  it('never re-reads for a process that had already finished when opened', async () => {
    readFullOutput.mockResolvedValue({ lines: ['line 1'], truncated: false });

    await renderModal(makeTask({ status: 'completed' }));
    await advanceFlushWindow();

    expect(readFullOutput).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });

  it('falls back to the captured output and reports an unreadable file when the read rejects', async () => {
    readFullOutput.mockRejectedValue(new Error('path outside the temp root'));

    await renderModal(
      makeTask({ outputLines: ['captured line 1', 'captured line 2'] }),
    );

    expect(modalText()).toContain('captured line 1');
    expect(modalText()).toContain('captured line 2');
    expect(modalText()).toContain('Showing captured output only.');
    expect(modalText()).toContain("The output file couldn't be read.");
    expect(document.querySelector(OUTPUT_NOTICE)).not.toBeNull();
  });

  it('falls back to the captured output when the read comes back empty', async () => {
    readFullOutput.mockResolvedValue({ lines: [], truncated: false });

    await renderModal(makeTask({ outputLines: ['captured line 1'] }));

    expect(modalText()).toContain('captured line 1');
    expect(modalText()).not.toContain('No output available');
    expect(modalText()).toContain('Showing captured output only.');
  });

  it('keeps the empty state and stays quiet when neither source has output', async () => {
    readFullOutput.mockResolvedValue({ lines: [], truncated: false });

    await renderModal(makeTask({ outputLines: [] }));

    expect(modalText()).toContain('No output available');
    expect(modalText()).not.toContain('Showing captured output only.');
    expect(document.querySelector(OUTPUT_NOTICE)).toBeNull();
  });

  it('reads the output file once it becomes known', async () => {
    detail = { ...detail, outputSource: undefined };
    await renderModal(makeTask({ outputLines: ['captured line 1'] }));
    expect(readFullOutput).not.toHaveBeenCalled();
    expect(modalText()).toContain('captured line 1');

    readFullOutput.mockResolvedValue({
      lines: ['captured line 1', 'file line 2'],
      truncated: false,
    });
    detail = { ...detail, outputSource: OUTPUT_FILE };
    await renderModal(makeTask({ outputLines: ['captured line 1'] }));

    expect(readFullOutput).toHaveBeenCalledWith(OUTPUT_FILE);
    expect(modalText()).toContain('file line 2');
    expect(document.querySelector(OUTPUT_NOTICE)).toBeNull();
  });

  it('shows the loading state only until the first read resolves', async () => {
    let resolveRead: (value: BackgroundTaskFullOutput) => void = (): void => {};
    readFullOutput.mockImplementation(
      () =>
        new Promise<BackgroundTaskFullOutput>((resolve) => {
          resolveRead = resolve;
        }),
    );

    await renderModal(makeTask());
    expect(modalText()).toContain('Loading output…');

    act(() => {
      resolveRead({ lines: ['line 1'], truncated: false });
    });
    await flushReads();
    expect(modalText()).not.toContain('Loading output…');

    // The post-terminal re-read keeps the output on screen instead of
    // replacing it with a loader.
    await renderModal(makeTask({ status: 'completed' }));
    await advanceFlushWindow();
    expect(modalText()).not.toContain('Loading output…');
    expect(modalText()).toContain('line 1');
  });

  it('keeps the truncated note for a long output file', async () => {
    readFullOutput.mockResolvedValue({ lines: ['line 1'], truncated: true });

    await renderModal(makeTask());

    expect(modalText()).toContain('Showing the latest output only.');
    expect(modalText()).not.toContain('Showing captured output only.');
  });

  it('keeps the workflow view instead of the raw output stream', async () => {
    detail = { runId: 'wf-1' };
    await renderModal(makeTask({ kind: 'workflow' }));
    expect(
      document.querySelector('[data-testid="workflow-body"]'),
    ).not.toBeNull();
    expect(modalText()).toContain('Run ID');
    expect(modalText()).not.toContain('Output');
    expect(modalText()).not.toContain('No output available');
  });

  it('records the dialog but keeps the command, prompt, and summary out of session replay', async () => {
    detail = {
      ...detail,
      command: 'deploy --token secret-token',
      prompt: 'Summarize the customer notes',
    };
    await renderModal(makeTask({ summary: 'Deployed the private build' }));

    const card = document.querySelector(
      '[data-testid="bg-process-detail-modal"]',
    );
    expect(card?.classList.contains('ph-no-capture')).toBe(false);

    for (const sensitive of [
      'deploy --token secret-token',
      'Summarize the customer notes',
      'Deployed the private build',
    ]) {
      const node = Array.from(document.body.querySelectorAll('div')).find(
        (element) => element.textContent === sensitive,
      );
      expect(node?.closest('.ph-no-capture')).not.toBeNull();
    }

    const title = document.querySelector('h2');
    expect(title?.textContent).toBe('Build project');
  });
});
