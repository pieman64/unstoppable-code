/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
  type AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function watcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? 'w1',
    trigger: overrides.trigger ?? 'worktree_chat_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'My watcher',
    target: overrides.target ?? {
      kind: 'worktree_chat',
      projectId: 'p1',
      worktreeId: 'w1',
      chatId: 'c1',
    },
    destination: overrides.destination ?? {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'app-chat',
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...(overrides.ownerDelegate
      ? { ownerDelegate: overrides.ownerDelegate }
      : {}),
  };
}

/**
 * Grouped GitHub workflow-run watcher fixture. `runCount` items are spread
 * across `repoCount` repositories; the persisted display sample is capped at
 * five entries by the backend (mirrored here).
 */
function githubWatcher(
  runCount: number,
  repoCount: number,
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  const repos = Array.from(
    { length: repoCount },
    (_, index) => `acme/repo-${index + 1}`,
  );
  const items: Extract<
    AppAdvisorWatcherSummary['target'],
    { kind: 'github_workflow_runs' }
  >['items'] = Array.from({ length: runCount }, (_, index) => ({
    kind: 'workflow_run',
    repository: repos[index % repoCount],
    runId: String(index + 1),
  }));
  const sample = items.slice(0, 5).map((item, index) => ({
    repository: item.repository,
    runId: item.runId,
    runAttempt: 1,
    workflowName: `Workflow ${index + 1}`,
    runNumber: (index + 1) * 10,
  }));
  return watcher({
    trigger: 'github_workflow_runs_changed',
    label: overrides.label ?? 'CI watcher',
    ...overrides,
    target: {
      kind: 'github_workflow_runs',
      items,
      notifyOn: {
        statuses: [...GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES],
        conclusions: ['failure', 'success'],
        jobConclusions: [],
      },
      display: { repositories: repos, sample },
    },
  });
}

