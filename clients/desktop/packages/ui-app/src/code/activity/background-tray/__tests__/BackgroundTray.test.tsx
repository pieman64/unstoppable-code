/** @jest-environment jsdom */
/**
 * The composer's background drawer (turn-state phase 39a, D15; background
 * drawer D5, D7, D10): a section of the composer drawer, one line while
 * collapsed, grouped rows in a capped list when expanded, absent while
 * nothing runs.
 */
import type {
  BackgroundTaskStopOutcome,
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import type {
  BackgroundTaskHostActions,
  BackgroundWorkflowProgress,
} from '../../background-tasks-section';
import type { BackgroundTrayAgent } from '../AgentRow';
import { BackgroundTray, type BackgroundTrayRun } from '../BackgroundTray';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
// jsdom has no CSS.escape or Element.scrollTo; the job bar centres its
// running job with them.
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = (): void => undefined;
}

const SCOPE = { projectId: 'project-one', worktreeId: 'worktree-one' };

function task(
  over: Partial<BackgroundTask> & Pick<BackgroundTask, 'id' | 'kind' | 'title'>,
): BackgroundTask {
  return {
    status: 'running',
    ownerToolUseId: `tool-${over.id}`,
    parentTaskId: null,
    startedAt: null,
    settledAt: null,
    updatedAt: 100,
    lastDescription: null,
    summary: null,
    outputLines: [],
    canStop: true,
    ...over,
  };
}

const ITEMS: readonly BackgroundTask[] = [
  task({ id: 'server', kind: 'bash', title: 'npm run dev' }),
  task({ id: 'review', kind: 'agent', title: 'Review the diff' }),
  task({
    id: 'done',
    kind: 'workflow',
    title: 'Finished workflow',
    status: 'completed',
    canStop: false,
  }),
];

function agent(
  over: Partial<BackgroundTrayAgent> &
    Pick<BackgroundTrayAgent, 'id' | 'kind' | 'title'>,
): BackgroundTrayAgent {
  return {
    status: 'running',
    activity: null,
    startedAt: null,
    steps: [],
    prompt: null,
    meta: null,
    taskId: null,
    canStop: over.kind === 'delegate',
    target: {
      kind:
        over.kind === 'delegate'
          ? 'managed'
          : over.kind === 'codex'
            ? 'codex-native'
            : 'claude-native',
      id: over.id,
      title: over.title,
    },
    ...over,
  };
}

const DELEGATES: readonly BackgroundTrayAgent[] = [
  agent({ id: 'managed:d1', kind: 'delegate', title: 'Fix flaky e2e' }),
  agent({ id: 'managed:d2', kind: 'delegate', title: 'Draft release notes' }),
];

/** Desktop-like actions: Stop for every task, nothing else. */
const STOP_ACTIONS: BackgroundTaskHostActions = {
  stopTarget: (item) => ({
    ...SCOPE,
    chatId: 'chat-one',
    taskId: `task-${item.id}`,
  }),
};

