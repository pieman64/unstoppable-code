/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see
 * CollectionsTab.test.tsx) rather than @testing-library/react, which is not
 * a dependency of this workspace.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AutomationsListResponse,
  ResumeQueueEntry,
  ResumeQueueSnapshot,
  ScheduledActivity,
  UsageLimitedChatGroup,
  UsageLimitedChatTarget,
  UsageLimitedSessionGroup,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { recordCodeReviewOrigin } from '@/stores/chat/code-review-registry';
import { brandText } from '@/lib/brand';
import { UsageLimitResumeModal } from '../UsageLimitResumeModal';
import type * as OpenResumedSessionModule from '@/lib/usage-limit/open-resumed-session';
import { filterSessionGroupsByWorkspace } from '../usageLimitResumeScope';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const clearResumedChatUsageLimitBannerMock = jest.fn();
jest.mock('@/stores/chatStore', () => ({
  clearResumedChatUsageLimitBanner: (target: UsageLimitedChatTarget): void => {
    clearResumedChatUsageLimitBannerMock(target);
  },
}));

const openResumeQueueEntryMock = jest.fn<
  Promise<unknown>,
  [ResumeQueueEntry]
>();
jest.mock('@/lib/usage-limit/open-resumed-session', () => ({
  ...jest.requireActual<typeof OpenResumedSessionModule>(
    '@/lib/usage-limit/open-resumed-session',
  ),
  openResumeQueueEntry: (entry: ResumeQueueEntry): Promise<unknown> =>
    openResumeQueueEntryMock(entry),
}));

const groups: UsageLimitedChatGroup[] = [
  {
    workspaceId: 'ws-a',
    workspaceName: 'Workspace A',
    workspaceType: 'single-repo',
    workspaceColor: '#3b82f6',
    chats: [
      {
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c1',
        provider: 'claude',
        chatTitle: 'One',
        detectedAt: 1,
        worktreeName: 'feature-branch',
      },
      {
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c2',
        provider: 'claude',
        chatTitle: 'Two',
        detectedAt: 2,
        worktreeName: 'feature-branch',
      },
    ],
  },
];

const nestedGroups: UsageLimitedChatGroup[] = [
  {
    workspaceId: 'code-ws',
    workspaceName: 'Code WS',
    workspaceType: 'single-repo',
    workspaceColor: '#ef4444',
    chats: [
      {
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        chatId: 'a1',
        provider: 'claude',
        chatTitle: 'A1',
        detectedAt: 1,
        worktreeName: 'main',
      },
      {
        projectId: 'code-ws',
        worktreeId: 'wt-2',
        chatId: 'b1',
        provider: 'claude',
        chatTitle: 'B1',
        detectedAt: 2,
        worktreeName: 'feature-x',
      },
    ],
  },
  {
    workspaceId: 'cowork-ws',
    workspaceName: 'Cowork WS',
    workspaceType: 'cowork',
    chats: [
      {
        projectId: 'cowork-ws',
        worktreeId: 'home',
        chatId: 'k1',
        provider: 'claude',
        chatTitle: 'K1',
        detectedAt: 3,
        worktreeName: '',
      },
    ],
  },
];

it('scopes Home resume groups using the session or group workspace', () => {
  const sessionGroups: UsageLimitedSessionGroup[] = [
    {
      groupId: 'org-a',
      groupKind: 'workspace',
      workspaceId: 'org-a',
      workspaceName: 'Org A',
      sessions: [
        { ...groups[0].chats[0], projectId: 'org-a', kind: 'chat' },
        {
          kind: 'pipeline',
          executionId: 'pipeline-a',
          statusReasonIds: ['reason-a'],
          pipelineName: 'Pipeline A',
          detectedAt: 1,
          pausedStepCount: 1,
          modelLabels: [],
          otherBlockingReasonCount: 0,
        },
      ],
    },
    {
      groupId: 'org-b',
      groupKind: 'workspace',
      workspaceId: 'org-b',
      workspaceName: 'Org B',
      sessions: [{ ...groups[0].chats[0], projectId: 'org-b', kind: 'chat' }],
    },
  ];

  expect(
    filterSessionGroupsByWorkspace(
      sessionGroups,
      (workspaceId) => workspaceId === 'org-a',
    ),
  ).toEqual([sessionGroups[0]]);
});

it('scopes Code Review interruptions using their real workspace origin', () => {
  const scopeKey = 'org-a--review-worktree-resume-test';
  recordCodeReviewOrigin(scopeKey, {
    projectId: 'org-a',
    worktreeId: 'review-worktree',
  });
  const codeReviewGroup: UsageLimitedSessionGroup = {
    groupId: CODE_REVIEW_CHAT_PROJECT_ID,
    groupKind: 'workspace',
    workspaceId: CODE_REVIEW_CHAT_PROJECT_ID,
    workspaceName: 'Code Review',
    sessions: [
      {
        ...groups[0].chats[0],
        kind: 'chat',
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: scopeKey,
      },
    ],
  };

  expect(
    filterSessionGroupsByWorkspace(
      [codeReviewGroup],
      (workspaceId) => workspaceId === 'org-a',
    ),
  ).toEqual([codeReviewGroup]);
});

it('uses the persisted Code Review group workspace after a renderer restart', () => {
  const codeReviewGroup: UsageLimitedSessionGroup = {
    groupId: 'org-a',
    groupKind: 'workspace',
    workspaceId: 'org-a',
    workspaceName: 'Organization A',
    sessions: [
      {
        ...groups[0].chats[0],
        kind: 'chat',
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'unregistered-review-scope',
      },
    ],
  };

  expect(
    filterSessionGroupsByWorkspace(
      [codeReviewGroup],
      (workspaceId) => workspaceId === 'org-a',
    ),
  ).toEqual([codeReviewGroup]);
});

