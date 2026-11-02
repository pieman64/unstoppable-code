/** @jest-environment jsdom */
import type {
  BackgroundTaskStopOutcome,
  BackgroundTaskStopRequest,
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { BackgroundProcessesSectionBody } from '../BackgroundProcessesSectionBody';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const PROCESSES: readonly BackgroundTask[] = [
  {
    id: 'older-running',
    ownerToolUseId: 'tool-older-running',
    parentTaskId: null,
    startedAt: 1,
    settledAt: null,
    summary: null,
    lastDescription: null,
    kind: 'bash',
    title: 'Older running process',
    status: 'running',
    updatedAt: 100,
    outputLines: ['\u001b[32mPASS\u001b[0m older output'],
    canStop: true,
  },
  {
    id: 'completed',
    ownerToolUseId: 'tool-completed',
    parentTaskId: null,
    startedAt: 1,
    settledAt: null,
    lastDescription: null,
    kind: 'agent',
    title: 'Completed process',
    status: 'completed',
    updatedAt: 300,
    summary: 'Completed summary',
    outputLines: [],
    canStop: false,
  },
  {
    id: 'newer-running',
    ownerToolUseId: 'tool-newer-running',
    parentTaskId: null,
    startedAt: 1,
    settledAt: null,
    summary: null,
    kind: 'workflow',
    title: 'Newer running process',
    lastDescription: 'Reviewing the extraction',
    status: 'running',
    updatedAt: 200,
    outputLines: ['Workflow output is hidden'],
    canStop: true,
  },
];

function stopTarget(task: BackgroundTask): BackgroundTaskStopRequest {
  return {
    projectId: 'project-one',
    worktreeId: 'worktree-one',
    chatId: 'chat-one',
    taskId: `task-${task.id}`,
  };
}

function createFakeClient(backgroundTaskStop?: boolean): CanopyClient {
  const capabilities: CanopyCapabilities = {
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'read-only',
    routing: 'url',
    overviewNotifications: true,
    ...(backgroundTaskStop === undefined ? {} : { backgroundTaskStop }),
  };

  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    void args;
    if (name === 'activity.stopBackgroundTask') {
      return Promise.resolve<BackgroundTaskStopOutcome>('stopped');
    }
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }

  const client: CanopyClient = {
    capabilities,
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

  return client;
}

interface MountedClientTree {
  readonly container: HTMLDivElement;
  readonly render: (children: JSX.Element) => void;
  readonly unmount: () => void;
}

function mountWithClient(
  client: CanopyClient,
  children: JSX.Element,
): MountedClientTree {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (nextChildren: JSX.Element): void => {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          {nextChildren}
        </CanopyClientProvider>,
      );
    });
  };
  render(children);
  return {
    container,
    render,
    unmount: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function body(
  tasks: readonly BackgroundTask[] = PROCESSES,
  options: {
    readonly stopTarget?: (
      task: BackgroundTask,
    ) => BackgroundTaskStopRequest | null;
    readonly onOpenDetail?: (task: BackgroundTask) => void;
  } = {},
): JSX.Element {
  return (
    <BackgroundProcessesSectionBody
      tasks={tasks}
      stopTarget={options.stopTarget}
      onOpenDetail={options.onOpenDetail ?? jest.fn()}
    />
  );
}

describe('BackgroundProcessesSectionBody', () => {
  it('blocks descriptions in session replay but records the kind and status', () => {
    // Descriptions fall back to the command or prompt.
    const mounted = mountWithClient(createFakeClient(), body());
    const leaf = (text: string): Element | undefined =>
      Array.from(mounted.container.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
    const blocked = (text: string): boolean =>
      leaf(text)?.closest(`.${REPLAY_BLOCK_CLASS}`) != null;

    expect(blocked('Newer running process')).toBe(true);
    expect(blocked('Reviewing the extraction')).toBe(true);
    expect(leaf('workflow')).toBeDefined();
    expect(blocked('workflow')).toBe(false);

    mounted.unmount();
  });

  it('sorts active rows, renders previews, and collapses terminal rows', () => {
    const mounted = mountWithClient(createFakeClient(), body());

    const rows = mounted.container.querySelectorAll(
      '[data-testid="activity-bg-item"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Newer running process');
    expect(rows[1]?.textContent).toContain('Older running process');
    expect(mounted.container.textContent).toContain('Reviewing the extraction');
    expect(mounted.container.textContent).toContain('older output');
    expect(mounted.container.textContent).not.toContain(
      'Workflow output is hidden',
    );
    expect(mounted.container.textContent).not.toContain('Completed process');
    expect(
      mounted.container.querySelector('[data-testid="activity-bg-body"]'),
    ).not.toBeNull();

    mounted.unmount();
  });

  it('opens rows by pointer and keyboard and stops without opening detail', () => {
    const onOpenDetail = jest.fn<void, [BackgroundTask]>();
    const mounted = mountWithClient(
      createFakeClient(true),
      body(PROCESSES, { stopTarget, onOpenDetail }),
    );

    const rows = mounted.container.querySelectorAll<HTMLElement>(
      '[data-testid="activity-bg-item"]',
    );
    const stops = mounted.container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="activity-bg-stop"]',
    );
    expect(stops).toHaveLength(2);
    expect(stops[0]?.getAttribute('aria-label')).toBe('Stop workflow');
    expect(stops[1]?.getAttribute('aria-label')).toBe('Stop shell command');
    expect(stops[1]?.textContent).toBe('Stop');

    act(() => rows[1]?.click());
    expect(onOpenDetail).toHaveBeenCalledWith(PROCESSES[0]);

    act(() => {
      rows[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
      );
    });
    expect(onOpenDetail).toHaveBeenCalledWith(PROCESSES[2]);

    // Enter on Stop presses Stop; it must not reach the card's own handler.
    const keyDown = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    act(() => {
      stops[1]?.dispatchEvent(keyDown);
    });
    expect(keyDown.defaultPrevented).toBe(false);
    expect(onOpenDetail).toHaveBeenCalledTimes(2);

    act(() => stops[1]?.click());
    expect(stops[1]?.textContent).toBe('Stopping…');
    expect(stops[1]?.disabled).toBe(true);
    expect(onOpenDetail).toHaveBeenCalledTimes(2);

    mounted.unmount();
  });

  it('shows Stop only for tasks the host can address', () => {
    const mounted = mountWithClient(createFakeClient(true), body());

    expect(
      mounted.container.querySelector('[data-testid="activity-bg-stop"]'),
    ).toBeNull();

    mounted.render(
      body(PROCESSES, {
        stopTarget: (task) =>
          task.id === 'older-running' ? null : stopTarget(task),
      }),
    );
    const stops = mounted.container.querySelectorAll(
      '[data-testid="activity-bg-stop"]',
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]?.getAttribute('aria-label')).toBe('Stop workflow');

    mounted.unmount();
  });

  it('does not show Stop for terminal processes', () => {
    const terminalTask: BackgroundTask = {
      id: 'terminal',
      ownerToolUseId: 'tool-terminal',
      parentTaskId: null,
      startedAt: 1,
      settledAt: 300,
      lastDescription: null,
      summary: null,
      kind: 'agent',
      title: 'Completed process',
      status: 'completed',
      updatedAt: 300,
      outputLines: [],
      canStop: true,
    };
    const mounted = mountWithClient(
      createFakeClient(true),
      body([terminalTask], { stopTarget }),
    );

    act(() => {
      mounted.container
        .querySelector<HTMLButtonElement>(
          '[data-testid="activity-bg-stopped-toggle"]',
        )
        ?.click();
    });
    expect(
      mounted.container.querySelector('[data-testid="activity-bg-stop"]'),
    ).toBeNull();

    mounted.unmount();
  });

  it('does not show Stop when the host capability is unset', () => {
    const mounted = mountWithClient(
      createFakeClient(),
      body(PROCESSES, { stopTarget }),
    );

    expect(
      mounted.container.querySelector('[data-testid="activity-bg-stop"]'),
    ).toBeNull();

    mounted.unmount();
  });

  it('expands terminal rows and returns no body for an empty list', () => {
    const onOpenDetail = jest.fn<void, [BackgroundTask]>();
    const mounted = mountWithClient(
      createFakeClient(),
      body(PROCESSES, { onOpenDetail }),
    );

    const toggle = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-bg-stopped-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(mounted.container.textContent).toContain('Completed process');
    expect(mounted.container.textContent).toContain('Completed summary');

    const rows = mounted.container.querySelectorAll<HTMLElement>(
      '[data-testid="activity-bg-item"]',
    );
    act(() => {
      rows[2]?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: ' ' }),
      );
    });
    expect(onOpenDetail).toHaveBeenCalledWith(PROCESSES[1]);

    mounted.render(body([]));
    expect(mounted.container.childElementCount).toBe(0);

    mounted.unmount();
  });
});
