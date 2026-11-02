/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import type {
  AutomationsListResponse,
  ScheduledActivity,
  UsageLimitedChatGroup,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import {
  useUsageLimitedSessionCount,
  useUsageLimitedSessions,
  type UsageLimitedSessionsSnapshot,
} from '../useUsageLimitedSessionCount';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function CountProbe({
  onCount,
}: {
  onCount: (count: number) => void;
}): JSX.Element {
  onCount(useUsageLimitedSessionCount('claude', 1));
  return <></>;
}

describe('useUsageLimitedSessionCount', () => {
  it('refreshes after the asynchronous resume queue clears the registry', async () => {
    let registryCount = 1;
    const listUsageLimitedIdleSessions = jest.fn(() =>
      Promise.resolve([
        { sessions: Array.from({ length: registryCount }, () => ({})) },
      ]),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const counts: number[] = [];
    const root = createRoot(document.createElement('div'));

    try {
      await act(async () => {
        root.render(<CountProbe onCount={(count) => counts.push(count)} />);
        await Promise.resolve();
      });
      expect(counts.at(-1)).toBe(1);

      registryCount = 0;
      await act(async () => {
        useResumeQueueStore.getState().apply({
          version: 1,
          revision: 1,
          paused: false,
          entries: [],
        });
        await Promise.resolve();
      });

      expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);
      expect(counts.at(-1)).toBe(0);
    } finally {
      act(() => root.unmount());
      useResumeQueueStore.setState({ snapshot: null, isOpen: false });
      Reflect.deleteProperty(window, 'api');
    }
  });
});

function SessionsProbe({
  provider,
  onSnapshot,
  nowMs = 1,
}: {
  provider: 'claude' | 'codex';
  onSnapshot: (snapshot: UsageLimitedSessionsSnapshot) => void;
  nowMs?: number;
}): JSX.Element {
  onSnapshot(useUsageLimitedSessions(provider, nowMs));
  return <></>;
}

function chatGroup(
  workspaceName: string,
  chatId: string,
): UsageLimitedSessionGroup {
  return {
    groupId: workspaceName,
    groupKind: 'workspace',
    workspaceName,
    sessions: [
      {
        kind: 'chat',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
        provider: 'codex',
        chatTitle: chatId,
        detectedAt: 1,
        worktreeName: 'main',
      },
    ],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('useUsageLimitedSessions', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
    useUsageLimitResumePromptStore.setState({ isOpen: false });
  });

  it('keeps a coherent previous snapshot while refreshing and ignores an older same-provider response', async () => {
    const oldRequest = deferred<UsageLimitedSessionGroup[]>();
    const newRequest = deferred<UsageLimitedSessionGroup[]>();
    const list = jest
      .fn()
      .mockResolvedValueOnce([chatGroup('initial', 'initial')])
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: list },
    });
    const snapshots: UsageLimitedSessionsSnapshot[] = [];
    const root = createRoot(document.createElement('div'));
    const onSnapshot = (snapshot: UsageLimitedSessionsSnapshot): void => {
      snapshots.push(snapshot);
    };
    try {
      await act(async () => {
        await Promise.resolve();
        root.render(
          <SessionsProbe provider="codex" nowMs={1} onSnapshot={onSnapshot} />,
        );
      });
      act(() =>
        root.render(
          <SessionsProbe provider="codex" nowMs={2} onSnapshot={onSnapshot} />,
        ),
      );
      expect(snapshots.at(-1)?.sessions[0]?.session).toMatchObject({
        chatId: 'initial',
      });
      act(() =>
        root.render(
          <SessionsProbe provider="codex" nowMs={3} onSnapshot={onSnapshot} />,
        ),
      );
      await act(async () => {
        await Promise.resolve();
        newRequest.resolve([chatGroup('newest', 'newest')]);
      });
      await act(async () => {
        await Promise.resolve();
        oldRequest.resolve([chatGroup('stale', 'stale')]);
      });
      expect(snapshots.at(-1)?.sessions[0]?.session).toMatchObject({
        chatId: 'newest',
      });
      expect(
        snapshots.every(
          (snapshot) => snapshot.count === snapshot.sessions.length,
        ),
      ).toBe(true);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
    }
  });

  it('pauses reads while the modal is open and refreshes when it closes', async () => {
    const list = jest.fn().mockResolvedValue([chatGroup('workspace', 'chat')]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: list },
    });
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        await Promise.resolve();
        root.render(
          <SessionsProbe provider="codex" onSnapshot={() => undefined} />,
        );
      });
      await act(async () => {
        await Promise.resolve();
        useUsageLimitResumePromptStore.setState({ isOpen: true });
      });
      expect(list).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.resolve();
        useUsageLimitResumePromptStore.setState({ isOpen: false });
      });
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps a superseded provider response from replacing the current snapshot', async () => {
    const claude = deferred<UsageLimitedSessionGroup[]>();
    const codex = deferred<UsageLimitedSessionGroup[]>();
    const listUsageLimitedIdleSessions = jest.fn(
      ({ provider }: { provider: string }) =>
        provider === 'claude' ? claude.promise : codex.promise,
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const snapshots: UsageLimitedSessionsSnapshot[] = [];
    const root = createRoot(document.createElement('div'));

    try {
      act(() => {
        root.render(
          <SessionsProbe
            provider="claude"
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />,
        );
      });
      act(() => {
        root.render(
          <SessionsProbe
            provider="codex"
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />,
        );
      });
      await act(async () => {
        codex.resolve([chatGroup('Codex workspace', 'codex-chat')]);
        await codex.promise;
      });
      await act(async () => {
        claude.resolve([chatGroup('Claude workspace', 'claude-chat')]);
        await claude.promise;
      });

      const latest = snapshots.at(-1);
      expect(latest?.status).toBe('loaded');
      expect(latest?.count).toBe(1);
      expect(latest?.sessions.map((entry) => entry.workspaceName)).toEqual([
        'Codex workspace',
      ]);
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not show the previous provider snapshot while the next one loads', async () => {
    const codex = deferred<UsageLimitedSessionGroup[]>();
    const listUsageLimitedIdleSessions = jest.fn(
      ({ provider }: { provider: string }) =>
        provider === 'claude'
          ? Promise.resolve([chatGroup('Claude workspace', 'claude-chat')])
          : codex.promise,
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const snapshots: UsageLimitedSessionsSnapshot[] = [];
    const root = createRoot(document.createElement('div'));

    try {
      await act(async () => {
        root.render(
          <SessionsProbe
            provider="claude"
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />,
        );
        await Promise.resolve();
      });
      expect(snapshots.at(-1)?.count).toBe(1);

      act(() => {
        root.render(
          <SessionsProbe
            provider="codex"
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />,
        );
      });
      expect(snapshots.at(-1)).toEqual({
        status: 'idle',
        sessions: [],
        count: 0,
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('maps legacy chat results to chat sessions with their identity', async () => {
    const legacy: UsageLimitedChatGroup[] = [
      {
        workspaceId: 'project',
        workspaceName: 'Legacy workspace',
        workspaceType: 'single-repo',
        chats: [
          {
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'legacy-chat',
            provider: 'codex',
            chatTitle: 'Legacy chat',
            detectedAt: 1,
            worktreeName: 'main',
          },
        ],
      },
    ];
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleChats: jest.fn(() => Promise.resolve(legacy)),
      },
    });
    const snapshots: UsageLimitedSessionsSnapshot[] = [];
    const root = createRoot(document.createElement('div'));

    try {
      await act(async () => {
        root.render(
          <SessionsProbe
            provider="codex"
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />,
        );
        await Promise.resolve();
      });
      const latest = snapshots.at(-1);
      expect(latest?.count).toBe(latest?.sessions.length);
      expect(latest?.sessions).toHaveLength(1);
      const entry = latest?.sessions[0];
      expect(entry?.workspaceName).toBe('Legacy workspace');
      expect(entry?.session).toMatchObject({
        kind: 'chat',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'legacy-chat',
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('reports a failed fetch as an error, not a confirmed empty registry', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleSessions: jest.fn(() =>
          Promise.reject(new Error('offline')),
        ),
      },
    });
    const snapshots: UsageLimitedSessionsSnapshot[] = [];
    const root = createRoot(document.createElement('div'));

    try {
      await act(async () => {
        root.render(
          <SessionsProbe
            provider="codex"
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(snapshots.at(-1)).toEqual({
        status: 'error',
        sessions: [],
        count: 0,
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('useUsageLimitedSessions with scheduled resumes (CAN-5014)', () => {
  const NOW = Date.parse('2026-10-25T12:00:00.000Z');
  const LATER = '2026-10-25T13:00:00.000Z';
  let root: ReturnType<typeof createRoot>;
  const snapshots: UsageLimitedSessionsSnapshot[] = [];

  function workspaceGroup(
    workspaceId: string,
    provider: 'claude' | 'codex' = 'codex',
  ): UsageLimitedSessionGroup {
    return {
      groupId: workspaceId,
      groupKind: 'workspace',
      workspaceId,
      workspaceName: workspaceId,
      sessions: [
        {
          kind: 'chat',
          projectId: workspaceId,
          worktreeId: 'wt',
          chatId: `${workspaceId}-chat`,
          provider,
          chatTitle: workspaceId,
          detectedAt: 1,
          worktreeName: 'wt',
        },
      ],
    };
  }

  function resumeFor(
    workspaceId: string,
    nextRunAt = LATER,
    overrides: Partial<ScheduledActivity> = {},
  ): ScheduledActivity {
    return {
      version: 1,
      id: `resume-${workspaceId}`,
      name: 'Resume',
      enabled: true,
      schedule: { kind: 'one_time', runAt: nextRunAt, timezone: 'local' },
      action: {
        type: 'worktree_session_prompt',
        workspaceId,
        worktreeId: 'wt',
        chatId: `${workspaceId}-chat`,
        prompt: 'continue',
        purpose: 'usage_limit_resume',
      },
      createdAt: '2026-10-25T11:00:00.000Z',
      updatedAt: '2026-10-25T11:00:00.000Z',
      nextRunAt,
      failureCount: 0,
      ...overrides,
    };
  }

  function installApi(options: {
    groups?: (provider?: string) => UsageLimitedSessionGroup[];
    legacy?: UsageLimitedChatGroup[];
    list: () => Promise<AutomationsListResponse>;
  }): { registry: jest.Mock; list: jest.Mock } {
    const registry = jest.fn(({ provider }: { provider?: string }) =>
      Promise.resolve(
        options.legacy ??
          options.groups?.(provider) ?? [
            workspaceGroup('ws-a'),
            workspaceGroup('ws-b'),
          ],
      ),
    );
    const list = jest.fn(options.list);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(options.legacy
          ? { listUsageLimitedIdleChats: registry }
          : { listUsageLimitedIdleSessions: registry }),
        automations: {
          list,
          onChanged: () => (): void => undefined,
        },
      },
    });
    return { registry, list };
  }

  function scheduled(
    ...activities: ScheduledActivity[]
  ): () => Promise<AutomationsListResponse> {
    return () => Promise.resolve({ activities, recentRuns: [] });
  }

  async function render(nowMs = NOW): Promise<void> {
    await act(async () => {
      root.render(
        <SessionsProbe
          provider="codex"
          nowMs={nowMs}
          onSnapshot={(snapshot) => snapshots.push(snapshot)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function chatIds(): string[] {
    return (snapshots.at(-1)?.sessions ?? []).flatMap((entry) =>
      entry.session.kind === 'chat' ? [entry.session.chatId] : [],
    );
  }

  function expectCoherent(): void {
    for (const snapshot of snapshots) {
      expect(snapshot.count).toBe(snapshot.sessions.length);
    }
  }

  beforeEach(() => {
    snapshots.length = 0;
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useWorkspaceContextStore.setState({ hydrated: false });
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      hydrated: false,
      loading: false,
      error: null,
    });
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    useResumeQueueStore.setState({ snapshot: null, isOpen: false });
    useUsageLimitResumePromptStore.setState({ isOpen: false });
    Reflect.deleteProperty(window, 'api');
  });

  it('excludes a chat whose usage-limit resume is pending', async () => {
    installApi({ list: scheduled(resumeFor('ws-a')) });
    await render();
    expect(snapshots.at(-1)).toMatchObject({ status: 'loaded', count: 1 });
    expect(chatIds()).toEqual(['ws-b-chat']);
    expectCoherent();
  });

  it('reports a loaded empty result when every chat is scheduled', async () => {
    installApi({ list: scheduled(resumeFor('ws-a'), resumeFor('ws-b')) });
    await render();
    expect(snapshots.at(-1)).toEqual({
      status: 'loaded',
      sessions: [],
      count: 0,
    });
    expectCoherent();
  });

  it('withholds a loaded registry until the cold automations request completes', async () => {
    const pending = deferred<AutomationsListResponse>();
    const { registry, list } = installApi({ list: () => pending.promise });
    await render();
    expect(registry).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toEqual({
      status: 'idle',
      sessions: [],
      count: 0,
    });
    expect(snapshots.some((snapshot) => snapshot.status === 'loaded')).toBe(
      false,
    );

    await act(async () => {
      pending.resolve({ activities: [resumeFor('ws-a')], recentRuns: [] });
      await pending.promise;
    });
    expect(chatIds()).toEqual(['ws-b-chat']);
    expect(snapshots.at(-1)?.status).toBe('loaded');
    expectCoherent();
  });

  it('withholds stale eligibility during a background reload and recovers without listing again', async () => {
    const { registry, list } = installApi({
      list: scheduled(resumeFor('ws-a')),
    });
    await render();
    expect(chatIds()).toEqual(['ws-b-chat']);

    const pending = deferred<AutomationsListResponse>();
    list.mockReturnValueOnce(pending.promise);
    act(() => void useAutomationsStore.getState().hydrate());
    // The dialog may remain settled, but Usage must also wait for !loading.
    expect(useAutomationsStore.getState().hydrated).toBe(true);
    expect(snapshots.at(-1)).toEqual({
      status: 'idle',
      sessions: [],
      count: 0,
    });

    await act(async () => {
      pending.resolve({ activities: [resumeFor('ws-b')], recentRuns: [] });
      await pending.promise;
    });
    expect(chatIds()).toEqual(['ws-a-chat']);
    expect(registry).toHaveBeenCalledTimes(1);
    expectCoherent();
  });

  it('follows schedule changes without reading the registry again', async () => {
    const { registry } = installApi({ list: scheduled() });
    await render();
    expect(chatIds()).toEqual(['ws-a-chat', 'ws-b-chat']);

    act(() =>
      useAutomationsStore.setState({ activities: [resumeFor('ws-a')] }),
    );
    expect(chatIds()).toEqual(['ws-b-chat']);

    act(() =>
      useAutomationsStore.setState({
        activities: [resumeFor('ws-a', LATER, { enabled: false })],
      }),
    );
    expect(chatIds()).toEqual(['ws-a-chat', 'ws-b-chat']);

    act(() =>
      useAutomationsStore.setState({ activities: [resumeFor('ws-b')] }),
    );
    expect(chatIds()).toEqual(['ws-a-chat']);

    act(() => useAutomationsStore.setState({ activities: [] }));
    expect(chatIds()).toEqual(['ws-a-chat', 'ws-b-chat']);
    expect(registry).toHaveBeenCalledTimes(1);
    expectCoherent();
  });

  it('restores a chat once its schedule is no longer in the future', async () => {
    const runAt = Date.parse(LATER);
    const { registry } = installApi({ list: scheduled(resumeFor('ws-a')) });
    await render(runAt - 1);
    expect(chatIds()).toEqual(['ws-b-chat']);
    // The ordinary registry poll may still be pending: expiry must be
    // evaluated immediately from the cached groups and supplied clock.
    const refresh = deferred<UsageLimitedSessionGroup[]>();
    registry.mockReturnValue(refresh.promise);
    await render(runAt);
    expect(chatIds()).toEqual(['ws-a-chat', 'ws-b-chat']);
    await render(runAt + 1);
    expect(chatIds()).toEqual(['ws-a-chat', 'ws-b-chat']);
    await act(async () => {
      refresh.resolve([workspaceGroup('ws-a'), workspaceGroup('ws-b')]);
      await refresh.promise;
    });
    expectCoherent();
  });

  it('keeps a chat scheduled for another worktree or chat', async () => {
    const other = resumeFor('ws-a');
    const otherAction = other.action;
    if (otherAction.type !== 'worktree_session_prompt')
      throw new Error('resumeFor makes a worktree session prompt');
    installApi({
      list: scheduled(
        {
          ...other,
          id: 'other-worktree',
          action: { ...otherAction, worktreeId: 'other' },
        },
        {
          ...other,
          id: 'other-chat',
          action: { ...otherAction, chatId: 'other-chat' },
        },
      ),
    });
    await render();
    expect(chatIds()).toEqual(['ws-a-chat', 'ws-b-chat']);
  });

  it('withholds eligibility until automations load and retries a failure on the clock', async () => {
    let fail = true;
    const { list } = installApi({
      list: () =>
        fail
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              activities: [resumeFor('ws-a')],
              recentRuns: [],
            }),
    });
    await render();
    expect(snapshots.at(-1)).toEqual({
      status: 'idle',
      sessions: [],
      count: 0,
    });
    expect(snapshots.some((snapshot) => snapshot.count > 0)).toBe(false);
    // A failed load does not retry itself in a loop.
    await act(async () => {
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(1);

    fail = false;
    await render(NOW + 30_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({ status: 'loaded', count: 1 });
    expect(chatIds()).toEqual(['ws-b-chat']);
  });

  it('shares one automations load while preserving provider isolation and pipelines', async () => {
    const codex = workspaceGroup('ws-a');
    codex.sessions.push({
      kind: 'pipeline',
      provider: 'codex',
      executionId: 'exec-1',
      statusReasonIds: ['r1'],
      pipelineName: 'Release',
      detectedAt: 3,
      pausedStepCount: 1,
      modelLabels: [],
      otherBlockingReasonCount: 0,
    });
    const claude = workspaceGroup('ws-b', 'claude');
    const { list, registry } = installApi({
      groups: (provider) => (provider === 'codex' ? [codex] : [claude]),
      list: scheduled(resumeFor('ws-a')),
    });
    const results = new Map<string, UsageLimitedSessionsSnapshot>();
    await act(async () => {
      root.render(
        <>
          <SessionsProbe
            provider="codex"
            nowMs={NOW}
            onSnapshot={(snapshot) => results.set('codex', snapshot)}
          />
          <SessionsProbe
            provider="claude"
            nowMs={NOW}
            onSnapshot={(snapshot) => results.set('claude', snapshot)}
          />
        </>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(registry).toHaveBeenCalledWith({ provider: 'codex' });
    expect(registry).toHaveBeenCalledWith({ provider: 'claude' });
    expect(
      results.get('codex')?.sessions.map((entry) => entry.session),
    ).toEqual([codex.sessions[1]]);
    expect(
      results.get('claude')?.sessions.map((entry) => entry.session),
    ).toEqual(claude.sessions);
    expect(results.size).toBe(2);
    results.forEach((snapshot) => {
      expect(snapshot.status).toBe('loaded');
      expect(snapshot.count).toBe(snapshot.sessions.length);
    });
  });

  it('bounds and deduplicates failed-load retries across provider cards on each clock tick', async () => {
    let offline = true;
    const { list } = installApi({
      groups: (provider) => [
        workspaceGroup(
          provider === 'codex' ? 'ws-a' : 'ws-b',
          provider === 'codex' ? 'codex' : 'claude',
        ),
      ],
      list: () =>
        offline
          ? Promise.reject(new Error('offline'))
          : scheduled(resumeFor('ws-a'))(),
    });
    const results = new Map<string, UsageLimitedSessionsSnapshot>();
    async function renderCards(nowMs: number): Promise<void> {
      await act(async () => {
        root.render(
          <>
            {(['codex', 'claude'] as const).map((provider) => (
              <SessionsProbe
                key={provider}
                provider={provider}
                nowMs={nowMs}
                onSnapshot={(snapshot) => results.set(provider, snapshot)}
              />
            ))}
          </>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    await renderCards(NOW);
    expect(list).toHaveBeenCalledTimes(1);
    await renderCards(NOW);
    expect(list).toHaveBeenCalledTimes(1);
    await renderCards(NOW + 30_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(results.size).toBe(2);
    results.forEach((snapshot) => {
      expect(snapshot).toEqual({ status: 'idle', sessions: [], count: 0 });
    });

    offline = false;
    await renderCards(NOW + 60_000);
    expect(list).toHaveBeenCalledTimes(3);
    results.forEach((snapshot, provider) => {
      expect(snapshot.status).toBe('loaded');
      expect(snapshot.count).toBe(provider === 'codex' ? 0 : 1);
      expect(snapshot.count).toBe(snapshot.sessions.length);
    });
  });

  it('invalidates the previous context through the bridge and recovers when the next context loads', async () => {
    const { list, registry } = installApi({
      list: scheduled(resumeFor('ws-a')),
    });
    await render();
    expect(chatIds()).toEqual(['ws-b-chat']);
    const pending = deferred<AutomationsListResponse>();
    list.mockReturnValueOnce(pending.promise);
    act(() =>
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
        state: {
          ...state.state,
          context: { kind: 'organization', organizationId: 'org-b' },
          revision: state.state.revision + 1,
        },
      })),
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.status).toBe('idle');
    expect(chatIds()).toEqual([]);
    await act(async () => {
      pending.resolve({ activities: [resumeFor('ws-b')], recentRuns: [] });
      await pending.promise;
    });
    expect(chatIds()).toEqual(['ws-a-chat']);
    expect(registry).toHaveBeenCalledTimes(1);
    expectCoherent();
  });

  it('does not restore a resumed chat the registry no longer lists', async () => {
    let groups = [workspaceGroup('ws-a'), workspaceGroup('ws-b')];
    installApi({ groups: () => groups, list: scheduled(resumeFor('ws-a')) });
    await render();
    expect(chatIds()).toEqual(['ws-b-chat']);
    groups = [workspaceGroup('ws-b')];
    await render(NOW + 30_000);
    act(() => useAutomationsStore.setState({ activities: [] }));
    expect(chatIds()).toEqual(['ws-b-chat']);
  });

  it('applies the same exclusion to legacy chat-only listings', async () => {
    const chat = (workspaceId: string): UsageLimitedChatGroup => ({
      workspaceId,
      workspaceName: workspaceId,
      workspaceType: 'single-repo',
      chats: [
        {
          projectId: workspaceId,
          worktreeId: 'wt',
          chatId: `${workspaceId}-chat`,
          provider: 'codex',
          chatTitle: workspaceId,
          detectedAt: 1,
          worktreeName: 'wt',
        },
      ],
    });
    installApi({
      legacy: [chat('ws-a'), chat('ws-b')],
      list: scheduled(resumeFor('ws-a')),
    });
    await render();
    expect(chatIds()).toEqual(['ws-b-chat']);
    expect(snapshots.at(-1)?.sessions[0]?.workspaceId).toBe('ws-b');
    expectCoherent();
  });
});
