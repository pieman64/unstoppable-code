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
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { recordCodeReviewOrigin } from '@/stores/chat/code-review-registry';
import { UsageLimitResumeModal } from '../UsageLimitResumeModal';
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

    expect(document.body.textContent).toContain('Resume interrupted sessions');
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
        values: { [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true },
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
    ).toBe('Resume 1 session');
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
    expect(document.body.textContent).not.toContain(
      'Loading interrupted sessions',
    );
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
      'Couldn’t load interrupted sessions.',
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(checkbox?.checked).toBe(false);
    expect(document.body.textContent).not.toContain(
      'Couldn’t load interrupted sessions.',
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
      'Couldn’t load interrupted sessions.',
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
      'Some sessions could not be resumed. Try again.',
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
      'Some sessions could not be resumed. Try again.',
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
    expect(document.body.textContent).toContain(
      'Some sessions could not be resumed. Try again.',
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
      'Resume sessions interrupted by a Claude usage limit or authentication issue.',
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
      'Resume sessions interrupted by a Claude usage limit or authentication issue.',
    );
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

    expect(listSessionsMock).toHaveBeenCalledWith({});
    expect(listUsageLimitedIdleChatsMock).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="usage-limit-resume-modal"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Resume chats and pipelines interrupted by an application stop, a usage limit, or an authentication issue.',
    );
    expect(document.body.textContent).toContain('Application stopped');
    expect(document.body.textContent).toContain('Resume 2 sessions');
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
});
