/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention;
 * @testing-library/react is not installed.
 *
 * Whether an automation's "Existing chat" destination (CAN-2937) can take its
 * next run. The edit shell keeps Run now disabled while `blocked` is true; the
 * shell's own suite is `workflows/edit/__tests__/AutomationEditAdapter.test.tsx`.
 */
import { act, createElement, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useAutomationChatTargetAvailability } from '../useAutomationChatTargetAvailability';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useProjectsStore } from '@/stores/projectsStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type Projects = ReturnType<typeof useProjectsStore.getState>['projects'];

function activityFixture(): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Nightly sweep',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the day' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function sessionActivity(
  action: Partial<ScheduledActivity['action']> = {},
): ScheduledActivity {
  return {
    ...activityFixture(),
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Continue',
      workspaceName: 'Canopy',
      worktreeName: 'feature/one',
      chatTitle: 'Implementation chat',
      ...action,
    } as ScheduledActivity['action'],
  };
}

const CANOPY_PROJECTS = [
  {
    id: 'ws-1',
    name: 'Canopy',
    type: 'single-repo',
    repoPath: '/repo',
    color: 'blue',
    worktrees: [
      { id: 'wt-1', branchName: 'feature/one', createdAt: '2026-09-01' },
    ],
  },
] as unknown as Projects;

/**
 * Prefers the store's live copy over the prop snapshot, as the edit shell
 * does, and renders only whether Run now is blocked.
 */
function Probe({
  activity: snapshot,
}: {
  readonly activity: ScheduledActivity;
}): ReactElement {
  const live = useAutomationsStore((s) =>
    s.activities.find((entry) => entry.id === snapshot.id),
  );
  const { blocked } = useAutomationChatTargetAvailability(live ?? snapshot);
  return createElement('span', { 'data-testid': 'blocked' }, String(blocked));
}

/** The store's live copy wins, so the fixture is seeded in both places. */
function renderActivity(activity: ScheduledActivity): void {
  useAutomationsStore.setState({ activities: [activity], recentRuns: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(Probe, { activity }));
  });
}

