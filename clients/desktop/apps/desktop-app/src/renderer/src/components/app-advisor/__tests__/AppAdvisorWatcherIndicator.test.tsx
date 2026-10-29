/**
 * @jest-environment jsdom
 */
import { act, createElement, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
  type AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { AppAdvisorWatcherIndicator } from '../AppAdvisorWatcherIndicator';

// The indicator is now a thin wrapper around the shared
// WatcherManagementButton/Modal, so these tests assert the shared component's
// testids (`app-advisor-watcher-indicator[-tooltip]`, `watcher-management-*`)
// and target-display semantics — the single implementation the App Advisor and
// worktree chat surfaces share.
jest.mock('@canopy/ui-shared/icons', () => ({
  AppAdvisorWatcherIcon: ({
    children,
  }: {
    children?: ReactNode;
  }): JSX.Element =>
    createElement('span', { 'data-testid': 'watcher-icon' }, children),
  WatcherEyeIcon: ({ children }: { children?: ReactNode }): JSX.Element =>
    createElement('span', { 'data-testid': 'watcher-eye-icon' }, children),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const listWatchersMock = jest.fn<
  Promise<AppAdvisorWatcherSummary[]>,
  [unknown?]
>();
const deleteWatcherMock = jest.fn<
  Promise<{ ok: true } | { ok: false; error: string }>,
  [string | { watcherId: string; notifySubscriber?: boolean }]
>();
const onWatchersChangedMock = jest.fn(
  (
    _cb: (watchers: AppAdvisorWatcherSummary[]) => void, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): (() => void) =>
    (): void =>
      undefined,
);
const openWindowMock = jest.fn();

function makeWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? `watcher-${Math.random().toString(36).slice(2)}`,
    trigger: overrides.trigger ?? 'worktree_chat_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'Sample watcher',
    target:
      overrides.target ??
      ({
        kind: 'worktree_chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        workspaceName: 'Canopy',
        worktreeBranchName: 'feature/watchers',
        chatTitle: 'Source chat',
        chatDescription: 'Review the active branch',
        providerType: 'codex',
        model: 'gpt-6-sol',
      } as AppAdvisorWatcherSummary['target']),
    destination:
      overrides.destination ??
      ({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-1',
      } as AppAdvisorWatcherSummary['destination']),
    ...(overrides.followUpInstruction
      ? { followUpInstruction: overrides.followUpInstruction }
      : {}),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...(overrides.firedAt ? { firedAt: overrides.firedAt } : {}),
    ...(overrides.deliveryError
      ? { deliveryError: overrides.deliveryError }
      : {}),
    ...(overrides.failureKind ? { failureKind: overrides.failureKind } : {}),
  };
}

/** A grouped 20-run, 2-repository GitHub workflow-run watcher fixture. */
function makeGitHubWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  const items: Extract<
    AppAdvisorWatcherSummary['target'],
    { kind: 'github_workflow_runs' }
  >['items'] = Array.from({ length: 20 }, (_, index) => ({
    kind: 'workflow_run',
    repository: index % 2 === 0 ? 'acme/api' : 'acme/web',
    runId: String(index + 1),
  }));
  const target: AppAdvisorWatcherSummary['target'] = {
    kind: 'github_workflow_runs',
    items,
    notifyOn: {
      statuses: [...GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES],
      conclusions: ['failure', 'success'],
    },
    display: {
      repositories: ['acme/api', 'acme/web'],
      sample: [
        {
          repository: 'acme/api',
          runId: '1',
          workflowName: 'Build',
          runNumber: 11,
        },
        {
          repository: 'acme/web',
          runId: '2',
          workflowName: 'Lint',
          runNumber: 22,
        },
        {
          repository: 'acme/api',
          runId: '3',
          workflowName: 'Test',
          runNumber: 33,
        },
        {
          repository: 'acme/web',
          runId: '4',
          workflowName: 'Deploy',
          runNumber: 44,
        },
        {
          repository: 'acme/api',
          runId: '5',
          workflowName: 'E2E',
          runNumber: 55,
        },
      ],
    },
  };
  return makeWatcher({
    id: overrides.id ?? 'github-1',
    trigger: 'github_workflow_runs_changed',
    label: overrides.label ?? 'CI watcher',
    target,
    ...overrides,
  });
}

function flushPromises(): Promise<void> {
  return act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AppAdvisorWatcherIndicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    listWatchersMock.mockReset();
    listWatchersMock.mockResolvedValue([]);
    deleteWatcherMock.mockReset();
    deleteWatcherMock.mockResolvedValue({ ok: true });
    onWatchersChangedMock.mockClear();
    openWindowMock.mockClear();

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: {
          listWatchers: listWatchersMock,
          deleteWatcher: deleteWatcherMock,
          onWatchersChanged: onWatchersChangedMock,
          openWindow: openWindowMock,
        },
      },
    });

    useAppAdvisorWatchersStore.setState({
      watchers: [],
      loading: false,
      hydrated: true,
      error: null,
      deleteErrors: {},
    });
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    useCurrentUiStateStore.getState().recomputeEnvelope();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  function render(chatId: string): Promise<void> {
    act(() => {
      root.render(createElement(AppAdvisorWatcherIndicator, { chatId }));
    });
    return flushPromises();
  }

  function renderDestination(destination: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }): Promise<void> {
    act(() => {
      root.render(createElement(AppAdvisorWatcherIndicator, { destination }));
    });
    return flushPromises();
  }

  it('renders nothing when no watchers target this chat', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [
        makeWatcher({
          id: 'other',
          destination: {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: APP_ADVISOR_WORKTREE_ID,
            chatId: 'somewhere-else',
          },
        }),
      ],
    });

    await render('advisor-1');

    expect(
      container.querySelector('[data-testid="app-advisor-watcher-indicator"]'),
    ).toBeNull();
  });

  it('renders the blue watcher button with the correct aria-label when matches exist', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [makeWatcher({ id: 'w-1' })],
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Active watchers');
    expect(button?.className).toContain('fg-info');
    expect(button?.className).toContain('bg-info-subtle');
    expect(button?.className).toContain('border-fg-info/30');
  });

  it('matches worktree chat destinations by project, worktree, and chat id', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [
        makeWatcher({
          id: 'matching',
          destination: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'same-chat',
          },
        }),
        makeWatcher({
          id: 'same-chat-other-worktree',
          destination: {
            projectId: 'project-1',
            worktreeId: 'worktree-2',
            chatId: 'same-chat',
          },
        }),
      ],
    });

    await renderDestination({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'same-chat',
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    expect(button).not.toBeNull();
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-row-matching"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-row-same-chat-other-worktree"]',
      ),
    ).toBeNull();
  });

  it('shows up to five tooltip rows and a +N more counter when truncated', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: Array.from({ length: 7 }, (_, index) =>
        makeWatcher({
          id: `w-${index}`,
          label: `Watcher ${index}`,
        }),
      ),
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    expect(button).not.toBeNull();

    // React synthesizes `onMouseEnter` from a bubbling native `mouseover`; jsdom
    // does not synthesize `mouseenter`, so we dispatch `mouseover` directly.
    await act(async (): Promise<void> => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tooltip = document.body.querySelector(
      '[data-testid="app-advisor-watcher-indicator-tooltip"]',
    );
    expect(tooltip).not.toBeNull();
    const rows = tooltip?.querySelectorAll('li') ?? [];
    expect(rows.length).toBe(5);
    expect(tooltip?.textContent).toContain('+2 more');
  });

  it('opens a modal listing all matching watchers when the icon is clicked', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [
        makeWatcher({
          id: 'w-1',
          target: {
            kind: 'worktree_chat',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            workspaceName: 'Canopy',
            worktreeBranchName: 'feature/first',
            chatTitle: 'First',
            providerType: 'codex',
            model: 'gpt-6-sol',
          },
        }),
        makeWatcher({
          id: 'w-2',
          target: {
            kind: 'worktree_chat',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-2',
            workspaceName: 'Canopy',
            worktreeBranchName: 'feature/second',
            chatTitle: 'Second',
            providerType: 'claude',
            model: 'claude-sonnet-4-5-20250929',
          },
        }),
      ],
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('First');
    expect(modal?.textContent).toContain('Second');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.watchersModal,
    ).toEqual({
      open: true,
      chatId: 'advisor-1',
      watcherCount: 2,
      confirmingDelete: false,
    });
  });

  it('renders friendly target semantics through the shared modal without internal ids', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [makeWatcher({ id: 'w-friendly' })],
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    expect(button).not.toBeNull();

    await act(async (): Promise<void> => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tooltip = document.body.querySelector(
      '[data-testid="app-advisor-watcher-indicator-tooltip"]',
    );
    expect(tooltip?.textContent).toContain('Sample watcher');
    expect(tooltip?.textContent).toContain('Worktree chat completion');
    expect(tooltip?.textContent).not.toContain('project-1');
    expect(tooltip?.textContent).not.toContain('worktree-1');
    expect(tooltip?.textContent).not.toContain('chat-1');

    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal?.textContent).toContain('Source chat');
    expect(modal?.textContent).toContain('Canopy / feature/watchers');
    expect(modal?.textContent).toContain('Subscribed chat');
    expect(modal?.textContent).not.toContain('project-1');
    expect(modal?.textContent).not.toContain('worktree-1');
    expect(modal?.textContent).not.toContain('chat-1');
  });

  it('renders non-chat target variants through the shared display helper', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [
        makeWatcher({
          id: 'worktree-scope',
          trigger: 'worktree_new_chat_started',
          target: {
            kind: 'worktree_chat_scope',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            workspaceName: 'Canopy',
            worktreeBranchName: 'feature/new-chat',
          },
        }),
        makeWatcher({
          id: 'standalone-project',
          trigger: 'standalone_new_chat_started',
          target: {
            kind: 'standalone_chat_project',
            projectId: 'standalone-project-1',
            projectName: 'Standalone project',
          },
        }),
        makeWatcher({
          id: 'pipeline',
          trigger: 'worktree_pipeline_completion',
          target: {
            kind: 'worktree_pipeline',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            executionId: 'execution-1',
            workspaceName: 'Canopy',
            worktreeBranchName: 'feature/pipeline',
            pipelineName: 'Quality gate',
            pipelineDescription: 'Verify the branch',
            terminalStatuses: ['success', 'failure'],
          },
        }),
      ],
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    expect(button).not.toBeNull();
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal?.textContent).toContain('feature/new-chat');
    expect(modal?.textContent).toContain('Standalone project');
    expect(modal?.textContent).toContain('Quality gate');
  });

  it('renders the grouped GitHub watcher as one row with a bounded sample', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [makeGitHubWatcher({ id: 'gh-1' })],
    });

    await render('advisor-1');

    // One grouped watcher counts as one — no multi-watcher count badge.
    expect(
      container.querySelector(
        '[data-testid="app-advisor-watcher-indicator-count"]',
      ),
    ).toBeNull();

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    const rows = document.body.querySelectorAll(
      '[data-testid^="watcher-management-row-"]',
    );
    expect(rows.length).toBe(1);

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal?.textContent).toContain('20 workflow runs in 2 repositories');
    expect(modal?.textContent).toContain('Intermediate: any');
    expect(modal?.textContent).toContain('Terminal: failure, success');
    // Modal sample is bounded at five, then `+N more` (20 - 5 = 15).
    const sampleItems =
      document.body.querySelector(
        '[data-testid="watcher-management-github-gh-1"] ul',
      )?.children ?? [];
    // Five sample rows + one overflow row.
    expect(sampleItems.length).toBe(6);
    expect(modal?.textContent).toContain('+15 more');
    expect(modal?.textContent).not.toContain('#6');
  });

  it('closes the modal once the last matching watcher disappears', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [makeWatcher({ id: 'w-1', label: 'Last watcher' })],
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).not.toBeNull();

    await act(async (): Promise<void> => {
      useAppAdvisorWatchersStore.setState({ watchers: [] });
      await Promise.resolve();
    });

    // The shared button owns one modal implementation across surfaces: when the
    // list empties it closes the modal and the indicator unmounts.
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="app-advisor-watcher-indicator"]'),
    ).toBeNull();
  });

  it('requires a two-step confirmation before issuing a delete', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [makeWatcher({ id: 'w-target', label: 'Target' })],
    });

    await render('advisor-1');
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    const initialDelete = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-management-delete-w-target"]',
    );
    expect(initialDelete).not.toBeNull();
    await act(async (): Promise<void> => {
      initialDelete?.click();
      await Promise.resolve();
    });

    // First click reveals confirm.
    expect(deleteWatcherMock).not.toHaveBeenCalled();
    const confirmDelete = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-management-confirm-delete-w-target"]',
    );
    expect(confirmDelete).not.toBeNull();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.watchersModal?.confirmingDelete,
    ).toBe(true);

    await act(async (): Promise<void> => {
      confirmDelete?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deleteWatcherMock).toHaveBeenCalledWith('w-target');
  });

  it('renders an inline error message when delete resolves with ok=false', async () => {
    deleteWatcherMock.mockResolvedValueOnce({
      ok: false,
      error: 'already firing',
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [makeWatcher({ id: 'w-fail', label: 'Failure case' })],
    });

    await render('advisor-1');
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    const initialDelete = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-management-delete-w-fail"]',
    );
    await act(async (): Promise<void> => {
      initialDelete?.click();
      await Promise.resolve();
    });

    const confirmDelete = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="watcher-management-confirm-delete-w-fail"]',
    );
    await act(async (): Promise<void> => {
      confirmDelete?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useAppAdvisorWatchersStore.getState().deleteErrors['w-fail']).toBe(
      'already firing',
    );
    const errorNote = document.body.querySelector(
      '[data-testid="watcher-management-delete-error-w-fail"]',
    );
    expect(errorNote?.textContent).toContain('Could not delete watcher.');
  });

  it('excludes watchers in transient firing / fired states even if they appear in the store snapshot', async () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [
        makeWatcher({ id: 'visible', status: 'active' }),
        makeWatcher({ id: 'transient-firing', status: 'firing' }),
        makeWatcher({ id: 'transient-fired', status: 'fired' }),
      ],
    });

    await render('advisor-1');

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-advisor-watcher-indicator"]',
    );
    expect(button).not.toBeNull();

    await act(async (): Promise<void> => {
      button?.click();
      await Promise.resolve();
    });

    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-row-visible"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-row-transient-firing"]',
      ),
    ).toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-row-transient-fired"]',
      ),
    ).toBeNull();
  });
});