const listUsageLimitedIdleChatsMock = jest.fn();
const resumeUsageLimitedChatsMock = jest.fn();
const enqueueResumeQueueMock = jest.fn();
const cancelCodexLoginMock = jest.fn();

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listUsageLimitedIdleChats: listUsageLimitedIdleChatsMock,
      resumeUsageLimitedChats: resumeUsageLimitedChatsMock,
      enqueueResumeQueue: enqueueResumeQueueMock,
      codexLogin: {
        cancel: cancelCodexLoginMock,
        retryVerification: jest.fn(),
      },
    },
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('UsageLimitResumeModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    listUsageLimitedIdleChatsMock.mockReset().mockResolvedValue(groups);
    resumeUsageLimitedChatsMock
      .mockReset()
      .mockResolvedValue({ resumedCount: 2, failedTargets: [] });
    enqueueResumeQueueMock.mockReset().mockResolvedValue({
      version: 1,
      revision: 1,
      paused: false,
      entries: [],
    });
    clearResumedChatUsageLimitBannerMock.mockReset();
    openResumeQueueEntryMock.mockReset().mockResolvedValue({ ok: true });
    cancelCodexLoginMock.mockReset().mockResolvedValue({
      attemptId: 'attempt-1',
      phase: 'complete',
      activeWorkCount: 1,
      outcome: 'cancelled',
    });
    installWindowApi();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useWorkspaceContextStore.setState({ hydrated: false });
    useProjectsStore.setState({ projects: [] });
    useLinkedPersonalWorkspacesStore.setState({
      ids: [],
      organizationId: null,
    });
    jest.mocked(useCurrentUiStateReporter).mockClear();

    useUsageLimitResumePromptStore.setState({
      authentication: null,
      isOpen: true,
      provider: 'claude',
      origin: 'account-change',
    });
    useResumeQueueStore.setState({
      snapshot: null,
      isOpen: false,
      connectionError: null,
      navigationError: null,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderModal(): Promise<void> {
    await act(async () => {
      root.render(createElement(UsageLimitResumeModal));
      await flushPromises();
    });
  }

  it('renders groups with all selected and a live counter', async () => {
    await renderModal();

    expect(document.body.textContent).toContain('Resume interrupted chats');
    expect(document.body.textContent).not.toContain(
      'Resume usage-limited sessions',
    );
    expect(document.body.textContent).toContain('Workspace A');
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-confirm"]',
    );
    expect(confirm?.textContent).toContain('2');
  });

  it.each(['account-change', 'usage-review', 'app-restart', 'home'] as const)(
    'ignores unrelated workspace refreshes while reviewing %s selections',
    async (origin) => {
      useUsageLimitResumePromptStore.getState().open('claude', origin);
      await renderModal();
      const checkbox = document.querySelector<HTMLInputElement>(
        '[data-testid="usage-limit-resume-chat-c1"]',
      );
      await act(async () => {
        checkbox?.click();
        await flushPromises();
      });
      const renderCount = jest.mocked(useCurrentUiStateReporter).mock.calls
        .length;
      await act(async () => {
        // Background worktree/status polling publishes a fresh projects array.
        useProjectsStore.setState({ projects: [] });
        await flushPromises();
      });
      expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledTimes(1);
      expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledWith({
        provider: 'claude',
        includeResumePreview: true,
      });
      expect(
        document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
      ).toBe(checkbox);
      expect(checkbox?.checked).toBe(false);
      expect(jest.mocked(useCurrentUiStateReporter).mock.calls).toHaveLength(
        renderCount,
      );
    },
  );

  it('reconciles a real Home scope change without resetting valid choices or refetching', async () => {
    const workspaces: SidebarItem[] = ['ws-a', 'ws-b'].map((id) => ({
      type: 'single-repo',
      id,
      name: id,
      repoPath: `/repos/${id}`,
      color: '#000000',
      collapsed: false,
      order: 0,
      worktrees: [],
    }));
    useProjectsStore.setState({ projects: workspaces });
    useFeatureFlagsStore.setState({
      snapshot: {
        ...getDefaultFeatureFlagSnapshot(),
        values: {
          ...getDefaultFeatureFlagSnapshot().values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'personal' },
        revision: 1,
        organizations: [],
      },
    });
    useUsageLimitResumePromptStore.getState().open(null, 'home');
    listUsageLimitedIdleChatsMock.mockResolvedValue([
      ...groups,
      {
        ...groups[0],
        workspaceId: 'ws-b',
        chats: [{ ...groups[0].chats[0], projectId: 'ws-b', chatId: 'c3' }],
      },
    ]);
    await renderModal();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-c1"]',
    );
    await act(async () => {
      checkbox?.click();
      await flushPromises();
    });
    await act(async () => {
      useProjectsStore.setState({
        projects: workspaces.map((workspace) =>
          workspace.id === 'ws-b'
            ? {
                ...workspace,
                owner: {
                  type: 'organization',
                  organizationId: 'org-b',
                  projectId: 'project-b',
                  instanceId: 'instance-b',
                  bindingGeneration: 0,
                },
              }
            : workspace,
        ),
      });
      await flushPromises();
    });
    expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBe(checkbox);
    expect(checkbox?.checked).toBe(false);
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c3"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="usage-limit-resume-confirm"]')
        ?.textContent,
    ).toBe('Resume chat');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-limit-resume-confirm"]',
        )
        ?.click();
      await flushPromises();
    });
    expect(enqueueResumeQueueMock).toHaveBeenCalledWith({
      targets: [
        { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c2' },
      ],
    });
  });

  it('refreshes changed sessions in place, preserving valid choices and leaving new sessions unchecked', async () => {
    await renderModal();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-c1"]',
    );
    await act(async () => {
      checkbox?.click();
      await flushPromises();
    });
    const renderCount = jest.mocked(useCurrentUiStateReporter).mock.calls
      .length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledTimes(2);
    expect(jest.mocked(useCurrentUiStateReporter).mock.calls).toHaveLength(
      renderCount,
    );
    listUsageLimitedIdleChatsMock.mockResolvedValue([
      {
        ...groups[0],
        chats: [
          ...groups[0].chats,
          {
            ...groups[0].chats[0],
            chatId: 'c3',
            chatTitle: 'New interruption',
          },
        ],
      },
    ]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBe(checkbox);
    expect(checkbox?.checked).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="usage-limit-resume-chat-c2"]',
      )?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="usage-limit-resume-chat-c3"]',
      )?.checked,
    ).toBe(false);
    listUsageLimitedIdleChatsMock.mockResolvedValue([
      { ...groups[0], chats: [groups[0].chats[0]] },
    ]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBe(checkbox);
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c2"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="usage-limit-resume-confirm"]',
      )?.disabled,
    ).toBe(true);
  });

  it('coalesces overlapping refreshes and preserves choices made while loading', async () => {
    await renderModal();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-c1"]',
    );
    let resolveRefresh: (result: UsageLimitedChatGroup[]) => void = () =>
      undefined;
    listUsageLimitedIdleChatsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      checkbox?.click();
      await flushPromises();
    });
    expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBe(checkbox);
    expect(document.body.textContent).not.toContain('Loading interrupted work');
    await act(async () => {
      resolveRefresh([{ ...groups[0], workspaceName: 'Renamed workspace' }]);
      await flushPromises();
    });
    expect(document.body.textContent).toContain('Renamed workspace');
    expect(checkbox?.checked).toBe(false);
  });

  it('keeps pending selections usable when a background refresh fails', async () => {
    await renderModal();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-c1"]',
    );
    await act(async () => {
      checkbox?.click();
      await flushPromises();
    });
    listUsageLimitedIdleChatsMock.mockRejectedValueOnce(
      new Error('Refresh failed'),
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBe(checkbox);
    expect(checkbox?.checked).toBe(false);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="usage-limit-resume-confirm"]',
      )?.disabled,
    ).toBe(false);
    expect(document.body.textContent).not.toContain(
      'Couldn’t load interrupted work.',
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(checkbox?.checked).toBe(false);
    expect(document.body.textContent).not.toContain(
      'Couldn’t load interrupted work.',
    );
  });

  it('defaults a newly opened prompt to all selected after dismissing pending choices', async () => {
    await renderModal();
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="usage-limit-resume-chat-c1"]',
        )
        ?.click();
      useUsageLimitResumePromptStore.getState().close();
      await flushPromises();
    });
    await act(async () => {
      useUsageLimitResumePromptStore.getState().open('claude');
      await flushPromises();
    });
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="usage-limit-resume-chat-c1"]',
      )?.checked,
    ).toBe(true);
    expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledTimes(2);
  });

  it('preserves choices when authentication verification finishes for the same attempt', async () => {
    useUsageLimitResumePromptStore.getState().openAuthentication({
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      activeWorkCount: 2,
      error: 'Verification failed',
    });
    await renderModal();
    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-c1"]',
    );
    await act(async () => {
      checkbox?.click();
      await flushPromises();
    });
    await act(async () => {
      useUsageLimitResumePromptStore.getState().updateAuthentication({
        attemptId: 'attempt-1',
        phase: 'complete',
        activeWorkCount: 2,
        outcome: 'success',
        account: {
          authenticated: true,
          accountLabel: 'codex@example.com',
          detail: null,
          error: null,
        },
      });
      await flushPromises();
    });
    expect(listUsageLimitedIdleChatsMock).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBe(checkbox);
    expect(checkbox?.checked).toBe(false);
  });

  it('ignores a failed load after switching to a different prompt', async () => {
    let rejectOldLoad: (reason: Error) => void = () => undefined;
    listUsageLimitedIdleChatsMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOldLoad = reject;
        }),
    );
    await renderModal();
    await act(async () => {
      useUsageLimitResumePromptStore.getState().open('codex', 'usage-review');
      await flushPromises();
    });
    await act(async () => {
      rejectOldLoad(new Error('Old load failed'));
      await flushPromises();
    });
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      'Couldn’t load interrupted work.',
    );
  });

  it('does not rerender unchanged modal state when its parent renders', async () => {
    await renderModal();
    const renderCount = jest.mocked(useCurrentUiStateReporter).mock.calls
      .length;
    await renderModal();
    expect(jest.mocked(useCurrentUiStateReporter).mock.calls).toHaveLength(
      renderCount,
    );
  });

  it('deselect-all zeroes the counter and disables confirm', async () => {
    await renderModal();

    const selectAll = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-select-all"]',
    );
    await act(async () => {
      selectAll?.click();
      await flushPromises();
    });

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-confirm"]',
    );
    expect(confirm?.disabled).toBe(true);
  });

  it('confirm resumes selected targets and closes', async () => {
    await renderModal();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-confirm"]',
    );
    await act(async () => {
      confirm?.click();
      await flushPromises();
    });

    expect(enqueueResumeQueueMock).toHaveBeenCalledWith({
      targets: [
        { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c1' },
        { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c2' },
      ],
    });
    expect(resumeUsageLimitedChatsMock).not.toHaveBeenCalled();
    expect(clearResumedChatUsageLimitBannerMock).not.toHaveBeenCalled();
    expect(useResumeQueueStore.getState().isOpen).toBe(true);
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  describe('a single confirmed chat', () => {
    const [firstGroup] = groups;
    const singleChat: UsageLimitedChatGroup[] = firstGroup
      ? [{ ...firstGroup, chats: firstGroup.chats.slice(0, 1) }]
      : [];
    const waitingEntry: ResumeQueueEntry = {
      id: 'resume-c1',
      createdAt: 1,
      status: 'waiting',
      target: {
        kind: 'chat',
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c1',
      },
      title: 'One',
      workspaceName: 'Workspace A',
      interruptionId: 'i-1',
    };
    const queueWith = (
      entries: ResumeQueueEntry[],
      extra: Partial<ResumeQueueSnapshot> = {},
    ): ResumeQueueSnapshot => ({
      version: 1,
      revision: 2,
      paused: false,
      entries,
      ...extra,
    });

    async function confirmOnce(): Promise<void> {
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-limit-resume-confirm"]',
          )
          ?.click();
        await flushPromises();
      });
    }

    beforeEach(() => {
      listUsageLimitedIdleChatsMock.mockResolvedValue(singleChat);
    });

    it('opens the chat instead of the queue', async () => {
      enqueueResumeQueueMock.mockResolvedValue(queueWith([waitingEntry]));
      await renderModal();
      await confirmOnce();

      expect(openResumeQueueEntryMock).toHaveBeenCalledWith(waitingEntry);
      expect(useResumeQueueStore.getState().isOpen).toBe(false);
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
    });

    it('opens a reply that finished before enqueue returned', async () => {
      const resumed: ResumeQueueEntry = { ...waitingEntry, status: 'resumed' };
      enqueueResumeQueueMock.mockResolvedValue(queueWith([resumed]));
      await renderModal();
      await confirmOnce();

      expect(openResumeQueueEntryMock).toHaveBeenCalledWith(resumed);
      expect(useResumeQueueStore.getState().isOpen).toBe(false);
    });

    it('keeps the confirmation and error when enqueue rejects', async () => {
      enqueueResumeQueueMock.mockRejectedValue(new Error('offline'));
      await renderModal();
      await confirmOnce();
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
      expect(document.body.textContent).toContain(
        'Some work couldn’t be resumed. Try again.',
      );
      expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
      expect(enqueueResumeQueueMock).toHaveBeenCalledTimes(1);
    });

    it('clears an earlier navigation error on a new successful enqueue', async () => {
      useResumeQueueStore.setState({
        navigationError: 'Old navigation failure',
      });
      enqueueResumeQueueMock.mockResolvedValue(queueWith([waitingEntry]));
      await renderModal();
      await confirmOnce();
      expect(useResumeQueueStore.getState().navigationError).toBeNull();
    });

    it.each<[string, ResumeQueueSnapshot]>([
      ['paused', queueWith([waitingEntry], { paused: true })],
      ['erroring', queueWith([waitingEntry], { error: 'Queue failed' })],
      ['without a match', queueWith([])],
      [
        'busy with another session',
        queueWith([
          waitingEntry,
          {
            ...waitingEntry,
            id: 'resume-other',
            target: {
              kind: 'chat',
              projectId: 'ws-a',
              worktreeId: 'wt',
              chatId: 'other',
            },
          },
        ]),
      ],
    ])('opens the queue when it is %s', async (_label, snapshot) => {
      enqueueResumeQueueMock.mockResolvedValue(snapshot);
      await renderModal();
      await confirmOnce();

      expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
      expect(useResumeQueueStore.getState().isOpen).toBe(true);
    });

    it('opens the queue with an error when the chat cannot open, without enqueueing again', async () => {
      enqueueResumeQueueMock.mockResolvedValue(queueWith([waitingEntry]));
      openResumeQueueEntryMock.mockResolvedValue({
        ok: false,
        error: 'This chat is no longer available.',
      });
      await renderModal();
      await confirmOnce();

      expect(enqueueResumeQueueMock).toHaveBeenCalledTimes(1);
      expect(useResumeQueueStore.getState()).toMatchObject({
        isOpen: true,
        navigationError: 'This chat is no longer available.',
      });
    });

    it('enqueues once when confirmed twice while pending', async () => {
      let resolveEnqueue: (snapshot: ResumeQueueSnapshot) => void = () =>
        undefined;
      enqueueResumeQueueMock.mockReturnValue(
        new Promise<ResumeQueueSnapshot>((resolve) => {
          resolveEnqueue = resolve;
        }),
      );
      await renderModal();
      const confirm = document.querySelector<HTMLButtonElement>(
        '[data-testid="usage-limit-resume-confirm"]',
      );
      await act(async () => {
        confirm?.click();
        confirm?.click();
        await flushPromises();
      });
      await act(async () => {
        resolveEnqueue(queueWith([waitingEntry]));
        await flushPromises();
      });

      expect(enqueueResumeQueueMock).toHaveBeenCalledTimes(1);
      expect(openResumeQueueEntryMock).toHaveBeenCalledTimes(1);
    });
  });

  it('durably enqueues authentication recovery selections', async () => {
    const listSessions = jest.fn().mockResolvedValue([
      {
        groupId: 'ws-a',
        groupKind: 'workspace',
        workspaceId: 'ws-a',
        workspaceName: 'Workspace A',
        workspaceType: 'single-repo',
        sessions: [
          {
            ...groups[0].chats[0],
            kind: 'chat',
            provider: 'codex',
            resumeReason: 'provider_sign_in',
            authenticationAttemptId: 'attempt-1',
          },
        ],
      },
    ]);
    const resumeSessions = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleSessions: listSessions,
        resumeUsageLimitedSessions: resumeSessions,
        enqueueResumeQueue: enqueueResumeQueueMock,
      },
    });
    useUsageLimitResumePromptStore.getState().openAuthentication({
      attemptId: 'attempt-1',
      phase: 'complete',
      activeWorkCount: 1,
      outcome: 'success',
      account: {
        authenticated: true,
        accountLabel: 'codex@example.com',
        detail: null,
        error: null,
      },
    });

    await renderModal();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-limit-resume-confirm"]',
        )
        ?.click();
      await flushPromises();
    });

    expect(enqueueResumeQueueMock).toHaveBeenCalledWith({
      authenticationAttemptId: 'attempt-1',
      targets: [
        { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c1' },
      ],
    });
    expect(resumeSessions).not.toHaveBeenCalled();
    expect(useResumeQueueStore.getState().isOpen).toBe(true);
  });

  it('keeps failed targets open and only clears banners for successful targets', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleChats: listUsageLimitedIdleChatsMock,
        resumeUsageLimitedChats: resumeUsageLimitedChatsMock,
      },
    });
    resumeUsageLimitedChatsMock.mockReset().mockResolvedValue({
      resumedCount: 1,
      failedTargets: [{ projectId: 'ws-a', worktreeId: 'wt', chatId: 'c2' }],
    });

    await renderModal();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-confirm"]',
    );
    await act(async () => {
      confirm?.click();
      await flushPromises();
    });

    expect(clearResumedChatUsageLimitBannerMock).toHaveBeenCalledWith({
      projectId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c1',
    });
    expect(clearResumedChatUsageLimitBannerMock).not.toHaveBeenCalledWith({
      projectId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c2',
    });
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
    expect(document.body.textContent).toContain(
      'Some work couldn’t be resumed. Try again.',
    );
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c1"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="usage-limit-resume-chat-c2"]'),
    ).not.toBeNull();
  });

  it('keeps a resume failure visible after a successful background refresh', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleChats: listUsageLimitedIdleChatsMock,
        resumeUsageLimitedChats: resumeUsageLimitedChatsMock,
      },
    });
    resumeUsageLimitedChatsMock.mockResolvedValue({
      resumedCount: 0,
      failedTargets: groups[0].chats.map(
        ({ projectId, worktreeId, chatId }) => ({
          projectId,
          worktreeId,
          chatId,
        }),
      ),
    });
    await renderModal();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-limit-resume-confirm"]',
        )
        ?.click();
      await flushPromises();
    });
    expect(document.body.textContent).toContain(
      'Some work couldn’t be resumed. Try again.',
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(document.body.textContent).toContain(
      'Some work couldn’t be resumed. Try again.',
    );
  });

  it('nests code-workspace chats under per-worktree sub-headers and keeps cowork flat', async () => {
    listUsageLimitedIdleChatsMock.mockReset().mockResolvedValue(nestedGroups);

    await renderModal();

    // Code workspace: one worktree sub-header per worktree, labeled by branch.
    const wt1 = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-worktree-code-ws-wt-1"]',
    );
    const wt2 = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-worktree-code-ws-wt-2"]',
    );
    expect(wt1).not.toBeNull();
    expect(wt2).not.toBeNull();
    expect(document.body.textContent).toContain('main');
    expect(document.body.textContent).toContain('feature-x');

    // Cowork workspace: no worktree sub-header (renders chats flat).
    expect(
      document.querySelector(
        '[data-testid="usage-limit-resume-worktree-cowork-ws-home"]',
      ),
    ).toBeNull();

    // Toggling a worktree deselects only its chats; counter drops 3 -> 2.
    await act(async () => {
      wt1?.click();
      await flushPromises();
    });
    const a1 = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-a1"]',
    );
    const b1 = document.querySelector<HTMLInputElement>(
      '[data-testid="usage-limit-resume-chat-b1"]',
    );
    expect(a1?.checked).toBe(false);
    expect(b1?.checked).toBe(true);
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-confirm"]',
    );
    expect(confirm?.textContent).toContain('2');
  });

  it('renders and submits chat and pipeline sessions through the generalized API', async () => {
    const sessionGroups: UsageLimitedSessionGroup[] = [
      {
        groupId: 'ws-a',
        groupKind: 'workspace',
        workspaceId: 'ws-a',
        workspaceName: 'Workspace A',
        workspaceType: 'single-repo',
        sessions: [
          { ...groups[0].chats[0], kind: 'chat' },
          {
            kind: 'pipeline',
            executionId: 'execution-1',
            statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
            provider: 'claude',
            pipelineName: 'Release pipeline',
            detectedAt: 3,
            pausedStepCount: 1,
            modelLabels: ['sonnet'],
            otherBlockingReasonCount: 1,
            projectId: 'ws-a',
            worktreeId: 'wt',
            worktreeName: 'feature-branch',
          },
        ],
      },
    ];
    const listSessions = jest.fn().mockResolvedValue(sessionGroups);
    const resumeSessions = jest.fn().mockResolvedValue({
      resumedCount: 2,
      staleCount: 0,
      failedTargets: [],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleSessions: listSessions,
        resumeUsageLimitedSessions: resumeSessions,
      },
    });

    await renderModal();
    expect(document.body.textContent).toContain('Release pipeline');
    expect(document.body.textContent).toContain('1 paused step');
    expect(document.body.textContent).toContain(
      'Also blocked by 1 other issue',
    );

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-limit-resume-confirm"]',
    );
    await act(async () => {
      confirm?.click();
      await flushPromises();
    });

    expect(resumeSessions).toHaveBeenCalledWith({
      targets: [
        {
          kind: 'chat',
          projectId: 'ws-a',
          worktreeId: 'wt',
          chatId: 'c1',
        },
        {
          kind: 'pipeline',
          executionId: 'execution-1',
          statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
        },
      ],
    });
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  it('keys the subtitle off the prompt origin', async () => {
    await renderModal();
    expect(document.body.textContent).toContain(
      'You switched Claude accounts.',
    );

    await act(async () => {
      useUsageLimitResumePromptStore.getState().close();
      useUsageLimitResumePromptStore.getState().open('claude', 'usage-review');
      await flushPromises();
    });

    expect(document.body.textContent).toContain(
      'A Claude usage limit stopped these chats.',
    );
    expect(document.body.textContent).not.toContain(
      'You switched Claude accounts.',
    );
  });

  it('uses neutral usage-review copy for authentication-only sessions', async () => {
    listUsageLimitedIdleChatsMock.mockResolvedValue([
      {
        ...groups[0],
        chats: [
          {
            ...groups[0].chats[0],
            resumeReason: 'authentication',
          },
        ],
      },
    ]);
    useUsageLimitResumePromptStore.getState().open('claude', 'usage-review');

    await renderModal();

    expect(document.body.textContent).toContain(
      'A sign-in problem stopped this chat.',
    );
    expect(document.body.textContent).not.toContain('usage limit');
  });

  it('lists every provider and reason for the Home banner origin', async () => {
    const listSessionsMock = jest.fn().mockResolvedValue([
      {
        groupId: 'ws-a',
        groupKind: 'workspace',
        workspaceId: 'ws-a',
        workspaceName: 'Workspace A',
        workspaceType: 'single-repo',
        sessions: [
          { ...groups[0].chats[0], kind: 'chat', resumeReason: 'usage_limit' },
          {
            ...groups[0].chats[1],
            kind: 'chat',
            provider: 'codex',
            resumeReason: 'app_shutdown',
          },
        ],
      },
    ]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleSessions: listSessionsMock,
        listUsageLimitedIdleChats: listUsageLimitedIdleChatsMock,
      },
    });
    useUsageLimitResumePromptStore.getState().open(null, 'home');

    await renderModal();

    expect(listSessionsMock).toHaveBeenCalledWith({
      includeResumePreview: true,
    });
    expect(listUsageLimitedIdleChatsMock).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="usage-limit-resume-modal"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Review why this work stopped below.',
    );
    expect(document.body.textContent).toContain('Application stopped');
    expect(document.body.textContent).toContain('Resume 2 chats');
  });

  it('renders nothing and never opens for an empty result', async () => {
    listUsageLimitedIdleChatsMock.mockReset().mockResolvedValue([]);

    await renderModal();

    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
    expect(
      document.querySelector('[data-testid="usage-limit-resume-modal"]'),
    ).toBeNull();
  });

  it('cancels an empty authentication recovery prompt once', async () => {
    listUsageLimitedIdleChatsMock.mockResolvedValue([]);
    useUsageLimitResumePromptStore.getState().openAuthentication({
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      activeWorkCount: 1,
      error: 'Verification failed',
    });
    await renderModal();
    expect(cancelCodexLoginMock).toHaveBeenCalledTimes(1);
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  it('keeps a failed automatic cancellation visible through background refresh', async () => {
    listUsageLimitedIdleChatsMock.mockResolvedValue([]);
    cancelCodexLoginMock.mockRejectedValue(new Error('Cancel failed'));
    useUsageLimitResumePromptStore.getState().openAuthentication({
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      activeWorkCount: 1,
      error: 'Verification failed',
    });
    await renderModal();
    expect(cancelCodexLoginMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Couldn't finish cancelling sign-in. Try again.",
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(cancelCodexLoginMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Couldn't finish cancelling sign-in. Try again.",
    );
  });

  it('abandons a failed authentication attempt when the resume modal is dismissed', async () => {
    useUsageLimitResumePromptStore.getState().openAuthentication({
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      activeWorkCount: 1,
      error: "Couldn't verify Codex authentication.",
    });
    await renderModal();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-limit-resume-cancel"]',
        )
        ?.click();
      await flushPromises();
    });

    expect(cancelCodexLoginMock).toHaveBeenCalledTimes(1);
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  it('cancels authentication when recovery loading fails and Cancel is clicked', async () => {
    listUsageLimitedIdleChatsMock
      .mockReset()
      .mockRejectedValue(new Error('load failed'));
    useUsageLimitResumePromptStore.getState().openAuthentication({
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      activeWorkCount: 1,
      error: "Couldn't verify Codex authentication.",
    });
    await renderModal();

    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel',
    );
    await act(async () => {
      cancel?.click();
      await flushPromises();
    });

    expect(cancelCodexLoginMock).toHaveBeenCalledTimes(1);
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  describe('scheduled usage-limit resumes (CAN-4970)', () => {
    let automations: ScheduledActivity[];
    let changed: ((snapshot: AutomationsListResponse) => void) | undefined;
    let listAutomations: jest.Mock<Promise<AutomationsListResponse>, []>;
    const listSessionsMock = jest.fn();

    afterEach(() => jest.restoreAllMocks());

    function scheduledResume(chatId: string): ScheduledActivity {
      const nextRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
      return {
        version: 1,
        id: `resume-${chatId}`,
        name: 'Resume',
        enabled: true,
        schedule: { kind: 'one_time', runAt: nextRunAt, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws-a',
          worktreeId: 'wt',
          chatId,
          prompt: 'continue',
          purpose: 'usage_limit_resume',
        },
        createdAt: nextRunAt,
        updatedAt: nextRunAt,
        nextRunAt,
        failureCount: 0,
      };
    }

    beforeEach(() => {
      automations = [];
      changed = undefined;
      listAutomations = jest.fn(() =>
        Promise.resolve({ activities: automations, recentRuns: [] }),
      );
      listSessionsMock.mockReset().mockResolvedValue([
        {
          groupId: 'ws-a',
          groupKind: 'workspace',
          workspaceId: 'ws-a',
          workspaceName: 'Workspace A',
          workspaceType: 'single-repo',
          sessions: groups[0].chats.map((chat) => ({
            ...chat,
            kind: 'chat',
          })),
        },
      ]);
      useAutomationsStore.setState({
        activities: [],
        recentRuns: [],
        hydrated: false,
        loading: false,
        error: null,
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          listUsageLimitedIdleSessions: listSessionsMock,
          enqueueResumeQueue: enqueueResumeQueueMock,
          automations: {
            list: listAutomations,
            onChanged: (
              listener: (snapshot: AutomationsListResponse) => void,
            ): (() => void) => {
              changed = listener;
              return (): void => undefined;
            },
          },
        },
      });
    });

    async function emit(activities: ScheduledActivity[]): Promise<void> {
      automations = activities;
      await act(async () => {
        changed?.({ activities, recentRuns: [] });
        await flushPromises();
      });
    }

    function chatCheckbox(chatId: string): HTMLInputElement | null {
      return document.querySelector<HTMLInputElement>(
        `[data-testid="usage-limit-resume-chat-${chatId}"]`,
      );
    }

    function confirmButton(): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        '[data-testid="usage-limit-resume-confirm"]',
      );
    }

    it('omits scheduled chats from the Home prompt and its confirm targets', async () => {
      automations = [scheduledResume('c1')];
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();

      expect(chatCheckbox('c1')).toBeNull();
      expect(chatCheckbox('c2')?.checked).toBe(true);
      expect(confirmButton()?.textContent).toContain('Resume chat');

      await act(async () => {
        confirmButton()?.click();
        await flushPromises();
      });
      expect(enqueueResumeQueueMock).toHaveBeenCalledWith({
        targets: [
          { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c2' },
        ],
      });
    });

    it.each(['account-change', 'usage-review', 'app-restart'] as const)(
      'keeps scheduled chats in the %s prompt',
      async (origin) => {
        automations = [scheduledResume('c1')];
        useUsageLimitResumePromptStore.getState().open('claude', origin);
        await renderModal();
        // These origins may load schedules to show "Resume at reset" status,
        // but a schedule never filters their list or selection.
        expect(chatCheckbox('c1')?.checked).toBe(true);
        expect(chatCheckbox('c2')?.checked).toBe(true);
      },
    );

    it('stays loading until automations load, then closes when every chat is scheduled', async () => {
      let resolveList: (snapshot: AutomationsListResponse) => void = () =>
        undefined;
      listAutomations.mockImplementation(
        () =>
          new Promise<AutomationsListResponse>((resolve) => {
            resolveList = resolve;
          }),
      );
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
      expect(document.body.textContent).toContain('Loading interrupted work…');

      await act(async () => {
        resolveList({
          activities: [scheduledResume('c1'), scheduledResume('c2')],
          recentRuns: [],
        });
        await flushPromises();
      });
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
      expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
    });

    it('drops a chat scheduled while open from the list and selection, and restores it unchecked when cancelled', async () => {
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      expect(confirmButton()?.textContent).toContain('Resume 2 chats');

      await emit([scheduledResume('c1')]);
      expect(chatCheckbox('c1')).toBeNull();
      expect(confirmButton()?.textContent).toContain('Resume chat');
      expect(document.body.textContent).toContain('Deselect all');

      await emit([]);
      expect(chatCheckbox('c1')?.checked).toBe(false);
      expect(confirmButton()?.textContent).toContain('Resume chat');
    });

    it('re-checks schedules at confirmation and never sends an empty selection', async () => {
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      await act(async () => {
        chatCheckbox('c2')?.click();
        await flushPromises();
      });
      expect(confirmButton()?.textContent).toContain('Resume chat');

      // The schedule lands after the last render; the click still runs the
      // previously rendered handler.
      await act(async () => {
        useAutomationsStore.setState({
          activities: [scheduledResume('c1')],
        });
        confirmButton()?.click();
        await flushPromises();
      });
      expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
    });

    it('restores an expired schedule on focus even when the listing is unchanged', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      automations = [scheduledResume('c1')];
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      expect(chatCheckbox('c1')).toBeNull();
      jest.spyOn(Date, 'now').mockReturnValue(now + 3_600_000);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flushPromises();
      });
      expect(chatCheckbox('c1')).not.toBeNull();
      expect(chatCheckbox('c1')?.checked).toBe(false);
      jest.restoreAllMocks();
    });

    it('invalidates Home listing and selection on context change and rejects a late response', async () => {
      useProjectsStore.setState({
        projects: [
          {
            id: 'ws-a',
            type: 'single-repo',
            name: 'A',
            repoPath: '/a',
            color: '#000000',
            collapsed: false,
            order: 0,
            worktrees: [],
          },
        ],
      });
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      expect(chatCheckbox('c1')?.checked).toBe(true);
      let resolveOld: (groups: UsageLimitedSessionGroup[]) => void = () =>
        undefined;
      listSessionsMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flushPromises();
      });
      listSessionsMock.mockImplementation(() => new Promise(() => undefined));
      await act(async () => {
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'organization', organizationId: 'org-b' },
            revision: 2,
            organizations: [],
          },
        });
        await flushPromises();
      });
      expect(chatCheckbox('c1')).toBeNull();
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
      await act(async () => {
        resolveOld([]);
        await flushPromises();
      });
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
      expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
    });

    it('intersects confirmation with current visibility before React renders a scope change', async () => {
      useProjectsStore.setState({
        projects: [
          {
            id: 'ws-a',
            type: 'single-repo',
            name: 'A',
            repoPath: '/a',
            color: '#000000',
            collapsed: false,
            order: 0,
            worktrees: [],
          },
        ],
      });
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      const confirm = confirmButton();
      expect(confirm?.textContent).toContain('Resume 2 chats');
      await act(async () => {
        useProjectsStore.setState({ projects: [] });
        confirm?.click();
        await flushPromises();
      });
      expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
    });

    it('blocks the previous context confirmation even when its workspace is visible in both contexts', async () => {
      useProjectsStore.setState({
        projects: [
          {
            id: 'ws-a',
            type: 'single-repo',
            name: 'A',
            repoPath: '/a',
            color: '#000000',
            collapsed: false,
            order: 0,
            worktrees: [],
          },
        ],
      });
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      useLinkedPersonalWorkspacesStore.setState({
        ids: ['ws-a'],
        organizationId: 'org-b',
      });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      const confirm = confirmButton();
      expect(confirm?.textContent).toContain('Resume 2 chats');
      listSessionsMock.mockImplementation(() => new Promise(() => undefined));
      await act(async () => {
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'organization', organizationId: 'org-b' },
            revision: 2,
            organizations: [],
          },
        });
        confirm?.click();
        await flushPromises();
      });
      expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
    });

    it('blocks stale choices after a later automation load fails and recovers on focus', async () => {
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      expect(chatCheckbox('c1')?.checked).toBe(true);

      listAutomations.mockRejectedValueOnce(new Error('offline'));
      await act(async () => useAutomationsStore.getState().hydrate());
      expect(useAutomationsStore.getState().hydrated).toBe(true);
      expect(document.body.textContent).toContain(
        'Couldn’t load interrupted work.',
      );
      expect(confirmButton()).toBeNull();
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);

      automations = [scheduledResume('c1')];
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flushPromises();
      });
      expect(listAutomations).toHaveBeenCalledTimes(3);
      expect(chatCheckbox('c1')).toBeNull();
      expect(chatCheckbox('c2')?.checked).toBe(true);
    });

    it.each([
      { loading: true, error: null },
      { loading: false, error: 'offline' },
    ])(
      'revalidates automation readiness before a stale confirmation (%j)',
      async (state) => {
        useUsageLimitResumePromptStore.getState().open(null, 'home');
        await renderModal();
        const confirm = confirmButton();
        await act(async () => {
          useAutomationsStore.setState(state);
          confirm?.click();
          await flushPromises();
        });
        expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
      },
    );

    it('shows a retryable error when automations fail to load', async () => {
      listAutomations.mockRejectedValueOnce(new Error('offline'));
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await renderModal();
      expect(document.body.textContent).toContain(
        'Couldn’t load interrupted work.',
      );
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);

      const retry = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Try again',
      );
      await act(async () => {
        retry?.click();
        await flushPromises();
      });
      expect(chatCheckbox('c1')?.checked).toBe(true);
      expect(chatCheckbox('c2')?.checked).toBe(true);
    });
  });

  describe('resume effect disclosure (CAN-4896)', () => {
    const query = (testId: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const secondary = (chatId: string): Element | null | undefined =>
      query(`usage-limit-resume-chat-${chatId}-metadata`)?.nextElementSibling;
    const toggle = async (chatId: string): Promise<void> => {
      await act(async () => {
        query(`usage-limit-resume-chat-${chatId}`)?.click();
        await flushPromises();
      });
    };

    beforeEach(() => {
      listUsageLimitedIdleChatsMock.mockResolvedValue([
        {
          ...groups[0],
          chats: [
            {
              ...groups[0].chats[0],
              resumePromptKind: 'continue',
              lastStep: { toolName: 'Edit', detail: 'src/api/client.ts' },
            },
            {
              ...groups[0].chats[1],
              resumePromptKind: 'resend_user_message',
            },
          ],
        },
      ]);
      useProjectsStore.setState({ uncommittedChanges: { 'ws-a/wt': true } });
    });

    it('describes the selection and updates with it', async () => {
      await renderModal();

      expect(document.body.textContent).toContain('Resume interrupted chats');
      expect(document.body.textContent).toContain(
        'You switched Claude accounts.',
      );
      expect(query('usage-limit-resume-effect')?.textContent).toBe(
        'Resuming sends "Continue" or re-sends your last message, as shown for each selected chat. Each agent continues in its chat\'s worktree.',
      );
      expect(secondary('c1')?.textContent).toMatch(
        /^Last step: Edit src\/api\/client\.ts · Stopped .+ · Uncommitted changes · Sends "Continue"$/,
      );
      expect(secondary('c2')?.textContent).toMatch(
        / · Uncommitted changes · Re-sends your last message$/,
      );
      expect(secondary('c1')?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume 2 chats',
      );

      await toggle('c2');
      expect(query('usage-limit-resume-effect')?.textContent).toBe(
        'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree.',
      );
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume chat',
      );

      await toggle('c1');
      expect(query('usage-limit-resume-effect')).toBeNull();
      const confirm = query('usage-limit-resume-confirm');
      expect(confirm?.textContent).toBe('Resume');
      expect(confirm?.hasAttribute('disabled')).toBe(true);
    });

    describe('Home after the app closed', () => {
      // The rows read "today" only when detectedAt and the modal's clock share
      // a local day, so pin the clock to midday instead of the real time. The
      // modal takes its "now" from Date.now(), which is what this pins.
      const PINNED_MIDDAY = new Date(2026, 9, 28, 12, 0).getTime();
      let dateNow: jest.SpyInstance<number, []>;
      beforeEach(() => {
        dateNow = jest.spyOn(Date, 'now').mockReturnValue(PINNED_MIDDAY);
      });
      afterEach(() => dateNow.mockRestore());

      const noResend = /without sending your original requests? again/;
      const workflow: UsageLimitedSessionGroup['sessions'][number] = {
        kind: 'pipeline' as const,
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
        resumeReasons: ['app_shutdown'],
        provider: 'claude' as const,
        pipelineName: 'Release pipeline',
        detectedAt: 3,
        pausedStepCount: 1,
        modelLabels: [],
        otherBlockingReasonCount: 0,
      };
      const openHome = async (
        lastStep: UsageLimitedChatGroup['chats'][number]['lastStep'],
        others: readonly UsageLimitedSessionGroup['sessions'][number][] = [],
      ): Promise<void> => {
        const sessionGroups: UsageLimitedSessionGroup[] = [
          {
            groupId: 'ws-a',
            groupKind: 'workspace',
            workspaceId: 'ws-a',
            workspaceName: 'Workspace A',
            workspaceType: 'single-repo',
            sessions: [
              {
                ...groups[0].chats[0],
                kind: 'chat',
                detectedAt: Date.now() - 60_000,
                resumeReason: 'app_shutdown',
                resumePromptKind: 'continue',
                ...(lastStep ? { lastStep } : {}),
              },
              ...others,
            ],
          },
        ];
        Object.defineProperty(window, 'api', {
          configurable: true,
          value: {
            listUsageLimitedIdleSessions: jest
              .fn()
              .mockResolvedValue(sessionGroups),
            listUsageLimitedIdleChats: listUsageLimitedIdleChatsMock,
          },
        });
        useUsageLimitResumePromptStore.getState().open(null, 'home');
        await renderModal();
      };
      const effect = (): string | null | undefined =>
        query('usage-limit-resume-effect')?.textContent;
      const toggleWorkflow = async (): Promise<void> => {
        await act(async () => {
          query('usage-limit-resume-pipeline-execution-1')?.click();
          await flushPromises();
        });
      };

      it('explains an unfinished step and that the request is not resent', async () => {
        await openHome({
          toolName: 'Edit',
          detail: 'settings.json',
          finished: false,
        });

        expect(document.body.textContent).toContain(
          `${brandText.appName} closed before this chat finished.`,
        );
        expect(effect()).toBe(
          'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree.',
        );
        const row = secondary('c1')?.textContent ?? '';
        expect(row).toMatch(
          /^Stopped during Edit settings\.json \(not finished\) · today .+ · Uncommitted changes$/,
        );
        expect(row.match(/Stopped/g)).toHaveLength(1);
        expect(query('usage-limit-resume-confirm')?.textContent).toBe(
          'Resume chat',
        );
        expect(document.body.textContent).not.toMatch(/usage limit/i);
        expect(document.body.textContent).not.toMatch(/sign-in/i);
      });

      it.each([
        [
          { toolName: 'Edit', detail: 'settings.json', finished: true },
          /^Last step: Edit settings\.json \(finished\) · Stopped today .+ · Uncommitted changes$/,
        ],
        [
          { toolName: 'Edit', detail: 'settings.json' },
          /^Last step: Edit settings\.json · Stopped today .+ · Uncommitted changes$/,
        ],
        [undefined, /^Stopped today .+ · Uncommitted changes$/],
      ])('labels a %j step by its evidence', async (lastStep, line) => {
        await openHome(lastStep);
        expect(secondary('c1')?.textContent).toMatch(line);
        expect(effect()).toMatch(
          /^Resuming sends "Continue" in this chat, so the agent picks up where it stopped/,
        );
      });

      it('withdraws the no-resend promise whenever it stops applying', async () => {
        await openHome({ toolName: 'Bash', finished: true }, [
          {
            ...groups[0].chats[1],
            kind: 'chat',
            resumeReason: 'app_shutdown',
            resumePromptKind: 'resend_user_message',
          },
          {
            ...groups[0].chats[1],
            chatId: 'c3',
            kind: 'chat',
            resumeReason: 'app_shutdown',
          },
          workflow,
        ]);

        // Continue, resend, unknown, and a workflow: mixed and unknown.
        expect(effect()).not.toMatch(noResend);
        await toggle('c3');
        expect(effect()).toMatch(
          /^Resuming sends "Continue" or re-sends your last message/,
        );
        expect(effect()).not.toMatch(noResend);
        await toggle('c2');
        expect(effect()).toBe(
          'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree. Resuming continues the selected workflow.',
        );
        await toggle('c3');
        expect(effect()).toMatch(/^Resuming asks the agent to continue/);
        expect(effect()).not.toMatch(noResend);
        await toggle('c3');
        await toggle('c1');
        expect(effect()).toBe('Resuming continues the selected workflow.');
        await toggleWorkflow();
        expect(effect()).toBeUndefined();
        await toggle('c1');
        expect(effect()).toBe(
          'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree.',
        );
      });
    });

    it('follows the worktree uncommitted state without implying clean', async () => {
      await renderModal();
      expect(secondary('c1')?.textContent).toContain('Uncommitted changes');

      await act(async () => {
        useProjectsStore.setState({ uncommittedChanges: { 'ws-a/wt': false } });
        await flushPromises();
      });
      expect(secondary('c1')?.textContent).not.toContain('Uncommitted');
      expect(secondary('c1')?.textContent).not.toContain('clean');

      await act(async () => {
        useProjectsStore.setState({ uncommittedChanges: {} });
        await flushPromises();
      });
      expect(secondary('c1')?.textContent).not.toContain('Uncommitted');
    });

    it('refreshes preview-only changes while retaining the selection and payload', async () => {
      await renderModal();
      await toggle('c2');
      listUsageLimitedIdleChatsMock.mockResolvedValue([
        {
          ...groups[0],
          chats: [
            { ...groups[0].chats[0], resumePromptKind: 'resend_user_message' },
          ],
        },
      ]);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flushPromises();
      });
      expect(query('usage-limit-resume-effect')?.textContent).toContain(
        'Resuming re-sends your last message in this chat.',
      );
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume chat',
      );
      expect(query('usage-limit-resume-chat-c2')).toBeNull();
      await act(async () => {
        query('usage-limit-resume-confirm')?.click();
        await flushPromises();
      });
      expect(enqueueResumeQueueMock).toHaveBeenCalledWith({
        targets: [
          { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c1' },
        ],
      });
    });

    it('isolates worktree stats by project and follows a changed row identity', async () => {
      await renderModal();
      await act(async () => {
        useProjectsStore.setState({
          uncommittedChanges: {
            'other-project/wt': true,
            'ws-a/other-wt': true,
          },
        });
        await flushPromises();
      });
      expect(secondary('c1')?.textContent).not.toContain('Uncommitted');
      listUsageLimitedIdleChatsMock.mockResolvedValue([
        {
          ...groups[0],
          chats: [{ ...groups[0].chats[0], worktreeId: 'other-wt' }],
        },
      ]);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flushPromises();
      });
      expect(secondary('c1')?.textContent).toContain('Uncommitted changes');
      expect(query('usage-limit-resume-effect')).toBeNull();
      expect(query('usage-limit-resume-confirm')?.textContent).toBe('Resume');
    });

    it('labels each worktree group for its rows', async () => {
      await renderModal();
      const row = query('usage-limit-resume-chat-c1');
      const worktreeGroup = row?.closest('[role="group"]');
      const labelId = worktreeGroup?.getAttribute('aria-labelledby') ?? '';
      expect(document.getElementById(labelId)?.textContent).toBe(
        'feature-branch',
      );
    });

    it('cancels without sending anything', async () => {
      await renderModal();
      await act(async () => {
        query('usage-limit-resume-cancel')?.click();
        await flushPromises();
      });
      expect(enqueueResumeQueueMock).not.toHaveBeenCalled();
      expect(resumeUsageLimitedChatsMock).not.toHaveBeenCalled();
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
    });
  });
});