function chatTab(id: string, title: string): ChatTab {
  return {
    id,
    title,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

describe('WatcherManagementButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  const deleteWatcherMock = jest.fn<
    Promise<{ ok: true } | { ok: false; error: string }>,
    [string | { watcherId: string; notifySubscriber?: boolean }]
  >();
  const openWindowMock = jest.fn();

  it('offers drawer watchers as a quiet labeled action opening the existing management dialog', () => {
    const items = [watcher()];
    act(() =>
      root.render(
        <WatcherManagementButton
          watchers={items}
          appearance="drawer"
          modalTitle="Pipeline watchers"
          modalEmptyMessage="No active watchers."
          ariaLabel="Manage pipeline watchers"
          dataTestId="drawer-watchers"
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-watchers"]',
    );
    expect(button?.textContent).toBe('Watchers 1');
    expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => button?.click());
    expect(document.body.textContent).toContain('Pipeline watchers');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    deleteWatcherMock.mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: {
          deleteWatcher: deleteWatcherMock,
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
    useCurrentUiStateStore
      .getState()
      .updateSlice('appAdvisor.watchersModal', null);
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

  it('renders nothing when the watcher list is empty', () => {
    const markup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage watchers"
        dataTestId="watchers-button"
      />,
    );
    expect(markup).toBe('');
  });

  it('renders the eye icon button with the documented testid for a single watcher', () => {
    const markup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[watcher({ id: 'one' })]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage watchers"
        dataTestId="watchers-button"
      />,
    );
    expect(markup).toContain('data-testid="watchers-button"');
    expect(markup).toContain('aria-label="Manage watchers"');
    expect(markup).toContain('<svg');
    // Single-watcher slice does not render the count badge.
    expect(markup).not.toContain('data-testid="watchers-button-count"');
  });

  it('renders a count badge when more than one watcher matches', () => {
    const markup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[
          watcher({ id: 'one' }),
          watcher({ id: 'two' }),
          watcher({ id: 'three' }),
        ]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage watchers"
        dataTestId="watchers-button"
      />,
    );
    expect(markup).toContain('data-testid="watchers-button-count"');
    expect(markup).toContain('>3<');
  });

  it('names the live subscribing chat and the delegate that owns each watcher', async () => {
    useChatStore.setState({
      worktreeChats: {
        'p1/w1': {
          activeTabId: 'root-chat',
          tabs: [
            chatTab('root-chat', 'Root chat'),
            chatTab('delegate-chat', 'Delegate chat'),
          ],
        },
      },
    });
    const destination = {
      projectId: 'p1',
      worktreeId: 'w1',
      chatId: 'root-chat',
    };
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [
            watcher({ id: 'own', label: 'Root watcher', destination }),
            watcher({
              id: 'nested',
              label: 'Nested watcher',
              destination: {
                ...destination,
                chatId: 'delegate-chat',
                delegationId: 'delegate-1',
              },
              ownerDelegate: {
                delegationId: 'delegate-1',
                description: 'Review auth flow',
                depth: 2,
              },
            }),
          ],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });
    const button = container.querySelector('[data-testid="watchers-button"]');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="watchers-button-owner-own"]'),
    ).toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="watchers-button-owner-nested"]',
      )?.textContent,
    ).toBe('Delegate: Review auth flow · depth 2');
    expect(
      document.body.querySelector(
        '[data-testid="watchers-button-destination-own"]',
      )?.textContent,
    ).toBe('Subscribed chat: Root chat');
    expect(
      document.body.querySelector(
        '[data-testid="watchers-button-destination-nested"]',
      )?.textContent,
    ).toBe('Subscribed chat: Delegate chat');

    await act(async () => {
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-destination-own"]',
      )?.textContent,
    ).toBe('Root chat');
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-destination-nested"]',
      )?.textContent,
    ).toBe('Delegate chat');
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-owner-own"]',
      ),
    ).toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="watcher-management-owner-nested"]',
      )?.textContent,
    ).toBe('Review auth flow · depth 2');
    act(() => {
      useChatStore.setState(useChatStore.getInitialState());
    });
  });

  it('shows a hover preview and opens the management modal on click', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [
            watcher({
              id: 'one',
              followUpInstruction: 'SECRET_FOLLOW_UP_INSTRUCTION',
            }),
            watcher({ id: 'two' }),
          ],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    const button = container.querySelector('[data-testid="watchers-button"]');
    expect(button).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="watchers-button-tooltip"]'),
    ).toBeInstanceOf(HTMLDivElement);
    expect(document.body.textContent).toContain('Active watchers');
    expect(document.body.textContent).toContain('My watcher');

    await act(async () => {
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).toContain('Watching');
    expect(document.body.textContent).toContain('Subscribed chat');
    expect(document.body.textContent).not.toContain(
      'SECRET_FOLLOW_UP_INSTRUCTION',
    );
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.watchersModal,
    ).toEqual({
      open: true,
      chatId: 'app-chat',
      watcherCount: 2,
      confirmingDelete: false,
    });
  });

  it('supports composer-specific bigtop icon and tooltip copy without changing defaults', async () => {
    const defaultMarkup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[watcher({ id: 'default-icon' })]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage watchers"
        dataTestId="watchers-button"
      />,
    );
    const bigtopMarkup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[watcher({ id: 'bigtop-icon' })]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage watchers"
        dataTestId="watchers-button"
        icon="bigtop"
        tooltipTitle="WATCHING"
      />,
    );

    expect(defaultMarkup).not.toEqual(bigtopMarkup);

    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [watcher({ id: 'watching-copy' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
          icon: 'bigtop',
          tooltipTitle: 'WATCHING',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('WATCHING');
    expect(document.body.textContent).not.toContain('Active watchers');
  });

  it('draws the composer chip in the Plan chip shape, with a hover preview and the modal on click', async () => {
    const onComposerClick = jest.fn();
    act(() => {
      root.render(
        <div onClick={onComposerClick}>
          <WatcherManagementButton
            watchers={[
              watcher({ id: 'one' }),
              watcher({ id: 'two' }),
              watcher({ id: 'three' }),
            ]}
            modalTitle="Watchers"
            modalEmptyMessage="No watchers"
            ariaLabel="Manage chat watchers"
            dataTestId="watchers-chip"
            icon="bigtop"
            tooltipTitle="WATCHING"
            appearance="composer-chip"
          />
        </div>,
      );
    });

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="watchers-chip"]',
    );
    expect(chip).toBeInstanceOf(HTMLButtonElement);
    // The Plan chip's capsule, in the running-state tone.
    for (const cls of [
      'h-8',
      'rounded-full',
      'gap-1.5',
      'px-2.5',
      'text-xs',
      'bg-info-subtle',
      'fg-info',
    ]) {
      expect(chip?.classList.contains(cls)).toBe(true);
    }
    // No word, just the glyph and, past one, the count.
    expect(chip?.textContent).toBe('3');
    expect(
      container.querySelector('[data-testid="watchers-chip-count"]')
        ?.textContent,
    ).toBe('3');
    expect(chip?.getAttribute('aria-label')).toBe('Manage chat watchers');

    await act(async () => {
      chip?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('WATCHING');

    await act(async () => {
      chip?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).toBeInstanceOf(HTMLElement);
    // The click stays with the chip; the composer around it does not refocus.
    expect(onComposerClick).not.toHaveBeenCalled();
  });

  it('draws a single-watcher composer chip as the glyph in a circle', () => {
    const markup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[watcher({ id: 'one' })]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage chat watchers"
        dataTestId="watchers-chip"
        appearance="composer-chip"
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = markup;
    const chip = host.querySelector('[data-testid="watchers-chip"]');
    expect(chip?.textContent).toBe('');
    expect(chip?.querySelector('svg')).not.toBeNull();
    // The 32px circle: as tall as the Plan chip, as wide as it is tall.
    for (const cls of ['h-8', 'w-8', 'rounded-full', 'justify-center']) {
      expect(chip?.classList.contains(cls)).toBe(true);
    }
    expect(markup).not.toContain('data-testid="watchers-chip-count"');
  });

  it('jumps to the subscribing chat from the modal and closes it', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [watcher({ id: 'jump-me' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector('[data-testid="watcher-management-jump-jump-me"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openWindowMock).toHaveBeenCalledWith({
      focus: true,
      focusComposer: true,
      chatId: 'app-chat',
    });
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).toBeNull();
  });

  it('deletes without notify by default and with notify when the checkbox is selected', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [watcher({ id: 'delete-me' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector('[data-testid="watcher-management-delete-delete-me"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector(
          '[data-testid="watcher-management-confirm-delete-delete-me"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(deleteWatcherMock).toHaveBeenLastCalledWith('delete-me');

    await act(async () => {
      document.body
        .querySelector('[data-testid="watcher-management-delete-delete-me"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector('[data-testid="watcher-management-notify-delete-me"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector(
          '[data-testid="watcher-management-confirm-delete-delete-me"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(deleteWatcherMock).toHaveBeenLastCalledWith({
      watcherId: 'delete-me',
      notifySubscriber: true,
    });
  });

  it('counts one grouped GitHub watcher as a single watcher (no count badge)', () => {
    const markup = renderToStaticMarkup(
      <WatcherManagementButton
        watchers={[githubWatcher(20, 2, { id: 'gh-1' })]}
        modalTitle="Watchers"
        modalEmptyMessage="No watchers"
        ariaLabel="Manage watchers"
        dataTestId="watchers-button"
      />,
    );
    expect(markup).toContain('data-testid="watchers-button"');
    expect(markup).not.toContain('data-testid="watchers-button-count"');
  });

  it('renders a bounded three-run sample in the tooltip for a 20-run watcher', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [githubWatcher(20, 2, { id: 'gh-tooltip' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tooltip = document.body.querySelector(
      '[data-testid="watchers-button-tooltip"]',
    );
    expect(tooltip?.textContent).toContain(
      '20 workflow runs in 2 repositories',
    );
    // Tooltip shows at most three sample runs, then `+N more` (20 - 3 = 17).
    expect(tooltip?.textContent).toContain('Workflow 1 #10');
    expect(tooltip?.textContent).toContain('Workflow 3 #30');
    expect(tooltip?.textContent).not.toContain('Workflow 4 #40');
    expect(tooltip?.textContent).toContain('+17 more');
  });

  it('renders filters and a bounded five-run sample in the modal', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [githubWatcher(20, 2, { id: 'gh-modal' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal?.textContent).toContain('20 workflow runs in 2 repositories');
    expect(modal?.textContent).toContain('Intermediate: any');
    expect(modal?.textContent).toContain('Terminal: failure, success');
    const sampleList = document.body.querySelector(
      '[data-testid="watcher-management-github-gh-modal"] ul',
    );
    // Five sample rows + one overflow row.
    expect(sampleList?.children.length).toBe(6);
    expect(modal?.textContent).toContain('Workflow 5 #50');
    expect(modal?.textContent).toContain('+15 more');
  });

  it('renders a single-run watcher subtitle without an overflow counter', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [githubWatcher(1, 1, { id: 'gh-single' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal?.textContent).toContain('1 workflow run in acme/repo-1');
    expect(modal?.textContent).not.toContain('more');
  });

  it('renders a three-run single-repo watcher without truncation', async () => {
    act(() => {
      root.render(
        createElement(WatcherManagementButton, {
          watchers: [githubWatcher(3, 1, { id: 'gh-three' })],
          modalTitle: 'Watchers',
          modalEmptyMessage: 'No watchers',
          ariaLabel: 'Manage watchers',
          dataTestId: 'watchers-button',
        }),
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="watchers-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const modal = document.body.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(modal?.textContent).toContain('3 workflow runs in acme/repo-1');
    const sampleList = document.body.querySelector(
      '[data-testid="watcher-management-github-gh-three"] ul',
    );
    // Exactly three sample rows, no overflow row.
    expect(sampleList?.children.length).toBe(3);
    expect(modal?.textContent).not.toContain('more');
  });
});