function unmount(): void {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

/** Whether the shell's Run now would be blocked by the chat target. */
function blocked(): string | null | undefined {
  return document.querySelector('[data-testid="blocked"]')?.textContent;
}

/** Flush the async target check plus the resulting re-render. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function api(): {
  chat: { loadTabs: jest.Mock };
  workEntries: { list: jest.Mock };
} {
  return window.api as unknown as {
    chat: { loadTabs: jest.Mock };
    workEntries: { list: jest.Mock };
  };
}

function tabs(
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return { version: 1, activeTabId: 'chat-1', tabs: entries };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        loadTabs: jest.fn().mockResolvedValue(tabs([])),
      },
      workEntries: {
        list: jest.fn().mockResolvedValue({ entries: [] }),
      },
    },
  });
  useProjectsStore.setState({ projects: [] });
  useAutomationsStore.setState({
    activities: [activityFixture()],
    recentRuns: [],
  });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = '';
});

describe('useAutomationChatTargetAvailability (CAN-2937)', () => {
  it('never blocks a new chat each run in a worktree', async () => {
    renderActivity({
      ...activityFixture(),
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'Catch up',
      },
    });
    await settle();

    expect(blocked()).toBe('false');
  });

  it('never blocks an App Advisor prompt with a new chat each run', async () => {
    renderActivity(activityFixture());
    await settle();

    expect(blocked()).toBe('false');
    expect(api().chat.loadTabs).not.toHaveBeenCalled();
  });

  it('does not block an existing-chat destination that still resolves', async () => {
    api().chat.loadTabs.mockResolvedValue(
      tabs([{ id: 'chat-1', title: 'Implementation chat' }]),
    );
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });

    renderActivity(sessionActivity());
    await settle();

    expect(api().chat.loadTabs).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    expect(blocked()).toBe('false');
  });

  it('blocks until an existing-chat destination finishes validating', () => {
    api().chat.loadTabs.mockReturnValue(new Promise(() => undefined));
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });

    renderActivity(sessionActivity());

    expect(blocked()).toBe('true');
  });

  it('blocks immediately when the live activity changes destination', async () => {
    api()
      .chat.loadTabs.mockResolvedValueOnce(
        tabs([{ id: 'chat-1', title: 'Implementation chat' }]),
      )
      .mockReturnValueOnce(new Promise(() => undefined));
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });

    renderActivity(sessionActivity());
    await settle();
    expect(blocked()).toBe('false');

    flushSync(() => {
      useAutomationsStore.setState({
        activities: [
          sessionActivity({ chatId: 'chat-2', chatTitle: 'Replacement chat' }),
        ],
      });
    });

    expect(blocked()).toBe('true');
  });

  it('blocks an existing-chat destination whose chat is gone', async () => {
    useProjectsStore.setState({ projects: [] });

    renderActivity(sessionActivity());
    await settle();

    expect(blocked()).toBe('true');
  });

  it('blocks an existing-chat destination whose workspace is gone', async () => {
    renderActivity(
      sessionActivity({
        workspaceId: 'workspace-missing',
        worktreeId: 'worktree-1',
        workspaceName: undefined,
        worktreeName: undefined,
        chatTitle: undefined,
      } as Partial<ScheduledActivity['action']>),
    );
    await settle();

    expect(blocked()).toBe('true');
  });

  it('blocks an archived read-only target for future runs', async () => {
    api().chat.loadTabs.mockResolvedValue(
      tabs([{ id: 'chat-1', title: 'Archived chat', readOnly: true }]),
    );
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });

    renderActivity(sessionActivity());
    await settle();

    expect(blocked()).toBe('true');
  });

  it('blocks an existing Cursor target for future runs', async () => {
    api().chat.loadTabs.mockResolvedValue(
      tabs([{ id: 'chat-1', title: 'Cursor chat', providerType: 'cursor' }]),
    );
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });

    renderActivity(sessionActivity());
    await settle();

    expect(blocked()).toBe('true');
  });

  it('blocks a persisted file tab for future runs', async () => {
    api().chat.loadTabs.mockResolvedValue(
      tabs([{ id: 'chat-1', title: 'README.md', kind: 'file' }]),
    );
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });

    renderActivity(sessionActivity());
    await settle();

    expect(blocked()).toBe('true');
  });

  it('validates an App Advisor existing-chat destination', async () => {
    api().workEntries.list.mockResolvedValue({
      entries: [{ id: 'aa-entry-1', title: 'Release prep' }],
    });
    api().chat.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'aa-chat-1',
      tabs: [{ id: 'aa-chat-1', title: 'Checklist' }],
    });
    renderActivity(
      sessionActivity({
        workspaceId: 'app-advisor',
        worktreeId: 'aa-entry-1',
        chatId: 'aa-chat-1',
        workspaceName: undefined,
        worktreeName: undefined,
        chatTitle: 'Checklist',
      } as Partial<ScheduledActivity['action']>),
    );
    await settle();

    expect(api().workEntries.list).toHaveBeenCalledWith({
      projectId: 'app-advisor',
    });
    expect(blocked()).toBe('false');
  });

  it('allows a new chat in an existing Work Entry and blocks when the entry is gone', async () => {
    const action: ScheduledActivity['action'] = {
      type: 'app_advisor_prompt',
      workEntryId: 'aa-entry-1',
      prompt: 'Summarize the day',
    };
    api().workEntries.list.mockResolvedValue({
      entries: [{ id: 'aa-entry-1', title: 'Release prep' }],
    });
    renderActivity({ ...activityFixture(), action });
    await settle();
    expect(blocked()).toBe('false');
    unmount();

    api().workEntries.list.mockResolvedValue({ entries: [] });
    renderActivity({ ...activityFixture(), action });
    await settle();
    expect(blocked()).toBe('true');
  });

  it('allows a new chat in an existing worktree that still exists', async () => {
    useProjectsStore.setState({ projects: CANOPY_PROJECTS });
    renderActivity({
      ...activityFixture(),
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'Catch up',
      },
    });
    await settle();

    expect(blocked()).toBe('false');
    // A new chat each run needs only the container, not a tab.
    expect(api().chat.loadTabs).not.toHaveBeenCalled();
  });

  it('never blocks pipeline or resume actions', async () => {
    renderActivity({
      ...activityFixture(),
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'ws-1',
        pipelineId: 'pipe-1',
      },
    });
    await settle();
    expect(blocked()).toBe('false');
    unmount();

    renderActivity({
      ...activityFixture(),
      action: {
        type: 'pipeline_execution_resume',
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
        provider: 'claude',
        purpose: 'usage_limit_resume',
        pipelineName: 'Release',
      },
    });
    await settle();
    expect(blocked()).toBe('false');
  });
});