function createFakeClient(): CanopyClient {
  const capabilities: CanopyCapabilities = {
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'read-only',
    routing: 'url',
    overviewNotifications: true,
    backgroundTaskStop: true,
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
  return {
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
}

function run(
  id: string,
  name: string,
  status: BackgroundTrayRun['status'],
  overrides: Partial<BackgroundTrayRun> = {},
): BackgroundTrayRun {
  return {
    id,
    kind: 'pipeline',
    name,
    status,
    startedAt: null,
    dag: null,
    question: null,
    repository: null,
    ...overrides,
  };
}

const RUNS: readonly BackgroundTrayRun[] = [
  run('r-run', 'Build', 'running'),
  run('r-done', 'Lint', 'failed'),
  run('r-paused', 'Deploy', 'paused'),
  run('r-input', 'Review', 'needs-input'),
];

const DAG: BackgroundTrayRun['dag'] = {
  tiers: [['plan'], ['unit', 'e2e']],
  jobs: {
    plan: { jobId: 'plan', name: 'Plan', status: 'success' },
    unit: { jobId: 'unit', name: 'Unit tests', status: 'running' },
    e2e: { jobId: 'e2e', name: 'E2E', status: 'pending' },
  },
};

describe('BackgroundTray', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(ui: JSX.Element): void {
    act(() => {
      root.render(
        <CanopyClientProvider client={createFakeClient()}>
          {ui}
        </CanopyClientProvider>,
      );
    });
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  it('is absent while nothing runs in the background', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[ITEMS[2]]}
      />,
    );
    expect(byTestId('background-tray')).toBeNull();
  });

  it('collapses to one line: the background glyph, a summary and one icon per kind', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={ITEMS}
        agents={DELEGATES}
      />,
    );
    expect(byTestId('background-tray-summary')?.textContent).toBe(
      '4 running in the background',
    );
    expect(
      byTestId('background-tray')?.querySelector(
        '[role="img"][aria-label="4 background tasks running"]',
      ),
    ).toBeInstanceOf(HTMLElement);
    // Delegates count as agents; the finished workflow is not listed.
    expect(byTestId('background-tray-kind-agent')?.textContent).toBe('3');
    expect(byTestId('background-tray-kind-bash')?.textContent).toBe('');
    expect(byTestId('background-tray-kind-workflow')).toBeNull();
    expect(byTestId('background-tray-rows')).toBeNull();
    expect(
      byTestId('background-tray-toggle')?.getAttribute('aria-expanded'),
    ).toBe('false');
    // A section of the composer drawer, with no surface of its own; the
    // chevron points up, the way the drawer opens.
    expect(
      byTestId('background-tray')?.parentElement?.hasAttribute(
        'data-composer-drawer-section',
      ),
    ).toBe(true);
    expect(byTestId('background-tray')?.parentElement?.className).not.toMatch(
      /\b(bg-|ring|rounded)/,
    );
    expect(
      byTestId('background-tray-toggle')?.getAttribute('data-chevron'),
    ).toBe('up');
  });

  it('opens from its summary as well as its chevron, and Esc closes it', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={ITEMS}
      />,
    );
    act(() => byTestId('background-tray-header')?.click());
    expect(byTestId('background-tray-rows')).toBeInstanceOf(HTMLElement);
    expect(
      byTestId('background-tray-toggle')?.getAttribute('data-chevron'),
    ).toBe('down');
    // The open list names every item, so the kind icons step aside.
    expect(byTestId('background-tray-kind-bash')).toBeNull();

    // Esc closes the list and goes no further than the drawer.
    const outside = jest.fn();
    document.addEventListener('keydown', outside);
    try {
      act(() => {
        byTestId('background-tray-toggle')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
    } finally {
      document.removeEventListener('keydown', outside);
    }
    expect(byTestId('background-tray-rows')).toBeNull();
    expect(outside).not.toHaveBeenCalled();
    expect(byTestId('background-tray-kind-bash')).toBeInstanceOf(HTMLElement);
  });

  it('keeps the composer cancel shortcut out of the open drawer', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={ITEMS}
      />,
    );
    const ignored = (testId: string): boolean =>
      byTestId(testId)?.closest('[data-chat-cancel-shortcut-ignore]') != null;
    // Closed, Esc on the drawer is the composer's (cancel a running turn).
    expect(ignored('background-tray-toggle')).toBe(false);
    act(() => byTestId('background-tray-toggle')?.click());
    // Open, the drawer owns Esc: the desktop's capture-phase cancel
    // shortcut skips targets inside it.
    expect(ignored('background-tray-toggle')).toBe(true);
    expect(ignored('background-tray-rows')).toBe(true);
  });

  it('closes on Esc from a row action and returns focus to the toggle', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[]}
        runs={RUNS}
        onRespondRun={jest.fn()}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    const respond = byTestId('background-tray-run-r-input-respond');
    if (!respond) throw new Error('Missing Respond');
    respond.focus();
    act(() => {
      respond.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(byTestId('background-tray-rows')).toBeNull();
    expect(document.activeElement).toBe(byTestId('background-tray-toggle'));
  });

  it('expands to one row per item, with Stop on running tasks and Stop all for delegates', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={ITEMS}
        agents={DELEGATES}
        onStopAllDelegations={(): Promise<boolean> => Promise.resolve(true)}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    const rows = byTestId('background-tray-rows');
    expect(
      rows?.querySelectorAll('[data-testid="background-tray-row"]'),
    ).toHaveLength(2);
    expect(rows?.textContent).toContain('npm run dev');
    expect(rows?.textContent).toContain('Review the diff');
    expect(rows?.textContent).not.toContain('Finished workflow');
    expect(
      rows?.querySelectorAll('[data-testid="background-tray-row-stop"]'),
    ).toHaveLength(2);
    expect(
      rows?.querySelectorAll('[data-testid="background-tray-agent"]'),
    ).toHaveLength(2);
    expect(byTestId('background-tray-stop-all')).toBeInstanceOf(HTMLElement);
    expect(
      byTestId('background-tray-toggle')?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('drops an open Stop all question when the tray moves to another chat', () => {
    const stopChatOne = jest.fn((): Promise<boolean> => Promise.resolve(true));
    const stopChatTwo = jest.fn((): Promise<boolean> => Promise.resolve(true));
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[]}
        agents={DELEGATES}
        onStopAllDelegations={stopChatOne}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    act(() => byTestId('background-tray-stop-all')?.click());
    expect(byTestId('background-tray-stop-all-confirm')).toBeInstanceOf(
      HTMLElement,
    );
    render(
      <BackgroundTray
        chatId="chat-two"
        taskActions={STOP_ACTIONS}
        tasks={[]}
        agents={DELEGATES}
        onStopAllDelegations={stopChatTwo}
      />,
    );
    // The question was asked about chat one; chat two's delegates are untouched.
    expect(byTestId('background-tray-stop-all-confirm')).toBeNull();
    expect(stopChatTwo).not.toHaveBeenCalled();
  });

  it('marks running work by its kind and a shimmering name, not a spinner', () => {
    render(
      <BackgroundTray chatId="chat-one" tasks={ITEMS} agents={DELEGATES} />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    const rows = byTestId('background-tray-rows');
    const running = Array.from(
      rows?.querySelectorAll<HTMLElement>(
        '[data-testid="background-tray-row"], [data-testid="background-tray-agent"]',
      ) ?? [],
    );
    expect(running).toHaveLength(4);
    for (const row of running) {
      expect(row.querySelector('[data-status-glyph-state]')).toBeNull();
      expect(row.querySelector('.canopy-text-shimmer-strong')).not.toBeNull();
    }
  });

  it('offers Stop all background work once two listed items can stop (B6)', () => {
    const stopAll = jest.fn((): Promise<boolean> => Promise.resolve(true));
    const stoppableShell = task({
      id: 'shell',
      kind: 'bash',
      title: 'npm test',
    });
    const fixedShell = task({
      id: 'fixed',
      kind: 'bash',
      title: 'tail -f log',
      canStop: false,
    });
    const agentTask = task({
      id: 'agent-task',
      kind: 'agent',
      title: 'Review',
    });
    const claudeAgent = agent({
      id: 'claude:review',
      kind: 'claude',
      title: 'Review',
      taskId: 'agent-task',
    });
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[stoppableShell, fixedShell]}
        onStopAllBackgroundWork={stopAll}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    expect(byTestId('background-tray-stop-all-work')).toBeNull();

    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[stoppableShell, fixedShell, agentTask]}
        agents={[claudeAgent]}
        onStopAllBackgroundWork={stopAll}
      />,
    );
    const control = byTestId('background-tray-stop-all-work');
    expect(control?.textContent).toBe('Stop all background work');
    act(() => control?.click());
    expect(
      byTestId('background-tray-stop-all-work-confirmation')?.textContent,
    ).toContain('Stop 2 background tasks?');
    expect(stopAll).not.toHaveBeenCalled();
    act(() => byTestId('background-tray-stop-all-work-confirm')?.click());
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('offers no Stop all background work without the host action or a stop target', () => {
    const tasks = [
      task({ id: 'one', kind: 'bash', title: 'one' }),
      task({ id: 'two', kind: 'bash', title: 'two' }),
    ];
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={tasks}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    expect(byTestId('background-tray-stop-all-work')).toBeNull();
    render(
      <BackgroundTray
        chatId="chat-one"
        tasks={tasks}
        onStopAllBackgroundWork={(): Promise<boolean> => Promise.resolve(true)}
      />,
    );
    expect(byTestId('background-tray-stop-all-work')).toBeNull();
  });

  it('drops an open Stop all background work question when the chat changes', () => {
    const stopChatTwo = jest.fn((): Promise<boolean> => Promise.resolve(true));
    const tasks = [
      task({ id: 'one', kind: 'bash', title: 'one' }),
      task({ id: 'two', kind: 'bash', title: 'two' }),
    ];
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={tasks}
        onStopAllBackgroundWork={(): Promise<boolean> => Promise.resolve(true)}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    act(() => byTestId('background-tray-stop-all-work')?.click());
    expect(
      byTestId('background-tray-stop-all-work-confirmation'),
    ).toBeInstanceOf(HTMLElement);
    render(
      <BackgroundTray
        chatId="chat-two"
        taskActions={STOP_ACTIONS}
        tasks={tasks}
        onStopAllBackgroundWork={stopChatTwo}
      />,
    );
    expect(byTestId('background-tray-stop-all-work-confirmation')).toBeNull();
    expect(stopChatTwo).not.toHaveBeenCalled();
  });

  it('caps the open list, which scrolls past the cap while the header stays', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={ITEMS}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    const rows = byTestId('background-tray-rows');
    expect(rows?.className).toContain(
      'max-h-[var(--background-drawer-list-max)]',
    );
    expect(
      rows?.closest('[class*="--background-drawer-list-max:min(22rem,45vh)"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      byTestId('background-tray-toggle')?.getAttribute('aria-controls'),
    ).toBe(rows?.id);
    // One group: no label.
    expect(byTestId('background-tray-group-label')).toBeNull();
  });

  it('summarizes pipeline runs by what they need, in priority order', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[ITEMS[0]]}
        runs={RUNS}
      />,
    );
    expect(byTestId('background-tray-summary')?.textContent).toBe(
      '2 running in the background · 1 needs input · 1 paused · 1 finished',
    );
    const pipelines = byTestId('background-tray-kind-pipeline');
    expect(pipelines?.textContent).toBe('4');
    // Waiting for input outranks a failure on the kind's corner dot.
    expect(pipelines?.getAttribute('data-dot')).toBe('needs-input');
  });

  it('groups rows as Needs you, Running and Finished, each with its action', () => {
    const onStopRun = jest.fn();
    const onRespondRun = jest.fn();
    const onResumeRun = jest.fn();
    const onDismissRun = jest.fn();
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[ITEMS[0]]}
        runs={RUNS}
        onStopRun={onStopRun}
        onRespondRun={onRespondRun}
        onResumeRun={onResumeRun}
        onDismissRun={onDismissRun}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    const order = Array.from(
      byTestId('background-tray-rows')?.querySelectorAll('[data-tray-row]') ??
        [],
    ).map((row) => row.getAttribute('data-tray-row'));
    expect(order).toEqual([
      'run:r-input',
      'run:r-paused',
      'task:server',
      'run:r-run',
      'run:r-done',
    ]);
    // Groups in order, each with a sticky label while there is more than one.
    const labels = Array.from(
      container.querySelectorAll('[data-testid="background-tray-group-label"]'),
    );
    expect(labels.map((label) => label.textContent)).toEqual([
      'Needs you',
      'Running',
      'Finished',
    ]);
    expect(labels.every((label) => label.className.includes('sticky'))).toBe(
      true,
    );
    expect(
      Array.from(
        byTestId('background-tray-rows')?.querySelectorAll(
          '[data-tray-group]',
        ) ?? [],
      ).map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Needs you', 'Running', 'Finished']);
    act(() => byTestId('background-tray-run-r-run-stop')?.click());
    act(() => byTestId('background-tray-run-r-input-respond')?.click());
    act(() => byTestId('background-tray-run-r-paused-resume')?.click());
    act(() => byTestId('background-tray-run-r-done-dismiss')?.click());
    expect(onStopRun).toHaveBeenCalledWith('r-run');
    expect(onRespondRun).toHaveBeenCalledWith('r-input');
    expect(onResumeRun).toHaveBeenCalledWith('r-paused');
    expect(onDismissRun).toHaveBeenCalledWith('r-done');
  });

  it('stays for a finished run until it is dismissed, led by its result', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[]}
        runs={[run('r-done', 'Lint', 'failed')]}
      />,
    );
    expect(byTestId('background-tray-summary')?.textContent).toBe('1 finished');
    expect(byTestId('background-tray-dot')?.getAttribute('data-tone')).toBe(
      'failed',
    );
  });

  it('leads with the needs-input dot when nothing runs but a run waits', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[]}
        runs={[
          run('r-done', 'Lint', 'succeeded'),
          run('r-input', 'Review', 'needs-input'),
        ]}
      />,
    );
    expect(byTestId('background-tray-summary')?.textContent).toBe(
      '1 needs input · 1 finished',
    );
    expect(byTestId('background-tray-dot')?.getAttribute('data-tone')).toBe(
      'needs-input',
    );
  });

  describe('runs (D1b, D6)', () => {
    const GITHUB_RUN = run('gh-ci', 'CI #42', 'running', {
      kind: 'github',
      dag: DAG,
      repository: 'acme/checkout',
      startedAt: 1_000,
    });

    it('shows its jobs as dots, its elapsed time, and its inspector', () => {
      const onOpenRun = jest.fn();
      const onRunJobClick = jest.fn();
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[]}
          runs={[
            run('r-run', 'Build', 'running', { dag: DAG, startedAt: 1_000 }),
          ]}
          onStopRun={jest.fn()}
          onOpenRun={onOpenRun}
          onRunJobClick={onRunJobClick}
          renderRunWatcher={(item): JSX.Element => (
            <span data-testid="run-watcher">{item.id}</span>
          )}
        />,
      );
      act(() => byTestId('background-tray-toggle')?.click());
      const row = byTestId('background-tray-run-r-run');
      expect(
        row?.querySelectorAll(
          '[data-testid="dag-progress-dots"] [data-status-glyph-state]',
        ),
      ).toHaveLength(3);
      expect(row?.textContent).toMatch(/\d+[smh]/);
      expect(byTestId('run-watcher')).toBeNull();
      act(() =>
        row
          ?.querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
      const inspector = byTestId('background-tray-inspector');
      // One row per job (glyph, name, time), the watcher and Open run.
      expect(inspector?.querySelectorAll('[data-job-id]')).toHaveLength(3);
      expect(byTestId('run-watcher')?.textContent).toBe('r-run');
      expect(
        inspector?.querySelector('[data-job-id="unit"]')?.textContent,
      ).toBe('Unit tests');
      expect(
        inspector
          ?.querySelector('[data-job-id="unit"]')
          ?.closest('li')
          ?.getAttribute('data-job-state'),
      ).toBe('running');
      act(() =>
        inspector?.querySelector<HTMLElement>('[data-job-id="unit"]')?.click(),
      );
      expect(onRunJobClick).toHaveBeenCalledWith('r-run', 'unit');
      const open = byTestId('background-tray-inspector-open');
      expect(open?.textContent).toBe('Open run');
      act(() => open?.click());
      expect(onOpenRun).toHaveBeenCalledWith('r-run');
    });

    it('shows the question a run waits on, three lines at most', () => {
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[]}
          runs={[
            run('r-input', 'Review', 'needs-input', {
              question: 'Approve the plan before Apply runs',
            }),
          ]}
          onRespondRun={jest.fn()}
        />,
      );
      act(() => byTestId('background-tray-toggle')?.click());
      act(() => byTestId('background-tray-row-toggle')?.click());
      const question = byTestId('background-tray-run-question');
      expect(question?.textContent).toBe('Approve the plan before Apply runs');
      expect(question?.className).toContain('line-clamp-3');
      // Content, so replay blocks it; no Open run without a host to open it.
      expect(question?.className).toContain(REPLAY_BLOCK_CLASS);
      expect(byTestId('background-tray-inspector-open')).toBeNull();
    });

    it('offers Stop on a waiting or paused run where the host has no Respond or Resume', () => {
      const onStopRun = jest.fn();
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[]}
          runs={[
            run('r-input', 'Review', 'needs-input'),
            run('r-paused', 'Deploy', 'paused'),
          ]}
          onStopRun={onStopRun}
        />,
      );
      act(() => byTestId('background-tray-toggle')?.click());
      act(() => byTestId('background-tray-run-r-input-stop')?.click());
      act(() => byTestId('background-tray-run-r-paused-stop')?.click());
      expect(onStopRun.mock.calls).toEqual([['r-input'], ['r-paused']]);
    });

    it('shows a run that ended without a confirmed success as Completed', () => {
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[]}
          runs={[{ ...GITHUB_RUN, status: 'completed' }]}
          onDismissRun={jest.fn()}
        />,
      );
      expect(byTestId('background-tray-summary')?.textContent).toBe(
        '1 finished',
      );
      // Neither the success nor the failure dot.
      expect(byTestId('background-tray-dot')?.getAttribute('data-tone')).toBe(
        'completed',
      );
      act(() => byTestId('background-tray-toggle')?.click());
      const labelClasses = Array.from(
        byTestId('background-tray-run-gh-ci')?.querySelectorAll('span') ?? [],
      )
        .filter((span) => span.textContent === 'Completed')
        .map((span) => span.className);
      // Uncoloured, unlike Succeeded and Failed.
      expect(labelClasses.length).toBeGreaterThan(0);
      for (const className of labelClasses) {
        expect(className).not.toContain(
          OPERATIONAL_STATUS_COLORS.success.foreground,
        );
        expect(className).not.toContain(
          OPERATIONAL_STATUS_COLORS.failed.foreground,
        );
      }
      expect(byTestId('background-tray-run-gh-ci-dismiss')).not.toBeNull();
    });

    it('lists a GitHub run without Stop, with its repository and Open on GitHub', () => {
      const onDismissRun = jest.fn();
      const props = {
        chatId: 'chat-one',
        tasks: [],
        onStopRun: jest.fn(),
        onDismissRun,
        onOpenRun: jest.fn(),
      };
      render(<BackgroundTray {...props} runs={[GITHUB_RUN]} />);
      expect(byTestId('background-tray-kind-github')?.textContent).toBe('');
      expect(byTestId('background-tray-kind-pipeline')).toBeNull();
      act(() => byTestId('background-tray-toggle')?.click());
      expect(byTestId('background-tray-run-gh-ci-stop')).toBeNull();
      act(() => byTestId('background-tray-row-toggle')?.click());
      const inspector = byTestId('background-tray-inspector');
      expect(inspector?.textContent).toContain(
        'acme/checkout · Unit tests running',
      );
      expect(
        Array.from(
          inspector?.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`) ?? [],
          (element) => element.textContent,
        ),
      ).toContain('acme/checkout');
      expect(byTestId('background-tray-inspector-open')?.textContent).toBe(
        'Open on GitHub',
      );
      // Finished, it waits to be dismissed.
      render(
        <BackgroundTray
          {...props}
          runs={[{ ...GITHUB_RUN, status: 'succeeded' }]}
        />,
      );
      act(() => byTestId('background-tray-run-gh-ci-dismiss')?.click());
      expect(onDismissRun).toHaveBeenCalledWith('gh-ci');
    });
  });

  it('keeps run titles and jobs out of session replay, and its action labels generic', () => {
    render(
      <BackgroundTray
        chatId="chat-one"
        tasks={[]}
        onStopRun={jest.fn()}
        onDismissRun={jest.fn()}
        runs={[
          run('gh-ci', 'CI #42', 'running', {
            kind: 'github',
            dag: DAG,
            repository: 'acme/checkout',
          }),
          run('pr-12', '#12 Secret fix', 'succeeded', {
            kind: 'github-pr',
            statusLabel: 'Merged',
            repository: 'acme/api',
          }),
          run('r-run', 'Private deploy', 'running', { dag: DAG }),
        ]}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    const ci = byTestId('background-tray-run-gh-ci');
    // A title is masked, its jobs (names in labels and tooltips) blocked.
    expect(ci?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'CI #42',
    );
    expect(
      ci
        ?.querySelector('[data-testid="dag-progress-dots"]')
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
    // No recorded attribute carries a title.
    const labels = Array.from(
      container.querySelectorAll('[aria-label]'),
      (element) => element.getAttribute('aria-label') ?? '',
    );
    expect(
      labels.filter((label) => /Secret|Private|CI #42/.test(label)),
    ).toEqual([]);
    expect(
      byTestId('background-tray-run-pr-12-dismiss')?.getAttribute('aria-label'),
    ).toBe('Dismiss pull request');
    expect(
      byTestId('background-tray-run-r-run-stop')?.getAttribute('aria-label'),
    ).toBe('Stop run');
  });

  describe('watched pull requests', () => {
    const PULL_REQUEST = run('pr-12', '#12 Fix checkout', 'running', {
      kind: 'github-pr',
      statusLabel: 'In merge queue',
      repository: 'acme/api',
      note: 'into develop · position 2 in the merge queue',
    });

    it('lists a watched pull request with its state, without Stop, and opens it on GitHub', () => {
      const onOpenRun = jest.fn();
      const onDismissRun = jest.fn();
      const props = {
        chatId: 'chat-one',
        tasks: [],
        onStopRun: jest.fn(),
        onOpenRun,
        onDismissRun,
      };
      render(
        <BackgroundTray
          {...props}
          runs={[PULL_REQUEST]}
          renderRunWatcher={(): JSX.Element => (
            <button type="button" data-testid="pr-watcher" />
          )}
        />,
      );
      expect(
        byTestId('background-tray-kind-github-pr')?.getAttribute('aria-label'),
      ).toBe('Pull requests: 1');
      act(() => byTestId('background-tray-toggle')?.click());
      const row = byTestId('background-tray-run-pr-12');
      expect(row?.textContent).toContain('#12 Fix checkout');
      expect(row?.textContent).toContain('In merge queue');
      expect(byTestId('background-tray-run-pr-12-stop')).toBeNull();
      act(() => byTestId('background-tray-row-toggle')?.click());
      expect(byTestId('background-tray-inspector')?.textContent).toContain(
        'acme/api · into develop · position 2 in the merge queue',
      );
      // With no job bar, its watcher ends the details line.
      expect(byTestId('pr-watcher')?.parentElement?.textContent).toContain(
        'acme/api · into develop',
      );
      act(() => byTestId('background-tray-inspector-open')?.click());
      expect(onOpenRun).toHaveBeenCalledWith('pr-12');
      expect(byTestId('background-tray-inspector-open')?.textContent).toBe(
        'Open on GitHub',
      );
      // Merged, it waits to be dismissed.
      render(
        <BackgroundTray
          {...props}
          runs={[
            { ...PULL_REQUEST, status: 'succeeded', statusLabel: 'Merged' },
          ]}
        />,
      );
      expect(byTestId('background-tray-run-pr-12')?.textContent).toContain(
        'Merged',
      );
      // Merged has its own intent, not success.
      expect(
        Array.from(
          byTestId('background-tray-run-pr-12')?.querySelectorAll('span') ?? [],
        )
          .filter((span) => span.textContent === 'Merged')
          .pop()?.className,
      ).toBe(OPERATIONAL_STATUS_COLORS.merged.foreground);
      act(() => byTestId('background-tray-run-pr-12-dismiss')?.click());
      expect(onDismissRun).toHaveBeenCalledWith('pr-12');
    });
  });

  it('asks before stopping every delegate', async () => {
    const stopAll = jest.fn((): Promise<boolean> => Promise.resolve(true));
    render(
      <BackgroundTray
        chatId="chat-one"
        taskActions={STOP_ACTIONS}
        tasks={[]}
        agents={DELEGATES}
        onStopAllDelegations={stopAll}
      />,
    );
    act(() => byTestId('background-tray-toggle')?.click());
    act(() => byTestId('background-tray-stop-all')?.click());
    expect(byTestId('background-tray')?.textContent).toContain(
      'Stop 2 delegations?',
    );
    expect(stopAll).not.toHaveBeenCalled();
    await act(async () => {
      byTestId('background-tray-stop-all-confirm')?.click();
      await Promise.resolve();
    });
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  describe('inspectors (D6)', () => {
    // Elapsed labels read the clock at render; pin it so slow shards can't drift.
    const NOW = Date.parse('2026-08-30T00:00:00.000Z');
    let clock: jest.SpyInstance<number, []>;
    beforeEach(() => {
      clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });
    afterEach(() => clock.mockRestore());

    const SHELL = task({
      id: 'server',
      kind: 'bash',
      title: 'Dev server',
      startedAt: NOW - 65_000,
      outputLines: ['ready in 120ms', 'listening on :5173'],
    });
    const AGENT = task({
      id: 'review',
      kind: 'agent',
      title: 'Review the diff',
      lastDescription: 'Reading validation.ts',
    });

    function row(title: string): HTMLElement {
      const match = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="background-tray-row"]',
        ),
      ).find((element) => element.textContent?.includes(title));
      if (!match) throw new Error(`No row for ${title}`);
      return match;
    }
    function toggleRow(title: string): void {
      act(() =>
        row(title)
          .querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
    }
    function inspectors(): HTMLElement[] {
      return Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="background-tray-inspector"]',
        ),
      );
    }
    function open(
      tasks: readonly BackgroundTask[],
      actions?: BackgroundTaskHostActions,
    ): void {
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={tasks}
          taskActions={actions}
        />,
      );
      act(() => byTestId('background-tray-toggle')?.click());
    }

    it('opens one row at a time, and closes when its item leaves', () => {
      open([SHELL, AGENT], STOP_ACTIONS);
      toggleRow('Dev server');
      expect(inspectors()).toHaveLength(1);
      expect(row('Dev server').contains(inspectors()[0] ?? null)).toBe(true);
      toggleRow('Review the diff');
      expect(inspectors()).toHaveLength(1);
      expect(row('Review the diff').contains(inspectors()[0] ?? null)).toBe(
        true,
      );

      // The open item leaves the drawer: its inspector goes with it, and it
      // stays closed if the item comes back.
      render(<BackgroundTray chatId="chat-one" tasks={[SHELL]} />);
      expect(inspectors()).toHaveLength(0);
      render(<BackgroundTray chatId="chat-one" tasks={[SHELL, AGENT]} />);
      expect(inspectors()).toHaveLength(0);
    });

    it("never repeats a task's name as what it is doing", () => {
      open([
        task({
          id: 'echo',
          kind: 'agent',
          title: 'Review the diff',
          lastDescription: 'Review the diff',
        }),
      ]);
      expect(
        row('Review the diff').textContent?.match(/Review the diff/g),
      ).toHaveLength(1);
    });

    it('is a disclosure button that names the inspector it controls', () => {
      open([SHELL]);
      const toggle = row('Dev server').querySelector<HTMLElement>(
        '[data-testid="background-tray-row-toggle"]',
      );
      expect(toggle?.tagName).toBe('BUTTON');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      toggleRow('Dev server');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.getAttribute('aria-controls')).toBe(inspectors()[0]?.id);
    });

    it('shows a shell command and its tail, and opens its output', () => {
      const onSelectedTaskChange = jest.fn();
      open([SHELL], {
        ...STOP_ACTIONS,
        getDetail: () => ({ command: 'pnpm run dev', outputSource: 'out' }),
        onSelectedTaskChange,
      });
      // Closed, the row shows the last output line and the elapsed time.
      // SHELL started 65s before this file loaded, so the seconds depend on
      // how long the earlier tests took.
      expect(row('Dev server').textContent).toContain('listening on :5173');
      // SHELL's start is fixed when the file loads, so earlier tests in the
      // file add a few seconds.
      expect(row('Dev server').textContent).toMatch(/1m \d+s/);
      toggleRow('Dev server');
      const inspector = inspectors()[0];
      expect(inspector?.textContent).toContain('$ pnpm run dev');
      expect(inspector?.textContent).toContain('ready in 120ms');
      // The tail keeps the Scripts and Hooks cap, within the list's.
      const tail = inspector?.querySelector<HTMLElement>(
        `.${REPLAY_BLOCK_CLASS} > div`,
      );
      expect(tail?.style.maxHeight).toContain('--background-drawer-list-max');
      act(() => byTestId('background-tray-inspector-open')?.click());
      expect(byTestId('background-tray-inspector-open')?.textContent).toBe(
        'Open output',
      );
      expect(onSelectedTaskChange).toHaveBeenCalledWith(SHELL);

      // With the modal open, Esc is the modal's, even with focus still on
      // the Open button: the drawer stays open.
      const openButton = byTestId('background-tray-inspector-open');
      act(() => {
        openButton?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(byTestId('background-tray-rows')).toBeInstanceOf(HTMLElement);
    });

    it("says where a shell's output is when the host has none", () => {
      // The Portal: no detail, no output stream, no Open.
      open([SHELL]);
      toggleRow('Dev server');
      expect(inspectors()[0]?.textContent).toContain(
        'Output shows in the desktop app.',
      );
      expect(byTestId('background-tray-inspector-open')).toBeNull();
    });

    it('keeps replay blocking on content, never on names of controls', () => {
      open([SHELL], {
        getDetail: () => ({ command: 'pnpm run dev' }),
      });
      toggleRow('Dev server');
      const command = Array.from(
        inspectors()[0]?.querySelectorAll('code') ?? [],
      )[0];
      expect(command?.className).toContain(REPLAY_BLOCK_CLASS);
      const buttons = Array.from(
        container.querySelectorAll('[data-testid="background-tray"] button'),
      );
      expect(
        buttons.filter((button) =>
          button.className.includes(REPLAY_BLOCK_CLASS),
        ),
      ).toEqual([]);
    });

    it('reads workflow progress only while its inspector is open', () => {
      const unsubscribe = jest.fn();
      let push: ((progress: BackgroundWorkflowProgress) => void) | undefined;
      const subscribeWorkflowProgress = jest.fn(
        (
          _task: BackgroundTask,
          onProgress: (p: BackgroundWorkflowProgress) => void,
        ) => {
          push = onProgress;
          return unsubscribe;
        },
      );
      const workflow = task({
        id: 'audit',
        kind: 'workflow',
        title: 'Audit checkout copy',
        lastDescription: 'Planning',
      });
      open([workflow], { subscribeWorkflowProgress });
      expect(subscribeWorkflowProgress).not.toHaveBeenCalled();
      expect(row('Audit checkout copy').textContent).toContain('Planning');
      toggleRow('Audit checkout copy');
      expect(subscribeWorkflowProgress).toHaveBeenCalledTimes(1);
      act(() =>
        push?.({
          phaseTitle: 'Review',
          phaseIndex: 1,
          phaseCount: 3,
          agents: [
            { id: 'a1', label: 'Header copy', state: 'done', activity: null },
            {
              id: 'a2',
              label: 'Error copy',
              state: 'running',
              activity: 'Reading errors.ts',
            },
          ],
        }),
      );
      const inspector = inspectors()[0];
      expect(
        inspector?.querySelector(
          '[data-status-glyph="running"] [data-spinner="comet"]',
        ),
      ).not.toBeNull();
      expect(inspector?.textContent).toContain(
        'Phase 2 of 3 · Review · 1 of 2 agents done',
      );
      expect(
        inspector?.querySelectorAll(
          '[data-testid="background-tray-workflow-agents"] li',
        ),
      ).toHaveLength(2);
      // Agent labels come from the conversation: replay never records them.
      const label = Array.from(
        inspector?.querySelectorAll(
          '[data-testid="background-tray-workflow-agents"] span',
        ) ?? [],
      ).find((element) => element.textContent === 'Error copy');
      expect(label?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeInstanceOf(
        HTMLElement,
      );
      // Agent lines keep the delegated agent card's cap, within the list's.
      expect(
        Array.from(inspector?.querySelectorAll('div') ?? []).some((element) =>
          element.className.includes('max-h-[min(12rem,'),
        ),
      ).toBe(true);
      toggleRow('Audit checkout copy');
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('keeps one workflow subscription while its task and host update', () => {
      const subscribeWorkflowProgress = jest.fn<
        () => void,
        [BackgroundTask, (progress: BackgroundWorkflowProgress) => void]
      >(() => (): void => {});
      const workflow = task({
        id: 'audit',
        kind: 'workflow',
        title: 'Audit checkout copy',
      });
      open([workflow], { subscribeWorkflowProgress });
      toggleRow('Audit checkout copy');
      expect(subscribeWorkflowProgress).toHaveBeenCalledTimes(1);

      // A progress event, and a host that rebuilt its actions for another
      // task's output: the same run, so no new read.
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[{ ...workflow, lastDescription: 'Phase 2', updatedAt: 200 }]}
          taskActions={{
            subscribeWorkflowProgress: (item, onProgress) =>
              subscribeWorkflowProgress(item, onProgress),
          }}
        />,
      );
      expect(subscribeWorkflowProgress).toHaveBeenCalledTimes(1);

      // The run becomes known: it is read.
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[workflow]}
          taskActions={{
            subscribeWorkflowProgress,
            getDetail: () => ({ runId: 'run-1' }),
          }}
        />,
      );
      expect(subscribeWorkflowProgress).toHaveBeenCalledTimes(2);
    });

    it('keeps an open detail modal, and its stream, when its task ends and nothing else runs', async () => {
      let push: ((lines: readonly string[]) => void) | undefined;
      const unsubscribe = jest.fn();
      const actions: BackgroundTaskHostActions = {
        ...STOP_ACTIONS,
        getDetail: () => ({
          command: 'pnpm run dev',
          outputSource: 'out',
          outputStreamKey: 'stream-server',
        }),
        readFullOutput: () =>
          Promise.resolve({ lines: ['ready in 120ms'], truncated: false }),
        subscribeOutput: (_key, onLines) => {
          push = onLines;
          return unsubscribe;
        },
      };
      const modal = (): Element | null =>
        document.querySelector('[data-testid="bg-process-detail-modal"]');
      open([SHELL], actions);
      toggleRow('Dev server');
      await act(async () => {
        byTestId('background-tray-inspector-open')?.click();
        await Promise.resolve();
      });
      const opened = modal();
      expect(opened).toBeInstanceOf(HTMLElement);

      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[{ ...SHELL, status: 'completed', canStop: false }]}
          taskActions={actions}
        />,
      );
      expect(byTestId('background-tray')).toBeNull();
      // The same modal, still streaming through the flush window: output
      // written just after the task ended still reaches it.
      expect(modal()).toBe(opened);
      expect(modal()?.textContent).toContain('completed');
      expect(unsubscribe).not.toHaveBeenCalled();
      act(() => push?.(['server stopped']));
      expect(modal()?.textContent).toContain('server stopped');
    });

    it('reveals an open row again when its inspector grows', () => {
      const observers = new Map<Element, () => void>();
      const original = globalThis.ResizeObserver;
      class FakeResizeObserver {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element): void {
          observers.set(target, () => this.callback([], this));
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      globalThis.ResizeObserver = FakeResizeObserver;
      try {
        open([SHELL, AGENT]);
        toggleRow('Review the diff');
        const list = byTestId('background-tray-rows');
        const openRow = row('Review the diff');
        if (!list) throw new Error('No list');
        let scrollTop = 0;
        Object.defineProperty(list, 'scrollTop', {
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = value;
          },
        });
        // Its inspector grew past the list's bottom edge.
        list.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 400, 100);
        openRow.getBoundingClientRect = (): DOMRect =>
          new DOMRect(0, 40, 400, 90);
        act(() => observers.get(openRow)?.());
        expect(scrollTop).toBe(30);
      } finally {
        // jsdom has none: remove the fake rather than leave `undefined`.
        if (original === undefined) {
          Reflect.deleteProperty(globalThis, 'ResizeObserver');
        } else {
          globalThis.ResizeObserver = original;
        }
      }
    });
  });

  describe('agents (D6)', () => {
    const REVIEWER_TASK = task({
      id: 'review-task',
      kind: 'agent',
      title: 'Review the diff',
    });
    const REVIEWER = agent({
      id: 'claude:tool-review',
      kind: 'claude',
      title: 'Review the diff',
      taskId: 'review-task',
      canStop: false,
      steps: [
        { id: 's1', toolName: 'Read', input: '{"file_path":"src/a.ts"}' },
        { id: 's2', toolName: 'Grep', input: '{"pattern":"validate"}' },
      ],
      meta: 'Claude · code-reviewer',
    });
    const CODEX = agent({
      id: 'codex:c1',
      kind: 'codex',
      title: 'Audit coupon rules',
      canStop: false,
      prompt: 'Audit the coupon rules for stacking bugs.',
    });

    function openWith(
      agents: readonly BackgroundTrayAgent[],
      props: Partial<Parameters<typeof BackgroundTray>[0]> = {},
    ): void {
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[REVIEWER_TASK]}
          taskActions={STOP_ACTIONS}
          agents={agents}
          {...props}
        />,
      );
      act(() => byTestId('background-tray-toggle')?.click());
    }
    function agentRow(title: string): HTMLElement {
      const match = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="background-tray-agent"]',
        ),
      ).find((element) => element.textContent?.includes(title));
      if (!match) throw new Error(`No agent row for ${title}`);
      return match;
    }

    it('lists each agent once, with its own Stop where the host has one', async () => {
      const onStopAgent = jest.fn(
        (): Promise<boolean> => Promise.resolve(true),
      );
      openWith([REVIEWER, CODEX, ...DELEGATES], { onStopAgent });
      // The Claude agent's own task is listed once, as the agent.
      expect(
        container.querySelectorAll('[data-testid="background-tray-row"]'),
      ).toHaveLength(0);
      expect(
        container.querySelectorAll('[data-testid="background-tray-agent"]'),
      ).toHaveLength(4);
      expect(byTestId('background-tray-summary')?.textContent).toBe(
        '4 running in the background',
      );
      // The Claude agent stops through its task; Codex children have none.
      expect(
        agentRow('Review the diff').querySelector(
          '[data-testid="background-tray-agent-stop"]',
        ),
      ).toBeInstanceOf(HTMLElement);
      expect(
        agentRow('Audit coupon rules').querySelector(
          '[data-testid="background-tray-agent-stop"]',
        ),
      ).toBeNull();
      // A delegate stops through the host, once.
      const stop = agentRow('Fix flaky e2e').querySelector<HTMLElement>(
        '[data-testid="background-tray-agent-stop"]',
      );
      await act(async () => {
        stop?.click();
        stop?.click();
        await Promise.resolve();
      });
      expect(onStopAgent).toHaveBeenCalledTimes(1);
      expect(onStopAgent).toHaveBeenCalledWith(DELEGATES[0]);
      expect(stop?.textContent).toBe('Stopping…');
    });

    it('opens an inspector with its steps, model and Open chat', () => {
      const onOpenAgent = jest.fn();
      openWith([REVIEWER, CODEX], { onOpenAgent });
      act(() =>
        agentRow('Review the diff')
          .querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
      const inspector = agentRow('Review the diff').querySelector(
        '[data-testid="background-tray-inspector"]',
      );
      expect(
        inspector?.querySelectorAll(
          '[data-testid="background-tray-agent-steps"] li',
        ),
      ).toHaveLength(2);
      expect(inspector?.textContent).toContain('Claude · code-reviewer');
      // Steps come from the conversation: replay never records them.
      expect(
        inspector?.querySelector('[data-testid="background-tray-agent-steps"]')
          ?.className,
      ).toContain(REPLAY_BLOCK_CLASS);
      act(() => byTestId('background-tray-inspector-open')?.click());
      expect(byTestId('background-tray-inspector-open')?.textContent).toBe(
        'Open chat',
      );
      expect(onOpenAgent).toHaveBeenCalledWith(REVIEWER.target);

      // An agent with no steps yet shows its prompt.
      act(() =>
        agentRow('Audit coupon rules')
          .querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
      expect(
        agentRow('Audit coupon rules').querySelector(
          '[data-testid="background-tray-inspector"]',
        )?.textContent,
      ).toContain('Audit the coupon rules for stacking bugs.');
    });

    it('keeps agent descriptions out of the attributes replay records', () => {
      openWith([REVIEWER, ...DELEGATES], {
        onStopAgent: (): Promise<boolean> => Promise.resolve(true),
      });
      const labels = Array.from(
        container.querySelectorAll(
          '[data-testid="background-tray"] [aria-label]',
        ),
      ).map((element) => element.getAttribute('aria-label') ?? '');
      for (const title of ['Review the diff', 'Fix flaky e2e']) {
        expect(labels.filter((label) => label.includes(title))).toEqual([]);
      }
      expect(
        agentRow('Review the diff')
          .querySelector('[data-testid="background-tray-agent-stop"]')
          ?.getAttribute('aria-label'),
      ).toBe('Stop agent');
      expect(
        agentRow('Fix flaky e2e')
          .querySelector('[data-testid="background-tray-agent-stop"]')
          ?.getAttribute('aria-label'),
      ).toBe('Stop delegation');
    });

    it("never repeats an agent's name as what it is doing", () => {
      openWith([
        { ...REVIEWER, steps: [], activity: 'Review the diff' },
        { ...CODEX, activity: 'Reading coupons.ts' },
      ]);
      expect(
        agentRow('Review the diff').textContent?.match(/Review the diff/g),
      ).toHaveLength(1);
      expect(agentRow('Audit coupon rules').textContent).toContain(
        'Reading coupons.ts',
      );
      act(() =>
        agentRow('Review the diff')
          .querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
      // The inspector says its state instead.
      expect(
        agentRow('Review the diff').querySelector(
          '[data-testid="background-tray-inspector"]',
        )?.textContent,
      ).toContain('Running');
    });

    it('offers no Open chat where the host cannot open one', () => {
      openWith([REVIEWER]);
      act(() =>
        agentRow('Review the diff')
          .querySelector<HTMLElement>(
            '[data-testid="background-tray-row-toggle"]',
          )
          ?.click(),
      );
      expect(byTestId('background-tray-inspector-open')).toBeNull();
    });

    it('puts View tree and Stop all in the open header', () => {
      const onViewTree = jest.fn();
      const stopAll = jest.fn((): Promise<boolean> => Promise.resolve(true));
      openWith([REVIEWER, DELEGATES[0]], {
        onViewTree,
        onStopAllDelegations: stopAll,
      });
      act(() => byTestId('background-tray-view-tree')?.click());
      expect(onViewTree).toHaveBeenCalledTimes(1);
      // One delegate stops from its row; Stop all needs two.
      expect(byTestId('background-tray-stop-all')).toBeNull();

      // The open drawer stays open as a second delegate arrives.
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[REVIEWER_TASK]}
          taskActions={STOP_ACTIONS}
          agents={[REVIEWER, ...DELEGATES]}
          onViewTree={onViewTree}
          onStopAllDelegations={stopAll}
        />,
      );
      expect(byTestId('background-tray-stop-all')).toBeInstanceOf(HTMLElement);
      // Closed, the header shows the kinds instead.
      act(() => byTestId('background-tray-toggle')?.click());
      expect(byTestId('background-tray-view-tree')).toBeNull();
      expect(byTestId('background-tray-stop-all')).toBeNull();
      expect(byTestId('background-tray-kind-agent')?.textContent).toBe('3');
    });

    it('titles a delegate Stop that also ends the tasks it started', () => {
      render(
        <BackgroundTray
          chatId="chat-one"
          tasks={[]}
          agents={[{ ...DELEGATES[0], stopsDescendants: true }]}
          onStopAgent={(): Promise<boolean> => Promise.resolve(true)}
        />,
      );
      act(() => byTestId('background-tray-toggle')?.click());
      const stop = byTestId('background-tray-agent-stop');
      expect(stop?.getAttribute('aria-label')).toBe('Stop delegation');
      // The row's Stop opens its tooltip after the long hover delay.
      jest.useFakeTimers();
      try {
        act(() => {
          stop?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          stop?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
          jest.advanceTimersByTime(1000);
        });
      } finally {
        jest.useRealTimers();
      }
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Stop delegation and the tasks it started',
      );
    });

    it('counts delegates the host knows of but cannot list', () => {
      // The Portal's transcript window may not reach an old delegate's card.
      openWith([DELEGATES[0]], { unlistedDelegations: 2 });
      expect(byTestId('background-tray-summary')?.textContent).toBe(
        '4 running in the background',
      );
      expect(byTestId('background-tray-unlisted-delegates')?.textContent).toBe(
        '2 more delegates',
      );
      act(() => byTestId('background-tray-toggle')?.click());
      expect(byTestId('background-tray-kind-agent')?.textContent).toBe('4');

      openWith([], { tasks: [], unlistedDelegations: 1 });
      expect(byTestId('background-tray-summary')?.textContent).toBe(
        '1 running in the background',
      );
      expect(byTestId('background-tray-unlisted-delegates')?.textContent).toBe(
        '1 delegate',
      );
    });

    it('leads Needs you with an agent waiting on an approval', () => {
      openWith([
        REVIEWER,
        agent({
          id: 'managed:d3',
          kind: 'delegate',
          title: 'Migrate the schema',
          status: 'approval',
        }),
      ]);
      expect(byTestId('background-tray-summary')?.textContent).toBe(
        '1 running in the background · 1 needs input',
      );
      const order = Array.from(
        byTestId('background-tray-rows')?.querySelectorAll('[data-tray-row]') ??
          [],
      ).map((row) => row.getAttribute('data-tray-row'));
      expect(order).toEqual(['agent:managed:d3', 'agent:claude:tool-review']);
      expect(
        Array.from(
          container.querySelectorAll(
            '[data-testid="background-tray-group-label"]',
          ),
        ).map((label) => label.textContent),
      ).toEqual(['Needs you', 'Running']);
    });
  });
});
