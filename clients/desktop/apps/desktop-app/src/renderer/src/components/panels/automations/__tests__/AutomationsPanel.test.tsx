/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AppAdvisorWatcherSummary,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { AutomationsPanel } from '../AutomationsPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const originalAutomationsHydrate = useAutomationsStore.getState().hydrate;
const originalWatchersHydrate = useAppAdvisorWatchersStore.getState().hydrate;

function activity(
  overrides: Partial<ScheduledActivity> & { id: string },
): ScheduledActivity {
  return {
    version: 1,
    name: overrides.id,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      existingWorktreeId: 'wt-1',
      prompt: 'Go.',
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function watcher(
  overrides: Partial<AppAdvisorWatcherSummary> & { id: string },
): AppAdvisorWatcherSummary {
  return {
    trigger: 'worktree_chat_completion',
    status: 'active',
    label: overrides.id,
    target: {
      kind: 'worktree_chat',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    },
    destination: { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(
  overrides: Partial<ScheduledActivityRun> & { id: string; activityId: string },
): ScheduledActivityRun {
  return {
    activityName: overrides.activityId,
    scheduledFor: '2026-08-30T11:00:00.000Z',
    manual: false,
    status: 'success',
    startedAt: '2026-08-30T11:00:00.000Z',
    completedAt: '2026-08-30T11:00:05.000Z',
    ...overrides,
  };
}

describe('AutomationsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
      hydrate: originalAutomationsHydrate,
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [],
      completedWatchers: [],
      loading: false,
      hydrated: true,
      error: null,
      deleteErrors: {},
      hydrate: originalWatchersHydrate,
    });
    useProjectsStore.setState({
      projects: [
        {
          id: 'ws-1',
          name: 'Canopy',
          type: 'single-repo',
          repoPath: '/repo/canopy',
          color: '#654321',
          collapsed: false,
          order: 0,
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/panel',
              createdAt: '2026-08-01T00:00:00.000Z',
            },
            {
              id: 'wt-2',
              branchName: 'main',
              createdAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        },
        {
          id: 'cowork-1',
          name: 'Notes',
          type: 'cowork',
          color: '#654321',
          collapsed: false,
          order: 1,
        },
      ],
    });
    useCurrentUiStateStore.setState({ slices: {} });
    useNavigationStore.setState({
      activePage: 'main',
      workflowEdit: undefined,
    });
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
    jest.restoreAllMocks();
  });

  /** The edit shell target the panel opened in the main window (CAN-4072). */
  function openedTarget(): unknown {
    return useNavigationStore.getState().workflowEdit;
  }

  function renderPanel(
    props: Partial<Parameters<typeof AutomationsPanel>[0]> = {},
  ): void {
    act(() => {
      root.render(
        createElement(AutomationsPanel, {
          panelId: 'panel-1',
          variant: 'full',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          ...props,
        }),
      );
    });
  }

  function click(testId: string): void {
    act(() => {
      container
        .querySelector(`[data-testid="${testId}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('renders all three collapsible sections in the full variant with toggle + add controls', () => {
    renderPanel();
    for (const section of ['upcoming', 'overview', 'completed']) {
      expect(
        container.querySelector(
          `[data-testid="automations-panel-section-${section}"]`,
        ),
      ).not.toBeNull();
    }
    const toggle = container.querySelector(
      '[data-testid="automations-panel-worktree-toggle"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('[data-testid="automations-panel-add"]'),
    ).not.toBeNull();
  });

  it('does not offer create from the App Advisor pseudo-workspace', () => {
    renderPanel({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
    });

    expect(
      container.querySelector('[data-testid="automations-panel-add"]'),
    ).toBeNull();
  });

  it('collapses and expands a section in the full variant', () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'wt-scoped' })],
    });
    renderPanel();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-body"]',
      ),
    ).not.toBeNull();
    click('automations-panel-section-overview');
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-body"]',
      ),
    ).toBeNull();
    click('automations-panel-section-overview');
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-body"]',
      ),
    ).not.toBeNull();
  });

  it('scopes to the current worktree by default and widens on toggle', () => {
    useAutomationsStore.setState({
      activities: [
        activity({ id: 'wt-scoped' }),
        activity({
          id: 'workspace-only',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'ws-1',
            prompt: 'Go.',
          },
        }),
        activity({
          id: 'other-workspace',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'ws-2',
            prompt: 'Go.',
          },
        }),
      ],
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [
        watcher({ id: 'wt-watcher' }),
        watcher({
          id: 'other-worktree-watcher',
          target: {
            kind: 'worktree_chat_scope',
            projectId: 'ws-1',
            worktreeId: 'wt-2',
          },
        }),
      ],
    });
    renderPanel();

    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-wt-scoped"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-workspace-only"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-watcher-wt-watcher"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-watcher-other-worktree-watcher"]',
      ),
    ).toBeNull();

    click('automations-panel-worktree-toggle');

    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-workspace-only"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-watcher-other-worktree-watcher"]',
      ),
    ).not.toBeNull();
    // Other workspaces stay excluded either way.
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-other-workspace"]',
      ),
    ).toBeNull();
  });

  it('hides the worktree toggle for cowork projects and scopes by project', () => {
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'cowork-scoped',
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'cowork-1',
            prompt: 'Go.',
          },
        }),
      ],
    });
    renderPanel({ projectId: 'cowork-1', worktreeId: 'entry-1' });
    expect(
      container.querySelector(
        '[data-testid="automations-panel-worktree-toggle"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="automations-panel-add"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-cowork-scoped"]',
      ),
    ).not.toBeNull();
  });

  it('renders exactly one section without collapse chrome in preset variants', () => {
    renderPanel({ variant: 'upcoming' });
    expect(
      container.querySelector('[data-testid^="automations-panel-section-"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-body"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain('No upcoming automation triggers.');
  });

  it('shows a loading state instead of false empty rows until both stores hydrate', () => {
    const hydrate = jest.fn(() => Promise.resolve());
    useAutomationsStore.setState({
      loading: false,
      hydrated: false,
      hydrate,
    });

    renderPanel();

    expect(
      container.querySelector('[data-testid="automations-panel-loading"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain(
      'No upcoming automation triggers.',
    );
    expect(container.textContent).not.toContain('No automations or watchers.');
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('surfaces hydration failures and retries the failed store', () => {
    const hydrate = jest.fn(() => Promise.resolve());
    useAutomationsStore.setState({
      loading: false,
      hydrated: false,
      error: 'Automations IPC failed.',
      hydrate,
    });

    renderPanel();

    const error = container.querySelector(
      '[data-testid="automations-panel-load-error"]',
    );
    expect(error?.textContent).toContain('Automations IPC failed.');
    expect(container.textContent).not.toContain(
      'No upcoming automation triggers.',
    );

    click('automations-panel-retry');
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('filters the overview by type and search text', () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'daily-digest' })],
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [watcher({ id: 'release-watch' })],
    });
    renderPanel({ variant: 'overview' });

    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-daily-digest"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-watcher-release-watch"]',
      ),
    ).not.toBeNull();

    click('automations-panel-filter-watchers');
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-daily-digest"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-watcher-release-watch"]',
      ),
    ).not.toBeNull();

    click('automations-panel-filter-all');
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="automations-panel-search"]',
    );
    if (search === null) {
      throw new Error('automations panel search input was not rendered');
    }
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(search),
        'value',
      )?.set;
      setter?.call(search, 'digest');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-automation-daily-digest"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="automations-panel-overview-watcher-release-watch"]',
      ),
    ).toBeNull();
  });

  it('derives the displayed next run from the trigger instead of stale scheduler metadata', () => {
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'future-send',
          schedule: {
            kind: 'one_time',
            runAt: '2099-06-01T15:00:00.000Z',
            timezone: 'local',
          },
          // Renderer contracts explicitly treat local trigger calculation as
          // authoritative because this scheduler snapshot may lag.
          nextRunAt: '2000-01-01T00:00:00.000Z',
        }),
      ],
    });
    renderPanel({ variant: 'overview' });

    const row = container.querySelector(
      '[data-testid="automations-panel-overview-automation-future-send"]',
    );
    expect(row?.textContent).toContain('2099');
    expect(row?.textContent).not.toContain('2000');

    // The row opens the automation's runs in the main window's edit shell.
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(openedTarget()).toEqual({
      kind: 'automation',
      activityId: 'future-send',
      section: 'runs',
    });
  });

  it('shows upcoming occurrences and opens the runs from an entry', () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'soon-send',
          schedule: { kind: 'one_time', runAt: soon, timezone: 'local' },
        }),
      ],
    });
    renderPanel({ variant: 'upcoming' });
    const entry = container.querySelector(
      '[data-testid^="automations-panel-upcoming-soon-send"]',
    );
    expect(entry).not.toBeNull();
    act(() => {
      entry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openedTarget()).toEqual({
      kind: 'automation',
      activityId: 'soon-send',
      section: 'runs',
    });
    // The panel draws no details dialog of its own any more.
    expect(
      container.querySelector('[data-testid="automation-details-modal"]'),
    ).toBeNull();
  });

  it('merges completed runs and watcher fires and opens each row type', () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'a-1' })],
      recentRuns: [
        run({
          id: 'r-1',
          activityId: 'a-1',
          status: 'failure',
          error: 'boom',
        }),
      ],
    });
    useAppAdvisorWatchersStore.setState({
      completedWatchers: [
        watcher({
          id: 'fired-1',
          status: 'fired',
          firedAt: '2026-08-30T11:30:00.000Z',
        }),
      ],
    });
    renderPanel({ variant: 'completed' });

    const runRow = container.querySelector(
      '[data-testid="automations-panel-completed-run:r-1"]',
    );
    expect(runRow).not.toBeNull();
    act(() => {
      runRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openedTarget()).toEqual({
      kind: 'automation',
      activityId: 'a-1',
      section: 'runs',
    });

    const fireRow = container.querySelector(
      '[data-testid="automations-panel-completed-watcher:fired-1"]',
    );
    expect(fireRow).not.toBeNull();
    act(() => {
      fireRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Watcher');
  });

  it('keeps an open watcher modal synchronized with the live watcher store and closes when the watcher disappears', () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [watcher({ id: 'release-watch', label: 'Original label' })],
    });
    renderPanel({ variant: 'overview' });

    click('automations-panel-overview-watcher-release-watch');
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]')
        ?.textContent,
    ).toContain('Original label');

    act(() => {
      useAppAdvisorWatchersStore.setState({
        watchers: [watcher({ id: 'release-watch', label: 'Updated label' })],
      });
    });
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]')
        ?.textContent,
    ).toContain('Updated label');

    act(() => {
      useAppAdvisorWatchersStore.setState({ watchers: [] });
    });
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).toBeNull();
  });

  it('portals watcher details into the adopted panel document and handles Escape there', () => {
    useAppAdvisorWatchersStore.setState({
      watchers: [watcher({ id: 'release-watch' })],
    });
    renderPanel({ variant: 'overview' });

    const auxiliaryDocument = document.implementation.createHTMLDocument();
    auxiliaryDocument.body.appendChild(container);
    click('automations-panel-overview-watcher-release-watch');

    expect(
      auxiliaryDocument.body.querySelector(
        '[data-testid="watcher-management-modal"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="watcher-management-modal"]'),
    ).toBeNull();

    act(() => {
      auxiliaryDocument.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      auxiliaryDocument.body.querySelector(
        '[data-testid="watcher-management-modal"]',
      ),
    ).toBeNull();
  });

  it('opens a new automation draft seeded with the panel worktree', () => {
    renderPanel();
    click('automations-panel-add');

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(openedTarget()).toEqual({
      kind: 'automation-draft',
      draftKey: expect.any(String) as unknown,
      seed: { projectId: 'ws-1', isCowork: false, existingWorktreeId: 'wt-1' },
    });
    // The form opens in the main window's shell, not in the panel.
    expect(
      container.querySelector('[data-testid="automations-form-workspace"]'),
    ).toBeNull();
  });

  it('seeds a cowork draft with its project and no worktree', () => {
    renderPanel({ projectId: 'cowork-1', worktreeId: 'entry-1' });
    click('automations-panel-add');

    expect(openedTarget()).toEqual({
      kind: 'automation-draft',
      draftKey: expect.any(String) as unknown,
      seed: { projectId: 'cowork-1', isCowork: true },
    });
  });

  it('opens a fresh draft each time New is pressed', () => {
    renderPanel();
    click('automations-panel-add');
    const first = useNavigationStore.getState().workflowEdit;
    act(() => {
      useNavigationStore.setState({ workflowEdit: undefined });
    });
    click('automations-panel-add');
    const second = useNavigationStore.getState().workflowEdit;

    expect(first?.kind).toBe('automation-draft');
    expect(second?.kind).toBe('automation-draft');
    if (
      first?.kind !== 'automation-draft' ||
      second?.kind !== 'automation-draft'
    ) {
      throw new Error('expected two drafts');
    }
    expect(second.draftKey).not.toBe(first.draftKey);
  });

  it('brings the main window forward from a popped-out panel, and only from one', () => {
    const focus = jest.spyOn(window, 'focus').mockImplementation(() => {});
    useAutomationsStore.setState({
      activities: [activity({ id: 'daily-digest' })],
    });
    renderPanel();

    // In the main window the shell is already in front.
    click('automations-panel-overview-automation-daily-digest');
    expect(focus).not.toHaveBeenCalled();

    // A pop-out adopts the panel into its own document.
    const auxiliaryDocument = document.implementation.createHTMLDocument();
    auxiliaryDocument.body.appendChild(container);
    act(() => {
      useNavigationStore.setState({ workflowEdit: undefined });
    });
    click('automations-panel-overview-automation-daily-digest');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(openedTarget()).toEqual({
      kind: 'automation',
      activityId: 'daily-digest',
      section: 'runs',
    });

    click('automations-panel-add');
    expect(focus).toHaveBeenCalledTimes(2);
    expect(useNavigationStore.getState().workflowEdit?.kind).toBe(
      'automation-draft',
    );
  });

  it('reports the panel context for App Advisor with its own dialog flags off', () => {
    useAutomationsStore.setState({
      activities: [activity({ id: 'daily-digest' })],
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [watcher({ id: 'release-watch' })],
    });
    renderPanel({ variant: 'overview' });

    expect(
      useCurrentUiStateStore.getState().slices['automations.panel.panel-1'],
    ).toEqual({
      panelId: 'panel-1',
      variant: 'overview',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      detailsModalOpen: false,
      sharedPipelineReviewModalOpen: false,
      watcherModalOpen: false,
      formOpen: false,
    });

    // Runs and the form open in the main window's shell, which reports
    // them itself; the panel's own flags stay off.
    click('automations-panel-overview-automation-daily-digest');
    expect(openedTarget()).toEqual(
      expect.objectContaining({ activityId: 'daily-digest' }),
    );
    expect(
      useCurrentUiStateStore.getState().slices['automations.panel.panel-1'],
    ).toEqual(
      expect.objectContaining({
        detailsModalOpen: false,
        formOpen: false,
      }),
    );
    expect(
      useCurrentUiStateStore.getState().slices['automations.panel.panel-1'],
    ).not.toHaveProperty('detailsModalActivityId');
  });

  it('keeps UI-state reporters isolated across mounted panel instances', () => {
    act(() => {
      root.render(
        createElement('div', null, [
          createElement(AutomationsPanel, {
            key: 'panel-overview',
            panelId: 'panel-overview',
            variant: 'overview',
            projectId: 'ws-1',
            worktreeId: 'wt-1',
          }),
          createElement(AutomationsPanel, {
            key: 'panel-completed',
            panelId: 'panel-completed',
            variant: 'completed',
            projectId: 'ws-1',
            worktreeId: 'wt-1',
          }),
        ]),
      );
    });

    expect(
      useCurrentUiStateStore.getState().slices[
        'automations.panel.panel-overview'
      ],
    ).toEqual(expect.objectContaining({ variant: 'overview' }));
    expect(
      useCurrentUiStateStore.getState().slices[
        'automations.panel.panel-completed'
      ],
    ).toEqual(expect.objectContaining({ variant: 'completed' }));

    act(() => {
      root.render(
        createElement(AutomationsPanel, {
          panelId: 'panel-completed',
          variant: 'completed',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      );
    });

    expect(
      useCurrentUiStateStore.getState().slices[
        'automations.panel.panel-overview'
      ],
    ).toBeUndefined();
    expect(
      useCurrentUiStateStore.getState().slices[
        'automations.panel.panel-completed'
      ],
    ).toEqual(expect.objectContaining({ variant: 'completed' }));
  });

  it('lists the automation in every section and the watcher once', () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    useAutomationsStore.setState({
      activities: [
        activity({
          id: 'acme-1',
          name: 'Acme payments standup',
          schedule: { kind: 'one_time', runAt: soon, timezone: 'local' },
        }),
      ],
      recentRuns: [
        run({
          id: 'r-1',
          activityId: 'acme-1',
          activityName: 'Acme payments standup',
        }),
      ],
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [watcher({ id: 'w-1', label: 'Acme deploy watcher' })],
    });
    renderPanel();

    const cells = (text: string): Element[] =>
      Array.from(container.querySelectorAll('span, td')).filter(
        (element) => element.textContent === text,
      );

    // Upcoming, Overview, and Completed each list the automation.
    expect(cells('Acme payments standup')).toHaveLength(3);
    expect(cells('Acme deploy watcher')).toHaveLength(1);
  });
});
