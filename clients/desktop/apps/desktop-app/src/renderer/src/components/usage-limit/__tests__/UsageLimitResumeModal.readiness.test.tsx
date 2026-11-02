/**
 * @jest-environment jsdom
 *
 * Readiness gating for the resume dialog (CAN-4967): sessions blocked by a
 * provider usage window are never selected or counted for an immediate
 * resume, and can be scheduled to resume at the reset instead.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentUsageOverview,
  AutomationCreateRequest,
  AutomationMutationResponse,
  ScheduledActivity,
  PersistedChatMessage,
  UsageLimitedSessionGroup,
  UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { UsageLimitResumeModal } from '../UsageLimitResumeModal';
import { resolveInterruptedSessionProviders } from '@/lib/interruptedSessions';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

let mockMessages: PersistedChatMessage[] = [];

jest.mock('@/stores/chatStore', () => ({
  clearResumedChatUsageLimitBanner: jest.fn(),
  useChatStore: {
    getState: (): {
      worktreeChats: Record<
        string,
        { tabs: { id: string; messages: PersistedChatMessage[] }[] }
      >;
    } => ({
      worktreeChats: {
        'ws-a/wt': { tabs: [{ id: 'codex-1', messages: mockMessages }] },
      },
    }),
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-10-25T12:00:00.000Z');
const RESET_MS = NOW_MS + 2 * DAY_MS;
const RESET_ISO = new Date(RESET_MS).toISOString();

function chat(
  chatId: string,
  provider: UsageLimitedSessionItem['provider'],
): UsageLimitedSessionItem {
  return {
    kind: 'chat',
    projectId: 'ws-a',
    worktreeId: 'wt',
    chatId,
    provider: provider ?? 'claude',
    chatTitle: `Chat ${chatId}`,
    detectedAt: 1,
    resumeReason: 'usage_limit',
    worktreeName: 'main',
  };
}

const mixedGroups: UsageLimitedSessionGroup[] = [
  {
    groupId: 'ws-a',
    groupKind: 'workspace',
    workspaceId: 'ws-a',
    workspaceName: 'Workspace A',
    workspaceType: 'cowork',
    sessions: [
      chat('codex-1', 'codex'),
      chat('c1', 'claude'),
      chat('c2', 'claude'),
    ],
  },
];

function usage(
  blocked: { provider: 'claude' | 'codex'; resetsAt?: string }[],
): AgentUsageOverview {
  return {
    updatedAt: new Date().toISOString(),
    providers: blocked.map(({ provider, resetsAt }) => ({
      provider,
      authState: 'authenticated',
      hasRemainingLimits: false,
      rateLimits: [
        {
          limitId: provider === 'codex' ? 'codex' : 'seven_day',
          secondary: {
            usedPercent: 100,
            windowDurationMins: 7 * 24 * 60,
            ...(resetsAt ? { resetsAt } : {}),
          },
        },
      ],
    })),
  };
}

const CODEX_BLOCKED = usage([{ provider: 'codex', resetsAt: RESET_ISO }]);
const CLEAR: AgentUsageOverview = { updatedAt: '', providers: [] };

interface Deferred {
  resolve: (value: AgentUsageOverview) => void;
  reject: (error: unknown) => void;
}

const listSessionsMock = jest.fn();
const enqueueMock = jest.fn();
const createActivityMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [AutomationCreateRequest]
>();
const deleteActivityMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [string]
>();
const refreshMock = jest.fn();
let pendingRefreshes: Deferred[] = [];

/** Refreshes stay pending until a test settles them. */
function deferRefreshes(nextUsage: AgentUsageOverview): void {
  refreshMock.mockImplementation(
    () =>
      new Promise<AgentUsageOverview>((resolve, reject) => {
        pendingRefreshes.push({
          resolve: (value) => {
            useObservabilityStore.setState({ usage: value });
            resolve(value);
          },
          reject,
        });
      }),
  );
  useObservabilityStore.setState({ usage: nextUsage });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function query<T extends Element = HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

describe('UsageLimitResumeModal readiness', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    jest.useFakeTimers({ now: NOW_MS });
    pendingRefreshes = [];
    mockMessages = [];
    listSessionsMock.mockReset().mockResolvedValue(mixedGroups);
    enqueueMock.mockReset().mockResolvedValue({
      version: 1,
      revision: 1,
      paused: false,
      entries: [],
    });
    createActivityMock.mockReset().mockResolvedValue({ ok: true });
    deleteActivityMock.mockReset().mockResolvedValue({ ok: true });
    refreshMock.mockReset();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleSessions: listSessionsMock,
        listUsageLimitedIdleChats: jest.fn(),
        enqueueResumeQueue: enqueueMock,
      },
    });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useWorkspaceContextStore.setState({ hydrated: false });
    useProjectsStore.setState({ projects: [] });
    useResumeQueueStore.setState({
      snapshot: null,
      isOpen: false,
      connectionError: null,
    });
    useObservabilityStore.setState({
      usage: CLEAR,
      refreshProviderUsageSnapshot: refreshMock,
    });
    // The home origin waits for a loaded automations snapshot (CAN-4970).
    useAutomationsStore.setState({
      activities: [],
      hydrated: true,
      loading: false,
      error: null,
      hydrate: jest.fn().mockResolvedValue(undefined),
      subscribeBridge: () => (): void => undefined,
      createActivity: createActivityMock,
      deleteActivity: deleteActivityMock,
    });
    jest.mocked(useCurrentUiStateReporter).mockClear();
    useUsageLimitResumePromptStore.setState({
      authentication: null,
      isOpen: false,
      provider: null,
      origin: 'account-change',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  async function open(
    origin:
      | 'home'
      | 'usage-review'
      | 'app-restart'
      | 'account-change'
      | 'authentication',
  ): Promise<void> {
    await act(async () => {
      useUsageLimitResumePromptStore
        .getState()
        .open(
          origin === 'home' || origin === 'app-restart' ? null : 'codex',
          origin,
        );
      root.render(createElement(UsageLimitResumeModal));
      await flush();
    });
  }

  async function settleRefreshes(
    settle: (deferred: Deferred) => void,
  ): Promise<void> {
    await act(async () => {
      const current = pendingRefreshes;
      pendingRefreshes = [];
      current.forEach(settle);
      await flush();
    });
  }

  function checkbox(id: string): HTMLInputElement | null {
    return query<HTMLInputElement>(`usage-limit-resume-chat-${id}`);
  }

  function lastReport(): Record<string, unknown> {
    const calls = jest
      .mocked(useCurrentUiStateReporter)
      .mock.calls.filter(([key]) => key === 'usageLimit.resumeModal');
    const last = calls[calls.length - 1];
    return (last?.[1] ?? {}) as Record<string, unknown>;
  }

  it.each(['home', 'usage-review', 'app-restart'] as const)(
    'selects only eligible sessions for the %s origin',
    async (origin) => {
      deferRefreshes(CODEX_BLOCKED);
      await open(origin);

      // Selection waits for the initial usage refresh.
      expect(query('usage-limit-resume-confirm')).toBeNull();
      expect(document.body.textContent).toContain('Loading interrupted work…');
      expect(lastReport()).toMatchObject({
        loading: true,
        readinessPending: true,
      });
      expect(
        refreshMock.mock.calls.map((call: unknown[]) => String(call[0])).sort(),
      ).toEqual(['claude', 'codex']);

      await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));

      const codex = checkbox('codex-1');
      expect(codex?.checked).toBe(false);
      expect(codex?.disabled).toBe(true);
      expect(checkbox('c1')?.checked).toBe(true);
      expect(checkbox('c2')?.checked).toBe(true);
      const describedBy = codex?.getAttribute('aria-describedby') ?? '';
      expect(document.getElementById(describedBy)?.textContent).toMatch(
        /^Codex · Weekly limit · Resets .+/,
      );
      expect(
        document.getElementById(
          checkbox('c1')?.getAttribute('aria-describedby') ?? '',
        )?.textContent,
      ).toBe('Claude · Usage limit · Ready now');
      const label = document.querySelector(`label[for="${codex?.id ?? ''}"]`);
      expect(label?.textContent).toBe('Chat codex-1');
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume 2 chats',
      );
      expect(query('usage-limit-resume-effect')?.textContent).toContain(
        'Resuming asks the agent to continue in each selected chat.',
      );
      expect(query('usage-limit-resume-readiness-summary')?.textContent).toBe(
        '2 ready now · 1 waiting for Codex reset',
      );
      // Ready rows come first within the group.
      const order = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[data-testid^="usage-limit-resume-chat-"]',
        ),
      ).map((input) => input.dataset.testid);
      expect(order).toEqual([
        'usage-limit-resume-chat-c1',
        'usage-limit-resume-chat-c2',
        'usage-limit-resume-chat-codex-1',
      ]);
      expect(lastReport()).toMatchObject({
        loading: false,
        readinessPending: false,
        readyCount: 2,
        waitingCount: 1,
        selectedCount: 2,
      });
    },
  );

  it.each(['home', 'usage-review', 'app-restart'] as const)(
    'keeps blocked sessions out of select all and group toggles for %s',
    async (origin) => {
      deferRefreshes(CODEX_BLOCKED);
      await open(origin);
      await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));

      await act(async () => {
        query<HTMLButtonElement>('usage-limit-resume-select-all')?.click();
        await flush();
      });
      expect(query('usage-limit-resume-confirm')?.textContent).toBe('Resume');
      await act(async () => {
        query<HTMLButtonElement>('usage-limit-resume-select-all')?.click();
        await flush();
      });
      expect(checkbox('codex-1')?.checked).toBe(false);
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume 2 chats',
      );
      await act(async () => {
        checkbox('codex-1')?.click();
        await flush();
      });
      expect(checkbox('codex-1')?.checked).toBe(false);
      const workspace = query<HTMLInputElement>(
        'usage-limit-resume-workspace-ws-a',
      );
      expect(workspace?.checked).toBe(true);
      await act(async () => {
        workspace?.click();
        await flush();
      });
      expect(checkbox('c1')?.checked).toBe(false);
      expect(checkbox('codex-1')?.checked).toBe(false);
      await act(async () => {
        checkbox('c1')?.click();
        await flush();
      });
      expect(workspace?.checked).toBe(false);
      expect(workspace?.indeterminate).toBe(true);
      await act(async () => {
        workspace?.click();
        await flush();
      });
      expect(checkbox('c2')?.checked).toBe(true);
      expect(checkbox('codex-1')?.checked).toBe(false);
    },
  );

  it('disables a group whose sessions are all waiting and keeps the summary', async () => {
    listSessionsMock.mockResolvedValue([
      { ...mixedGroups[0], sessions: [chat('codex-1', 'codex')] },
      { ...mixedGroups[0], groupId: 'empty', sessions: [] },
    ]);
    deferRefreshes(CODEX_BLOCKED);
    await open('usage-review');
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));

    const workspace = query<HTMLInputElement>(
      'usage-limit-resume-workspace-ws-a',
    );
    expect(
      query<HTMLInputElement>('usage-limit-resume-workspace-empty')?.disabled,
    ).toBe(true);
    expect(
      query<HTMLInputElement>('usage-limit-resume-workspace-empty')?.checked,
    ).toBe(false);
    expect(workspace?.disabled).toBe(true);
    expect(workspace?.checked).toBe(false);
    expect(
      query<HTMLButtonElement>('usage-limit-resume-confirm')?.disabled,
    ).toBe(true);
    expect(query('usage-limit-resume-readiness-summary')?.textContent).toBe(
      '0 ready now · 1 waiting for Codex reset',
    );
  });

  it('submits only sessions still eligible under the latest snapshot', async () => {
    deferRefreshes(CODEX_BLOCKED);
    await open('home');
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));

    // A usage update lands right before confirmation: Claude is now blocked.
    useObservabilityStore.setState({
      usage: usage([
        { provider: 'codex', resetsAt: RESET_ISO },
        { provider: 'claude', resetsAt: RESET_ISO },
      ]),
    });
    await act(async () => {
      query<HTMLButtonElement>('usage-limit-resume-confirm')?.click();
      await flush();
    });
    expect(enqueueMock).not.toHaveBeenCalled();

    deferRefreshes(CODEX_BLOCKED);
    await act(async () => {
      useUsageLimitResumePromptStore.getState().close();
      await flush();
    });
    await open('home');
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
    await act(async () => {
      query<HTMLButtonElement>('usage-limit-resume-confirm')?.click();
      await flush();
    });
    expect(enqueueMock).toHaveBeenCalledWith({
      targets: [
        { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c1' },
        { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c2' },
      ],
    });
  });

  it('drops a newly blocked selection and leaves newly eligible sessions unchecked', async () => {
    deferRefreshes(CODEX_BLOCKED);
    await open('home');
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));

    await act(async () => {
      useObservabilityStore.setState({
        usage: usage([{ provider: 'claude', resetsAt: RESET_ISO }]),
      });
      await flush();
    });
    expect(checkbox('c1')?.checked).toBe(false);
    expect(checkbox('c1')?.disabled).toBe(true);
    expect(checkbox('codex-1')?.disabled).toBe(false);
    expect(checkbox('codex-1')?.checked).toBe(false);

    await act(async () => {
      useObservabilityStore.setState({ usage: CLEAR });
      await flush();
    });
    // Claude was removed from the selection when it became blocked.
    expect(checkbox('c1')?.checked).toBe(false);
    expect(query('usage-limit-resume-confirm')?.textContent).toBe('Resume');
    expect(query('usage-limit-resume-effect')).toBeNull();
  });

  it('refreshes each provider once per opening, including later discoveries', async () => {
    listSessionsMock.mockResolvedValueOnce([
      { ...mixedGroups[0], sessions: [chat('c1', 'claude')] },
    ]);
    deferRefreshes(CLEAR);
    await open('home');
    expect(refreshMock.mock.calls).toEqual([['claude']]);
    await settleRefreshes((deferred) => deferred.resolve(CLEAR));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flush();
    });
    expect(refreshMock.mock.calls).toEqual([['claude'], ['codex']]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flush();
    });
    expect(refreshMock).toHaveBeenCalledTimes(2);
    // A session discovered later stays unchecked.
    expect(checkbox('codex-1')?.checked).toBe(false);
    expect(checkbox('c1')?.checked).toBe(true);
  });

  it('waits for the first successful listing before refreshing and selecting', async () => {
    listSessionsMock.mockRejectedValueOnce(new Error('offline'));
    deferRefreshes(CODEX_BLOCKED);
    await open('home');
    expect(refreshMock).not.toHaveBeenCalled();
    const retry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await flush();
    });
    expect(query('usage-limit-resume-confirm')).toBeNull();
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
    expect(checkbox('c1')?.checked).toBe(true);
    expect(checkbox('codex-1')?.disabled).toBe(true);
  });

  it('uses usage changes made while initialization is pending', async () => {
    deferRefreshes(CLEAR);
    await open('home');
    await act(async () => {
      useObservabilityStore.setState({ usage: CODEX_BLOCKED });
      await flush();
    });
    await settleRefreshes((deferred) => deferred.reject(new Error('offline')));
    expect(checkbox('codex-1')?.disabled).toBe(true);
    expect(checkbox('c1')?.checked).toBe(true);
  });

  it('keeps sessions discovered during initialization unchecked', async () => {
    listSessionsMock.mockResolvedValueOnce([
      { ...mixedGroups[0], sessions: [chat('c1', 'claude')] },
    ]);
    deferRefreshes(CLEAR);
    await open('home');
    const initial = pendingRefreshes;
    pendingRefreshes = [];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flush();
    });
    await act(async () => {
      initial.forEach((deferred) => deferred.resolve(CLEAR));
      await flush();
    });
    expect(checkbox('c1')?.checked).toBe(true);
    expect(checkbox('c2')?.checked).toBe(false);
    expect(checkbox('codex-1')?.checked).toBe(false);
    await settleRefreshes((deferred) => deferred.resolve(CLEAR));
  });

  it('recomputes clock expiry without a provider refresh and cleans timers on close', async () => {
    deferRefreshes(CODEX_BLOCKED);
    await open('home');
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
    const calls = refreshMock.mock.calls.length;
    jest.setSystemTime(RESET_MS);
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await flush();
    });
    expect(checkbox('codex-1')?.disabled).toBe(false);
    expect(checkbox('codex-1')?.checked).toBe(false);
    expect(refreshMock).toHaveBeenCalledTimes(calls);
    await act(async () => {
      useUsageLimitResumePromptStore.getState().close();
      await flush();
    });
    const listings = listSessionsMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await flush();
    });
    expect(listSessionsMock).toHaveBeenCalledTimes(listings);
    expect(refreshMock).toHaveBeenCalledTimes(calls);
  });

  it('keeps colliding chat and pipeline ids independent through removal', async () => {
    const pipeline: UsageLimitedSessionItem = {
      kind: 'pipeline',
      executionId: 'c1',
      provider: 'claude',
      statusReasonIds: ['r1'],
      pipelineName: 'Release',
      detectedAt: 1,
      pausedStepCount: 1,
      modelLabels: [],
      otherBlockingReasonCount: 0,
    };
    listSessionsMock.mockResolvedValue([
      { ...mixedGroups[0], sessions: [chat('c1', 'claude'), pipeline] },
    ]);
    deferRefreshes(CLEAR);
    await open('home');
    await settleRefreshes((deferred) => deferred.resolve(CLEAR));
    await act(async () => {
      checkbox('c1')?.click();
      await flush();
    });
    expect(
      query<HTMLInputElement>('usage-limit-resume-pipeline-c1')?.checked,
    ).toBe(true);
    listSessionsMock.mockResolvedValue([
      { ...mixedGroups[0], sessions: [pipeline] },
    ]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flush();
    });
    await act(async () => {
      query<HTMLButtonElement>('usage-limit-resume-confirm')?.click();
      await flush();
    });
    expect(enqueueMock).toHaveBeenCalledWith({
      targets: [
        { kind: 'pipeline', executionId: 'c1', statusReasonIds: ['r1'] },
      ],
    });
  });

  it('stays usable when the usage refresh fails', async () => {
    deferRefreshes(CODEX_BLOCKED);
    await open('home');
    await settleRefreshes((deferred) => deferred.reject(new Error('offline')));

    expect(checkbox('c1')?.checked).toBe(true);
    expect(checkbox('codex-1')?.disabled).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a refresh completing after the dialog reopened', async () => {
    deferRefreshes(CODEX_BLOCKED);
    await open('home');
    const stale = pendingRefreshes;
    pendingRefreshes = [];
    await act(async () => {
      useUsageLimitResumePromptStore.getState().close();
      await flush();
    });
    await open('home');
    expect(refreshMock).toHaveBeenCalledTimes(4);
    await act(async () => {
      stale.forEach((deferred) => deferred.resolve(CODEX_BLOCKED));
      await flush();
    });
    expect(query('usage-limit-resume-confirm')).toBeNull();
    await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
    expect(query('usage-limit-resume-confirm')?.textContent).toBe(
      'Resume 2 chats',
    );
  });

  it.each(['account-change', 'authentication'] as const)(
    'keeps ungated %s selection without readiness claims',
    async (origin) => {
      useObservabilityStore.setState({ usage: CODEX_BLOCKED });
      await open(origin);

      expect(refreshMock).not.toHaveBeenCalled();
      expect(checkbox('codex-1')?.checked).toBe(true);
      expect(checkbox('codex-1')?.disabled).toBe(false);
      expect(
        document.getElementById(
          checkbox('codex-1')?.getAttribute('aria-describedby') ?? '',
        )?.textContent,
      ).toBe('Codex · Usage limit');
      expect(query('usage-limit-resume-readiness-summary')).toBeNull();
      expect(query('usage-limit-resume-schedule-chat-codex-1')).toBeNull();
      expect(lastReport()).not.toHaveProperty('readyCount');
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume 3 chats',
      );
    },
  );

  it.each([
    ['claude', true, false],
    ['codex', true, false],
    ['claude', false, false],
    ['codex', false, false],
    ['claude', false, true],
    ['codex', false, true],
  ] as const)(
    'gates mixed targets with %s first (Codex blocked: %s; compatibility failure: %s)',
    async (firstProvider, codexBlocked, compatibilityFailure) => {
      const providers =
        firstProvider === 'claude' ? ['claude', 'codex'] : ['codex', 'claude'];
      listSessionsMock.mockResolvedValue([
        {
          ...mixedGroups[0],
          sessions: [
            {
              kind: 'pipeline',
              executionId: 'mixed-exec',
              statusReasonIds: providers.map((provider) => `${provider}-limit`),
              provider: firstProvider,
              pipelineName: 'Mixed run',
              detectedAt: 1,
              pausedStepCount: 2,
              modelLabels: [],
              otherBlockingReasonCount: 0,
              projectId: 'ws-a',
              resumeReasons: ['usage_limit'],
            },
          ],
        },
      ]);
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: {
          getExecution: jest.fn().mockResolvedValue({
            success: true,
            data: {
              status_reasons: providers.map((provider) => ({
                id: `${provider}-limit`,
                provider,
                kind: 'provider_usage_limit',
                account_scope: 'native',
                source: {
                  job_id: 'j',
                  step_id: provider,
                  attempt: 0,
                  iteration: 0,
                },
              })),
            },
          }),
        },
      });
      const snapshot = codexBlocked ? CODEX_BLOCKED : CLEAR;
      deferRefreshes(snapshot);
      await open('home');
      await settleRefreshes((deferred) => deferred.resolve(snapshot));
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          '[data-testid="usage-limit-resume-pipeline-mixed-exec"]',
        ),
      );
      expect(inputs).toHaveLength(2);
      const ready = inputs.find((input) =>
        document
          .getElementById(input.getAttribute('aria-describedby') ?? '')
          ?.textContent?.startsWith('Claude'),
      );
      const waiting = inputs.find((input) =>
        document
          .getElementById(input.getAttribute('aria-describedby') ?? '')
          ?.textContent?.startsWith('Codex'),
      );
      expect(ready?.checked).toBe(true);
      expect(waiting?.disabled).toBe(codexBlocked);
      expect(waiting?.checked).toBe(!codexBlocked);
      expect(ready?.id).not.toBe(waiting?.id);
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        codexBlocked ? 'Resume workflow' : 'Resume 2 workflows',
      );
      const payload = {
        targets: [
          {
            kind: 'pipeline',
            executionId: 'mixed-exec',
            statusReasonIds: codexBlocked
              ? ['claude-limit']
              : ['claude-limit', 'codex-limit'],
          },
        ],
      };
      const resumeSessions = jest.fn().mockResolvedValue({
        resumedCount: 0,
        staleCount: 0,
        failedTargets: payload.targets.map((target) => ({
          target,
          error: 'Try again',
        })),
      });
      if (compatibilityFailure) {
        Object.defineProperty(window, 'api', {
          configurable: true,
          value: {
            ...window.api,
            enqueueResumeQueue: undefined,
            resumeUsageLimitedSessions: resumeSessions,
          },
        });
      }
      await act(async () => {
        query<HTMLButtonElement>('usage-limit-resume-confirm')?.click();
        await flush();
      });
      if (compatibilityFailure) {
        expect(resumeSessions).toHaveBeenCalledWith(payload);
        expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
        expect(query('usage-limit-resume-confirm')?.textContent).toBe(
          'Resume 2 workflows',
        );
        expect(
          document.querySelectorAll(
            '[data-testid="usage-limit-resume-pipeline-mixed-exec"]',
          ),
        ).toHaveLength(2);
        expect(ready?.checked).toBe(true);
        expect(waiting?.checked).toBe(true);
      } else {
        expect(enqueueMock).toHaveBeenCalledWith(payload);
      }
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    'keeps projected metadata scoped (checkpoint: %s; Codex reset: %s)',
    async (checkpoint, codexHasReset) => {
      const ids = [
        'claude-auth',
        'codex-limit',
        ...(checkpoint ? ['shutdown'] : []),
      ];
      const pipelineGroups: UsageLimitedSessionGroup[] = [
        {
          ...mixedGroups[0],
          sessions: [
            {
              kind: 'pipeline',
              executionId: 'metadata-exec',
              statusReasonIds: ids,
              provider: 'claude',
              pipelineName: 'Mixed reasons',
              detectedAt: 1,
              pausedStepCount: 2,
              modelLabels: ['claude-model', 'codex-model'],
              otherBlockingReasonCount: 0,
              projectId: 'ws-a',
              resumeReasons: [
                'authentication',
                'usage_limit',
                ...(checkpoint ? ['app_shutdown' as const] : []),
              ],
              resetsAt: RESET_MS,
            },
          ],
        },
      ];
      listSessionsMock.mockResolvedValue(pipelineGroups);
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: {
          getExecution: jest.fn().mockResolvedValue({
            success: true,
            data: {
              status_reasons: [
                {
                  id: 'claude-auth',
                  provider: 'claude',
                  kind: 'provider_authentication_required',
                  resets_at: RESET_ISO,
                  model: 'claude-model',
                  source: {
                    job_id: 'j',
                    step_id: 'claude',
                    attempt: 0,
                    iteration: 0,
                  },
                },
                {
                  id: 'codex-limit',
                  provider: 'codex',
                  kind: 'provider_usage_limit',
                  account_scope: 'native',
                  ...(codexHasReset
                    ? { resets_at: new Date(RESET_MS + DAY_MS).toISOString() }
                    : {}),
                  model: 'codex-model',
                  source: {
                    job_id: 'j',
                    step_id: 'codex',
                    attempt: 0,
                    iteration: 0,
                  },
                },
              ],
              ...(checkpoint
                ? {
                    shutdown_checkpoint: {
                      id: 'shutdown',
                      detected_at: new Date(NOW_MS).toISOString(),
                    },
                  }
                : {}),
            },
          }),
        },
      });
      const projected =
        await resolveInterruptedSessionProviders(pipelineGroups);
      const sessions = projected[0]?.sessions ?? [];
      expect(sessions).toHaveLength(checkpoint ? 3 : 2);
      expect(
        sessions.find((session) => session.provider === 'claude'),
      ).toMatchObject({
        resumeReasons: ['authentication'],
        resetsAt: RESET_MS,
        pausedStepCount: 1,
        modelLabels: ['claude-model'],
      });
      expect(
        sessions.find((session) => session.provider === 'codex'),
      ).toMatchObject({
        resumeReasons: ['usage_limit'],
        resetsAt: codexHasReset ? RESET_MS + DAY_MS : undefined,
        pausedStepCount: 1,
        modelLabels: ['codex-model'],
      });
      if (checkpoint)
        expect(
          sessions.find((session) => session.provider === undefined),
        ).toMatchObject({
          statusReasonIds: ['shutdown'],
          resumeReasons: ['app_shutdown'],
          resetsAt: undefined,
          modelLabels: [],
        });
      const unknownReset = usage([{ provider: 'codex' }]);
      deferRefreshes(unknownReset);
      await open('home');
      await settleRefreshes((deferred) => deferred.resolve(unknownReset));
      const metadata = Array.from(
        document.querySelectorAll(
          '[data-testid="usage-limit-resume-pipeline-metadata-exec-metadata"]',
        ),
      ).map((node) => node.textContent);
      expect(metadata).toContain('Claude · Authentication issue · Ready now');
      if (codexHasReset)
        expect(metadata.find((text) => text?.startsWith('Codex'))).toMatch(
          /^Codex · Weekly limit · Resets /,
        );
      else
        expect(metadata).toContain('Codex · Weekly limit · Waiting for reset');
      if (checkpoint)
        expect(metadata).toContain(
          'Provider unavailable · Application stopped · Ready now',
        );
    },
  );

  it.each([
    ['rejected', true],
    ['missing', true],
    ['stale', true],
    ['stale', false],
  ] as const)(
    'isolates %s pipeline projection (valid chat: %s)',
    async (failure, includeChat) => {
      listSessionsMock.mockResolvedValue([
        {
          ...mixedGroups[0],
          sessions: [
            ...(includeChat ? [chat('c1', 'claude')] : []),
            {
              kind: 'pipeline',
              executionId: 'stale-exec',
              statusReasonIds: ['r1', 'r2'],
              provider: 'claude',
              pipelineName: 'Stale run',
              detectedAt: 1,
              pausedStepCount: 2,
              modelLabels: [],
              otherBlockingReasonCount: 0,
              projectId: 'ws-a',
            },
          ],
        },
      ]);
      const getExecution = jest.fn();
      if (failure === 'rejected')
        getExecution.mockRejectedValue(new Error('Execution gone'));
      else
        getExecution.mockResolvedValue({
          success: failure !== 'missing',
          data: { status_reasons: [] },
        });
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: { getExecution },
      });
      deferRefreshes(CLEAR);
      await open('home');
      await settleRefreshes((deferred) => deferred.resolve(CLEAR));
      if (!includeChat) {
        expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
        expect(enqueueMock).not.toHaveBeenCalled();
        return;
      }
      expect(checkbox('c1')?.checked).toBe(true);
      expect(query('usage-limit-resume-confirm')?.textContent).toBe(
        'Resume chat',
      );
      await act(async () => {
        query<HTMLButtonElement>('usage-limit-resume-confirm')?.click();
        await flush();
      });
      expect(enqueueMock).toHaveBeenCalledWith({
        targets: [
          { kind: 'chat', projectId: 'ws-a', worktreeId: 'wt', chatId: 'c1' },
        ],
      });
    },
  );

  describe('resume at reset', () => {
    // Home omits chats with a pending usage-limit resume (CAN-4970), so a
    // chat's scheduled status is shown in the other gated origins.
    async function openBlocked(
      origin: 'home' | 'usage-review' = 'home',
    ): Promise<void> {
      deferRefreshes(CODEX_BLOCKED);
      await open(origin);
      await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
      refreshMock
        .mockReset()
        .mockImplementation(() =>
          Promise.resolve(useObservabilityStore.getState().usage),
        );
    }

    function scheduleButton(): HTMLButtonElement | null {
      return query<HTMLButtonElement>(
        'usage-limit-resume-schedule-chat-codex-1',
      );
    }

    it('schedules a chat resume at the snapshot reset', async () => {
      await openBlocked('usage-review');
      const status = query('usage-limit-resume-schedule-status-chat-codex-1');
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.getAttribute('aria-live')).toBe('polite');
      createActivityMock.mockImplementation((request) => {
        const activity: ScheduledActivity = {
          ...request,
          version: 1,
          id: 'created-chat-resume',
          enabled: true,
          failureCount: 0,
          createdAt: '',
          updatedAt: '',
          nextRunAt: RESET_ISO,
        };
        useAutomationsStore.setState({ activities: [activity] });
        return Promise.resolve({ ok: true, activity });
      });
      const button = scheduleButton();
      expect(button?.textContent).toBe('Resume at reset');
      expect(button?.closest('label')).toBeNull();
      expect(button?.disabled).toBe(false);

      await act(async () => {
        button?.click();
        button?.click();
        await flush();
      });
      expect(refreshMock).toHaveBeenCalledWith('codex');
      expect(createActivityMock).toHaveBeenCalledTimes(1);
      expect(query('usage-limit-resume-schedule-status-chat-codex-1')).toBe(
        status,
      );
      expect(status?.textContent).toMatch(/^Scheduled for /);
      expect(status?.getAttribute('aria-atomic')).toBe('true');
      const [request] = createActivityMock.mock.calls[0] ?? [];
      expect(request).toMatchObject({
        name: 'Resume chat after Codex usage reset',
        schedule: { kind: 'one_time', runAt: RESET_ISO, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws-a',
          worktreeId: 'wt',
          chatId: 'codex-1',
          purpose: 'usage_limit_resume',
          workspaceName: 'Workspace A',
        },
      });
      expect(
        request?.action.type === 'worktree_session_prompt'
          ? request.action.prompt.length
          : 0,
      ).toBeGreaterThan(0);
    });

    describe('scheduled through this opening (CAN-5015)', () => {
      const CODEX_SUFFIX = 'chat-codex-1';

      function createdActivity(
        request: AutomationCreateRequest,
        id = 'created-chat-resume',
      ): ScheduledActivity {
        return {
          ...request,
          version: 1,
          id,
          enabled: true,
          failureCount: 0,
          createdAt: '',
          updatedAt: '',
          nextRunAt: RESET_ISO,
        };
      }

      /** Creates broadcast to the store before the response, like main. */
      function broadcastBeforeResponse(id = 'created-chat-resume'): void {
        createActivityMock.mockImplementation((request) => {
          const activity = createdActivity(request, id);
          useAutomationsStore.setState({
            activities: [
              ...useAutomationsStore.getState().activities,
              activity,
            ],
          });
          return Promise.resolve({ ok: true, activity });
        });
      }

      /** Deletes broadcast to the store before the response, like main. */
      function deleteBroadcasts(): void {
        deleteActivityMock.mockImplementation((id) => {
          useAutomationsStore.setState({
            activities: useAutomationsStore
              .getState()
              .activities.filter((activity) => activity.id !== id),
          });
          return Promise.resolve({ ok: true });
        });
      }

      function undoButton(): HTMLButtonElement | null {
        return query<HTMLButtonElement>(
          `usage-limit-resume-undo-schedule-${CODEX_SUFFIX}`,
        );
      }

      function status(): HTMLElement | null {
        return query(`usage-limit-resume-schedule-status-${CODEX_SUFFIX}`);
      }

      async function click(button: HTMLButtonElement | null): Promise<void> {
        await act(async () => {
          button?.click();
          await flush();
        });
      }

      async function scheduleCodex(): Promise<void> {
        broadcastBeforeResponse();
        await click(scheduleButton());
      }

      it('keeps the confirmation and offers Undo for the chat it scheduled', async () => {
        await openBlocked();
        const statusNode = status();
        await scheduleCodex();
        expect(createActivityMock).toHaveBeenCalledTimes(1);
        expect(status()).toBe(statusNode);
        expect(statusNode?.getAttribute('aria-live')).toBe('polite');
        expect(statusNode?.getAttribute('aria-atomic')).toBe('true');
        expect(statusNode?.textContent).toMatch(/^Scheduled for /);
        expect(statusNode?.contains(undoButton())).toBe(false);
        expect(undoButton()?.textContent).toBe('Undo');
        expect(undoButton()?.disabled).toBe(false);
        expect(undoButton()?.getAttribute('aria-describedby')).toBe(
          checkbox('codex-1')?.getAttribute('aria-describedby'),
        );
        expect(scheduleButton()).toBeNull();
        expect(checkbox('codex-1')?.checked).toBe(false);
        expect(checkbox('codex-1')?.disabled).toBe(true);
        expect(checkbox('c1')?.checked).toBe(true);
        expect(checkbox('c2')?.checked).toBe(true);
        expect(query('usage-limit-resume-readiness-summary')?.textContent).toBe(
          '2 ready now · 1 waiting for Codex reset',
        );
        expect(query('usage-limit-resume-confirm')?.textContent).toBe(
          'Resume 2 chats',
        );
      });

      it('retains the row while a broadcast arrives before the response', async () => {
        await openBlocked();
        const statusNode = status();
        let respond: (value: AutomationMutationResponse) => void = () =>
          undefined;
        createActivityMock.mockImplementation((request) => {
          const activity = createdActivity(request);
          useAutomationsStore.setState({ activities: [activity] });
          return new Promise((resolve) => {
            respond = (): void => resolve({ ok: true, activity });
          });
        });
        await click(scheduleButton());
        expect(checkbox('codex-1')).not.toBeNull();
        expect(status()).toBe(statusNode);
        expect(statusNode?.textContent).toBe('Scheduling…');
        expect(scheduleButton()?.textContent).toBe('Scheduling…');
        expect(scheduleButton()?.disabled).toBe(true);
        expect(undoButton()).toBeNull();
        await act(async () => {
          respond({ ok: true });
          await flush();
        });
        expect(status()).toBe(statusNode);
        expect(statusNode?.textContent).toMatch(/^Scheduled for /);
        expect(undoButton()?.textContent).toBe('Undo');
      });

      it('confirms from the response before the store broadcast', async () => {
        await openBlocked();
        let created: ScheduledActivity | null = null;
        createActivityMock.mockImplementation((request) => {
          created = createdActivity(request);
          return Promise.resolve({ ok: true, activity: created });
        });
        await click(scheduleButton());
        expect(status()?.textContent).toMatch(/^Scheduled for /);
        expect(undoButton()).not.toBeNull();
        await act(async () => {
          useAutomationsStore.setState({
            activities: created ? [created] : [],
          });
          await flush();
        });
        expect(undoButton()).not.toBeNull();
        // Once listed, an external deletion releases the Undo.
        await act(async () => {
          useAutomationsStore.setState({ activities: [] });
          await flush();
        });
        expect(undoButton()).toBeNull();
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
      });

      it('does not resurrect ownership when a create broadcast is removed before its response', async () => {
        await openBlocked();
        let respond: () => void = () => undefined;
        createActivityMock.mockImplementation((request) => {
          const activity = createdActivity(request);
          useAutomationsStore.setState({ activities: [activity] });
          return new Promise((resolve) => {
            respond = (): void => resolve({ ok: true, activity });
          });
        });
        await click(scheduleButton());
        await act(async () => {
          useAutomationsStore.setState({ activities: [] });
          await flush();
        });
        await act(async () => {
          respond();
          await flush();
        });
        expect(undoButton()).toBeNull();
        expect(status()?.textContent).toBe('');
        expect(scheduleButton()?.disabled).toBe(false);
      });

      it('keeps the same live region and focused control while scheduling refreshes automations', async () => {
        await openBlocked();
        const statusNode = status();
        const button = scheduleButton();
        let finishHydration: () => void = () => undefined;
        useAutomationsStore.setState({
          hydrate: () => {
            useAutomationsStore.setState({ loading: true });
            return new Promise<void>((resolve) => {
              finishHydration = (): void => {
                useAutomationsStore.setState({ loading: false });
                resolve();
              };
            });
          },
        });
        broadcastBeforeResponse();
        await act(async () => {
          button?.focus();
          button?.click();
          await flush();
        });
        expect(useAutomationsStore.getState().loading).toBe(true);
        expect(status()).toBe(statusNode);
        expect(statusNode?.isConnected).toBe(true);
        expect(document.activeElement).toBe(button);
        expect(button?.disabled).toBe(true);
        await act(async () => {
          finishHydration();
          await flush();
        });
        expect(status()).toBe(statusNode);
        expect(statusNode?.textContent).toMatch(/^Scheduled for /);
        expect(document.activeElement).toBe(undoButton());
      });

      it('undoes the created schedule before the store lists it', async () => {
        await openBlocked();
        createActivityMock.mockImplementation((request) =>
          Promise.resolve({ ok: true, activity: createdActivity(request) }),
        );
        await click(scheduleButton());
        expect(useAutomationsStore.getState().activities).toHaveLength(0);
        await click(undoButton());
        expect(deleteActivityMock).toHaveBeenCalledTimes(1);
        expect(deleteActivityMock).toHaveBeenCalledWith('created-chat-resume');
        expect(undoButton()).toBeNull();
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
      });

      it('undoes exactly the created schedule and offers it again', async () => {
        await openBlocked();
        await scheduleCodex();
        deleteBroadcasts();
        await click(undoButton());
        expect(deleteActivityMock).toHaveBeenCalledTimes(1);
        expect(deleteActivityMock).toHaveBeenCalledWith('created-chat-resume');
        expect(undoButton()).toBeNull();
        expect(status()?.textContent).toBe('');
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
        expect(scheduleButton()?.disabled).toBe(false);
        expect(checkbox('codex-1')?.disabled).toBe(true);
        expect(checkbox('codex-1')?.checked).toBe(false);

        broadcastBeforeResponse('second-resume');
        await click(scheduleButton());
        expect(createActivityMock).toHaveBeenCalledTimes(2);
        expect(useAutomationsStore.getState().activities).toHaveLength(1);
        expect(undoButton()).not.toBeNull();
      });

      it('keeps the row through a delete response that precedes its broadcast', async () => {
        await openBlocked();
        await scheduleCodex();
        await click(undoButton());
        // The store still lists the deleted activity; the row must not leave
        // or show a stale confirmation.
        expect(useAutomationsStore.getState().activities).toHaveLength(1);
        expect(checkbox('codex-1')).not.toBeNull();
        expect(status()?.textContent).toBe('');
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
      });

      it('never enables a duplicate action while a delete broadcast precedes the response', async () => {
        await openBlocked();
        await scheduleCodex();
        let respond: () => void = () => undefined;
        deleteActivityMock.mockImplementation((id) => {
          useAutomationsStore.setState({
            activities: useAutomationsStore
              .getState()
              .activities.filter((activity) => activity.id !== id),
          });
          return new Promise((resolve) => {
            respond = (): void => resolve({ ok: true });
          });
        });
        await click(undoButton());
        expect(scheduleButton()?.disabled).toBe(true);
        expect(undoButton()).toBeNull();
        await act(async () => {
          respond();
          await flush();
        });
        expect(scheduleButton()?.disabled).toBe(false);
        expect(deleteActivityMock).toHaveBeenCalledTimes(1);
      });

      it('keeps the confirmation after a failed Undo and allows a retry', async () => {
        await openBlocked();
        await scheduleCodex();
        let respond: (value: AutomationMutationResponse) => void = () =>
          undefined;
        deleteActivityMock.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              respond = resolve;
            }),
        );
        await click(undoButton());
        expect(undoButton()?.textContent).toBe('Undoing…');
        expect(undoButton()?.disabled).toBe(true);
        expect(status()?.textContent).toMatch(/^Scheduled for /);
        await click(undoButton());
        expect(deleteActivityMock).toHaveBeenCalledTimes(1);
        await act(async () => {
          respond({ ok: false, error: '' });
          await flush();
        });
        expect(document.querySelector('[role="alert"]')?.textContent).toBe(
          'Couldn’t undo this scheduled resume. Try again.',
        );
        expect(status()?.textContent).toMatch(/^Scheduled for /);
        expect(undoButton()?.textContent).toBe('Undo');

        deleteBroadcasts();
        await click(undoButton());
        expect(deleteActivityMock).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
      });

      it('shows the default copy when Undo throws', async () => {
        await openBlocked();
        await scheduleCodex();
        useAutomationsStore.setState({
          deleteActivity: (): Promise<AutomationMutationResponse> =>
            Promise.reject(new Error('IPC closed')),
        });
        await click(undoButton());
        expect(document.querySelector('[role="alert"]')?.textContent).toBe(
          'Couldn’t undo this scheduled resume. Try again.',
        );
        expect(undoButton()).not.toBeNull();
      });

      it('handles a schedule firing while its deletion is in flight without claiming rollback', async () => {
        await openBlocked();
        await scheduleCodex();
        let respond: (value: AutomationMutationResponse) => void = () =>
          undefined;
        deleteActivityMock.mockImplementation(
          () =>
            new Promise((resolve) => {
              respond = resolve;
            }),
        );
        await click(undoButton());
        const [owned] = useAutomationsStore.getState().activities;
        if (!owned) throw new Error('Expected the owned schedule');
        await act(async () => {
          useAutomationsStore.setState({
            activities: [
              {
                ...owned,
                enabled: false,
                lastResult: {
                  status: 'success',
                  completedAt: new Date(NOW_MS).toISOString(),
                },
              },
            ],
          });
          respond({
            ok: false,
            error:
              'Activity is running. Disable it now and delete it after the run finishes.',
          });
          await flush();
        });
        expect(deleteActivityMock).toHaveBeenCalledTimes(1);
        expect(deleteActivityMock).toHaveBeenCalledWith(owned.id);
        expect(undoButton()).toBeNull();
        expect(status()?.textContent).toBe('');
        expect(scheduleButton()?.disabled).toBe(false);
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          'Activity is running.',
        );
      });

      it('never lets a replacement schedule inherit the Undo', async () => {
        await openBlocked();
        await scheduleCodex();
        const [owned] = useAutomationsStore.getState().activities;
        if (!owned) throw new Error('expected the created activity');
        const replacement = { ...owned, id: 'replacement' };
        await act(async () => {
          useAutomationsStore.setState({ activities: [replacement] });
          await flush();
        });
        // Scheduled elsewhere now, so Home no longer lists the chat.
        expect(undoButton()).toBeNull();
        expect(checkbox('codex-1')).toBeNull();
        expect(deleteActivityMock).not.toHaveBeenCalled();
      });

      it('releases the Undo when the owned schedule fires', async () => {
        await openBlocked();
        await scheduleCodex();
        const [owned] = useAutomationsStore.getState().activities;
        if (!owned) throw new Error('expected the created activity');
        await act(async () => {
          useAutomationsStore.setState({
            activities: [
              {
                ...owned,
                enabled: false,
                lastResult: {
                  status: 'success',
                  completedAt: new Date(NOW_MS).toISOString(),
                },
              },
            ],
          });
          await flush();
        });
        expect(undoButton()).toBeNull();
        expect(status()?.textContent).toBe('');
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
        expect(deleteActivityMock).not.toHaveBeenCalled();
      });

      it('still removes a chat scheduled elsewhere', async () => {
        await openBlocked();
        await act(async () => {
          useAutomationsStore.setState({
            activities: [
              {
                ...createdActivity({
                  name: 'Resume',
                  schedule: {
                    kind: 'one_time',
                    runAt: RESET_ISO,
                    timezone: 'local',
                  },
                  action: {
                    type: 'worktree_session_prompt',
                    workspaceId: 'ws-a',
                    worktreeId: 'wt',
                    chatId: 'codex-1',
                    prompt: 'Continue',
                    purpose: 'usage_limit_resume',
                  },
                }),
                id: 'external',
              },
            ],
          });
          await flush();
        });
        expect(checkbox('codex-1')).toBeNull();
        expect(checkbox('c1')?.checked).toBe(true);
      });

      it('leaves no retention after a failed or cleared schedule', async () => {
        await openBlocked();
        createActivityMock.mockResolvedValueOnce({ ok: false, error: 'Nope' });
        await click(scheduleButton());
        expect(undoButton()).toBeNull();
        expect(scheduleButton()?.textContent).toBe('Resume at reset');
        // A later external schedule still removes the row.
        await act(async () => {
          useAutomationsStore.setState({
            activities: [
              createdActivity({
                name: 'Resume',
                schedule: {
                  kind: 'one_time',
                  runAt: RESET_ISO,
                  timezone: 'local',
                },
                action: {
                  type: 'worktree_session_prompt',
                  workspaceId: 'ws-a',
                  worktreeId: 'wt',
                  chatId: 'codex-1',
                  prompt: 'Continue',
                  purpose: 'usage_limit_resume',
                },
              }),
            ],
          });
          await flush();
        });
        expect(checkbox('codex-1')).toBeNull();
      });

      it('never resumes the retained chat, even after its limit clears', async () => {
        await openBlocked();
        await scheduleCodex();
        await act(async () => {
          useObservabilityStore.setState({ usage: CLEAR });
          jest.advanceTimersByTime(30_000);
          await flush();
        });
        expect(checkbox('codex-1')?.disabled).toBe(true);
        expect(checkbox('codex-1')?.checked).toBe(false);
        expect(undoButton()).not.toBeNull();
        await act(async () => {
          query<HTMLButtonElement>('usage-limit-resume-select-all')?.click();
          await flush();
        });
        await act(async () => {
          query<HTMLButtonElement>('usage-limit-resume-select-all')?.click();
          await flush();
        });
        await act(async () => {
          query<HTMLButtonElement>('usage-limit-resume-confirm')?.click();
          await flush();
        });
        expect(enqueueMock).toHaveBeenCalledTimes(1);
        const [{ targets }] = enqueueMock.mock.calls[0] as [
          { targets: { chatId: string }[] },
        ];
        expect(targets.map((target) => target.chatId)).toEqual(['c1', 'c2']);
      });

      it('releases provisional retention when the scheduling refresh clears the limit', async () => {
        await openBlocked();
        refreshMock.mockImplementationOnce(() => {
          useObservabilityStore.setState({ usage: CLEAR });
          return Promise.resolve(CLEAR);
        });
        await click(scheduleButton());
        expect(createActivityMock).not.toHaveBeenCalled();
        expect(undoButton()).toBeNull();
        expect(checkbox('codex-1')?.disabled).toBe(false);
        expect(checkbox('codex-1')?.checked).toBe(false);
      });

      it('keeps the dialog open after scheduling its last chat, then omits it on reopen', async () => {
        listSessionsMock.mockResolvedValue([
          { ...mixedGroups[0], sessions: [chat('codex-1', 'codex')] },
        ]);
        await openBlocked();
        await scheduleCodex();
        expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(true);
        expect(status()?.textContent).toMatch(/^Scheduled for /);
        expect(undoButton()).not.toBeNull();

        await act(async () => {
          query<HTMLButtonElement>('usage-limit-resume-cancel')?.click();
          await flush();
        });
        await openBlocked();
        // Nothing left to offer, so the reopened Home dialog dismisses itself.
        expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
        expect(useAutomationsStore.getState().activities).toHaveLength(1);
      });

      it('clears ownership on reopen', async () => {
        await openBlocked();
        await scheduleCodex();
        await act(async () => {
          query<HTMLButtonElement>('usage-limit-resume-cancel')?.click();
          await flush();
        });
        await openBlocked();
        expect(checkbox('codex-1')).toBeNull();
        expect(checkbox('c1')?.checked).toBe(true);
        expect(query('usage-limit-resume-readiness-summary')?.textContent).toBe(
          'All 2 ready now',
        );
        expect(useAutomationsStore.getState().activities).toHaveLength(1);
      });

      it('keeps a completion from an earlier opening out of the new one', async () => {
        await openBlocked();
        let respond: (value: AutomationMutationResponse) => void = () =>
          undefined;
        let created: ScheduledActivity | null = null;
        createActivityMock.mockImplementation((request) => {
          created = createdActivity(request);
          return new Promise((resolve) => {
            respond = resolve;
          });
        });
        const button = scheduleButton();
        await act(async () => {
          button?.focus();
          button?.click();
          await flush();
        });
        await act(async () => {
          query<HTMLButtonElement>('usage-limit-resume-cancel')?.click();
          await flush();
        });
        await openBlocked();
        await act(async () => {
          respond({ ok: false, error: 'Old failure' });
          await flush();
        });
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(undoButton()).toBeNull();
        expect(document.activeElement).not.toBe(scheduleButton());

        // A successful late completion doesn't pin the row in the new opening.
        createActivityMock.mockClear();
        await act(async () => {
          useAutomationsStore.setState({
            activities: created ? [created] : [],
          });
          await flush();
        });
        expect(checkbox('codex-1')).toBeNull();
      });

      it('schedules two rows independently', async () => {
        const waiting: UsageLimitedSessionGroup[] = [
          {
            ...mixedGroups[0],
            sessions: [
              chat('codex-1', 'codex'),
              chat('codex-2', 'codex'),
              chat('c1', 'claude'),
            ],
          },
        ];
        listSessionsMock.mockResolvedValue(waiting);
        await openBlocked();
        const responses: (() => void)[] = [];
        let next = 0;
        createActivityMock.mockImplementation((request) => {
          next += 1;
          const activity = createdActivity(request, `created-${next}`);
          return new Promise((resolve) => {
            responses.push(() => {
              useAutomationsStore.setState({
                activities: [
                  ...useAutomationsStore.getState().activities,
                  activity,
                ],
              });
              resolve({ ok: true, activity });
            });
          });
        });
        await click(scheduleButton());
        await click(
          query<HTMLButtonElement>('usage-limit-resume-schedule-chat-codex-2'),
        );
        await act(async () => {
          responses.forEach((respond) => respond());
          await flush();
        });
        expect(undoButton()).not.toBeNull();
        expect(
          query('usage-limit-resume-undo-schedule-chat-codex-2'),
        ).not.toBeNull();
        deleteBroadcasts();
        await click(
          query<HTMLButtonElement>(
            'usage-limit-resume-undo-schedule-chat-codex-2',
          ),
        );
        expect(deleteActivityMock).toHaveBeenCalledWith('created-2');
        expect(undoButton()).not.toBeNull();
      });

      describe.each(['reopen', 'context'] as const)(
        'late completion after %s',
        (boundary) => {
          it.each([
            ['schedule', true],
            ['schedule', false],
            ['undo', true],
            ['undo', false],
          ] as const)(
            'ignores old %s completion (success: %s)',
            async (operation, success) => {
              useFeatureFlagsStore.setState({
                snapshot: {
                  ...getDefaultFeatureFlagSnapshot(),
                  values: {
                    ...getDefaultFeatureFlagSnapshot().values,
                    [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
                  },
                },
              });
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
              useWorkspaceContextStore.setState({
                hydrated: true,
                appliedGeneration: 1,
                state: {
                  context: { kind: 'personal' },
                  revision: 1,
                  organizations: [],
                },
              });
              await openBlocked();
              if (operation === 'undo') await scheduleCodex();
              let created: ScheduledActivity | undefined;
              let respond: (value: AutomationMutationResponse) => void = () =>
                undefined;
              if (operation === 'schedule') {
                createActivityMock.mockImplementation((request) => {
                  created = createdActivity(request);
                  return new Promise((resolve) => {
                    respond = resolve;
                  });
                });
              } else {
                deleteActivityMock.mockImplementation(
                  () =>
                    new Promise((resolve) => {
                      respond = resolve;
                    }),
                );
              }
              await act(async () => {
                const control =
                  operation === 'schedule' ? scheduleButton() : undoButton();
                control?.focus();
                control?.click();
                await flush();
              });
              if (boundary === 'reopen') {
                await click(
                  query<HTMLButtonElement>('usage-limit-resume-cancel'),
                );
                await openBlocked();
              } else {
                deferRefreshes(CODEX_BLOCKED);
                await act(async () => {
                  useWorkspaceContextStore.setState({ appliedGeneration: 2 });
                  await flush();
                });
                await settleRefreshes((deferred) =>
                  deferred.resolve(CODEX_BLOCKED),
                );
              }
              const elsewhere = query<HTMLButtonElement>(
                'usage-limit-resume-select-all',
              );
              expect(elsewhere).not.toBeNull();
              act(() => elsewhere?.focus());
              await act(async () => {
                if (success) {
                  useAutomationsStore.setState({
                    activities: created ? [created] : [],
                  });
                  respond({
                    ok: true,
                    activity: created,
                    created: operation === 'schedule',
                  });
                } else {
                  respond({ ok: false, error: 'Old opening failure' });
                }
                await flush();
              });
              expect(undoButton()).toBeNull();
              expect(document.querySelector('[role="alert"]')).toBeNull();
              expect(document.activeElement).toBe(elsewhere);
              expect(checkbox('c1')?.checked).toBe(true);
              expect(checkbox('c2')?.checked).toBe(true);
              expect(enqueueMock).not.toHaveBeenCalled();
            },
          );
        },
      );

      it.each(['usage-review', 'app-restart'] as const)(
        'offers no Undo for an existing schedule in %s',
        async (origin) => {
          deferRefreshes(CODEX_BLOCKED);
          useAutomationsStore.setState({
            activities: [
              createdActivity({
                name: 'Resume',
                schedule: {
                  kind: 'one_time',
                  runAt: RESET_ISO,
                  timezone: 'local',
                },
                action: {
                  type: 'worktree_session_prompt',
                  workspaceId: 'ws-a',
                  worktreeId: 'wt',
                  chatId: 'codex-1',
                  prompt: 'Continue',
                  purpose: 'usage_limit_resume',
                },
              }),
            ],
          });
          await open(origin);
          await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
          expect(status()?.textContent).toMatch(/^Scheduled for /);
          expect(undoButton()).toBeNull();
        },
      );

      describe('focus', () => {
        it('moves to Undo after scheduling, and back after undoing', async () => {
          await openBlocked();
          broadcastBeforeResponse();
          const button = scheduleButton();
          await act(async () => {
            button?.focus();
            button?.click();
            await flush();
          });
          expect(document.activeElement).toBe(undoButton());
          deleteBroadcasts();
          await act(async () => {
            undoButton()?.click();
            await flush();
          });
          expect(document.activeElement).toBe(scheduleButton());
        });

        it('stays on the schedule control after a failure', async () => {
          await openBlocked();
          createActivityMock.mockResolvedValueOnce({
            ok: false,
            error: 'Nope',
          });
          const button = scheduleButton();
          await act(async () => {
            button?.focus();
            button?.click();
            await flush();
          });
          expect(document.activeElement).toBe(scheduleButton());
        });

        it('stays on Undo after a failed deletion', async () => {
          await openBlocked();
          await scheduleCodex();
          deleteActivityMock.mockResolvedValueOnce({
            ok: false,
            error: 'Locked',
          });
          await act(async () => {
            undoButton()?.focus();
            undoButton()?.click();
            await flush();
          });
          expect(document.activeElement).toBe(undoButton());
        });

        it('does not take focus after a pointer interaction elsewhere during a slow create', async () => {
          await openBlocked();
          let respond: () => void = () => undefined;
          createActivityMock.mockImplementation((request) => {
            const activity = createdActivity(request);
            return new Promise((resolve) => {
              respond = (): void => resolve({ ok: true, activity });
            });
          });
          await act(async () => {
            scheduleButton()?.focus();
            scheduleButton()?.click();
            await flush();
          });
          act(() => {
            query('usage-limit-resume-readiness-summary')?.dispatchEvent(
              new Event('pointerdown', { bubbles: true }),
            );
          });
          await act(async () => {
            respond();
            await flush();
          });
          expect(undoButton()).not.toBeNull();
          expect(document.activeElement).not.toBe(undoButton());
        });

        it('is not taken back after the user moves elsewhere', async () => {
          await openBlocked();
          let respond: () => void = () => undefined;
          createActivityMock.mockImplementation((request) => {
            const activity = createdActivity(request);
            return new Promise((resolve) => {
              respond = (): void => resolve({ ok: true, activity });
            });
          });
          const button = scheduleButton();
          await act(async () => {
            button?.focus();
            button?.click();
            await flush();
          });
          const elsewhere = query<HTMLButtonElement>(
            'usage-limit-resume-select-all',
          );
          act(() => elsewhere?.focus());
          await act(async () => {
            respond();
            await flush();
          });
          expect(undoButton()).not.toBeNull();
          expect(document.activeElement).toBe(elsewhere);
        });

        it('is not moved when the control was not focused', async () => {
          await openBlocked();
          broadcastBeforeResponse();
          await click(scheduleButton());
          expect(document.activeElement).not.toBe(undoButton());
        });
      });
    });

    it('resends the hydrated unanswered user prompt with its attachments', async () => {
      mockMessages = [
        {
          id: 'm1',
          role: 'user',
          timestamp: NOW_MS,
          blocks: [{ type: 'text', text: 'Fix the test' }],
          attachmentPaths: ['/fixture/input.png'],
          inputMode: 'voice',
        },
      ];
      await openBlocked();
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      expect(createActivityMock.mock.calls[0]?.[0].action).toMatchObject({
        prompt: 'Fix the test',
        attachmentPaths: ['/fixture/input.png'],
        inputMode: 'voice',
      });
    });

    it('shows a matching pending schedule instead of the button', async () => {
      await openBlocked('usage-review');
      const activity: ScheduledActivity = {
        version: 1,
        id: 'a1',
        name: 'Resume chat',
        enabled: true,
        failureCount: 0,
        schedule: { kind: 'one_time', runAt: RESET_ISO, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws-a',
          worktreeId: 'wt',
          chatId: 'codex-1',
          prompt: 'Continue',
          purpose: 'usage_limit_resume',
        },
        createdAt: '',
        updatedAt: '',
        nextRunAt: RESET_ISO,
      };
      await act(async () => {
        useAutomationsStore.setState({
          activities: [
            { ...activity, id: 'disabled', enabled: false },
            {
              ...activity,
              id: 'other',
              action: {
                type: 'worktree_session_prompt',
                workspaceId: 'ws-a',
                worktreeId: 'wt',
                chatId: 'c1',
                prompt: 'Continue',
                purpose: 'usage_limit_resume',
              },
            },
          ],
        });
        await flush();
      });
      expect(scheduleButton()).not.toBeNull();
      await act(async () => {
        useAutomationsStore.setState({ activities: [activity] });
        await flush();
      });
      expect(scheduleButton()).toBeNull();
      expect(
        query('usage-limit-resume-scheduled-chat-codex-1')?.textContent,
      ).toMatch(/^Scheduled for .+/);
    });

    it('does not duplicate an activity that arrives during refresh', async () => {
      await openBlocked();
      deferRefreshes(CODEX_BLOCKED);
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      await act(async () => {
        useAutomationsStore.setState({
          activities: [
            {
              version: 1,
              id: 'arrived',
              name: 'Resume',
              enabled: true,
              schedule: {
                kind: 'one_time',
                runAt: RESET_ISO,
                timezone: 'local',
              },
              action: {
                type: 'worktree_session_prompt',
                workspaceId: 'ws-a',
                worktreeId: 'wt',
                chatId: 'codex-1',
                purpose: 'usage_limit_resume',
                prompt: 'Continue',
              },
              createdAt: '',
              updatedAt: '',
              nextRunAt: RESET_ISO,
              failureCount: 0,
            },
          ],
        });
        await flush();
      });
      await settleRefreshes((deferred) => deferred.resolve(CODEX_BLOCKED));
      expect(createActivityMock).not.toHaveBeenCalled();
    });

    it('shows the actual earlier scheduled time with its limitation', async () => {
      await openBlocked('usage-review');
      const earlier = new Date(RESET_MS - DAY_MS).toISOString();
      await act(async () => {
        useAutomationsStore.setState({
          activities: [
            {
              version: 1,
              id: 'earlier',
              name: 'Resume',
              enabled: true,
              schedule: { kind: 'one_time', runAt: earlier, timezone: 'local' },
              action: {
                type: 'worktree_session_prompt',
                workspaceId: 'ws-a',
                worktreeId: 'wt',
                chatId: 'codex-1',
                purpose: 'usage_limit_resume',
                prompt: 'Continue',
              },
              createdAt: '',
              updatedAt: '',
              nextRunAt: earlier,
              failureCount: 0,
            },
          ],
        });
        await flush();
      });
      expect(
        query('usage-limit-resume-scheduled-chat-codex-1')?.textContent,
      ).toMatch(/^Scheduled for .+, before the reset$/);
    });

    it('creates nothing when the limit cleared during the refresh', async () => {
      await openBlocked();
      refreshMock.mockImplementation(() => {
        useObservabilityStore.setState({ usage: CLEAR });
        return Promise.resolve(CLEAR);
      });
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      expect(createActivityMock).not.toHaveBeenCalled();
      expect(checkbox('codex-1')?.disabled).toBe(false);
      expect(checkbox('codex-1')?.checked).toBe(false);
    });

    it('explains a missing reset and allows a retry after a failure', async () => {
      await openBlocked();
      const unknownReset = usage([{ provider: 'codex' }]);
      refreshMock.mockImplementation(() => {
        useObservabilityStore.setState({ usage: unknownReset });
        return Promise.resolve(unknownReset);
      });
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      expect(createActivityMock).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'reset time isn’t available',
      );

      refreshMock.mockImplementation(() => {
        useObservabilityStore.setState({ usage: CODEX_BLOCKED });
        return Promise.resolve(CODEX_BLOCKED);
      });
      createActivityMock.mockResolvedValueOnce({ ok: false, error: 'Nope' });
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(
        'Nope',
      );
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      expect(createActivityMock).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    it('creates nothing while another blocking window has no known reset', async () => {
      await openBlocked();
      const partlyUnknown: AgentUsageOverview = {
        updatedAt: new Date().toISOString(),
        providers: [
          {
            provider: 'codex',
            authState: 'authenticated',
            hasRemainingLimits: false,
            rateLimits: [
              {
                limitId: 'codex',
                primary: { usedPercent: 100, windowDurationMins: 300 },
                secondary: {
                  usedPercent: 100,
                  windowDurationMins: 7 * 24 * 60,
                  resetsAt: RESET_ISO,
                },
              },
            ],
          },
        ],
      };
      refreshMock.mockImplementation(() => {
        useObservabilityStore.setState({ usage: partlyUnknown });
        return Promise.resolve(partlyUnknown);
      });
      await act(async () => {
        scheduleButton()?.click();
        await flush();
      });
      expect(createActivityMock).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'reset time isn’t available',
      );
    });

    describe('for a pipeline', () => {
      const pipeline: UsageLimitedSessionItem = {
        kind: 'pipeline',
        executionId: 'exec-1',
        statusReasonIds: ['limit-1', 'other-1'],
        provider: 'codex',
        pipelineName: 'Release',
        detectedAt: 1,
        resumeReasons: ['usage_limit'],
        pausedStepCount: 1,
        modelLabels: [],
        otherBlockingReasonCount: 0,
        projectId: 'ws-a',
      };
      const getExecutionMock = jest.fn();

      beforeEach(() => {
        listSessionsMock.mockResolvedValue([
          { ...mixedGroups[0], sessions: [chat('c1', 'claude'), pipeline] },
        ]);
        getExecutionMock.mockReset().mockResolvedValue({
          success: true,
          data: {
            status_reasons: [
              {
                id: 'limit-1',
                kind: 'provider_usage_limit',
                provider: 'codex',
                account_scope: 'native',
              },
              { id: 'other-1', kind: 'input_required', provider: 'codex' },
            ],
          },
        });
        Object.defineProperty(window, 'pipelines', {
          configurable: true,
          value: { getExecution: getExecutionMock },
        });
      });

      function pipelineButton(): HTMLButtonElement | null {
        return query<HTMLButtonElement>(
          'usage-limit-resume-schedule-pipeline-exec-1',
        );
      }

      it('schedules the complete applicable provider target at the usage reset', async () => {
        getExecutionMock.mockResolvedValue({
          success: true,
          data: {
            status_reasons: [
              {
                id: 'limit-1',
                kind: 'provider_usage_limit',
                provider: 'codex',
                account_scope: 'native',
                detected_at: new Date(0).toISOString(),
                source: { job_id: 'j', step_id: 's', attempt: 0, iteration: 0 },
              },
              {
                id: 'other-1',
                kind: 'provider_authentication_required',
                provider: 'codex',
                account_scope: 'native',
                detected_at: new Date(0).toISOString(),
                source: { job_id: 'j', step_id: 's', attempt: 0, iteration: 0 },
              },
              {
                id: 'credits-limit',
                kind: 'provider_usage_limit',
                provider: 'codex',
                account_scope: 'ai_credits',
                resets_at: RESET_ISO,
              },
            ],
          },
        });
        await openBlocked();
        await act(async () => {
          pipelineButton()?.click();
          await flush();
        });
        expect(getExecutionMock).toHaveBeenCalledWith('exec-1');
        const [request] = createActivityMock.mock.calls[0] ?? [];
        expect(request).toMatchObject({
          name: 'Resume workflow after Codex usage reset',
          schedule: { kind: 'one_time', runAt: RESET_ISO, timezone: 'local' },
          action: {
            type: 'pipeline_execution_resume',
            executionId: 'exec-1',
            statusReasonIds: ['limit-1', 'other-1'],
            provider: 'codex',
            purpose: 'usage_limit_resume',
            pipelineName: 'Release',
            projectId: 'ws-a',
          },
        });
      });

      function pipelineActivity(
        request: AutomationCreateRequest,
        id: string,
      ): ScheduledActivity {
        return {
          ...request,
          version: 1,
          id,
          enabled: true,
          failureCount: 0,
          createdAt: '',
          updatedAt: '',
          nextRunAt: RESET_ISO,
        };
      }

      it('undoes exactly the created resume for the resolved target', async () => {
        await openBlocked();
        createActivityMock.mockImplementation((request) => {
          const activity = pipelineActivity(request, 'created-pipeline');
          useAutomationsStore.setState({ activities: [activity] });
          return Promise.resolve({ ok: true, activity, created: true });
        });
        await act(async () => {
          pipelineButton()?.click();
          await flush();
        });
        const undo = query<HTMLButtonElement>(
          'usage-limit-resume-undo-schedule-pipeline-exec-1',
        );
        expect(undo?.textContent).toBe('Undo');
        deleteActivityMock.mockImplementation(() => {
          useAutomationsStore.setState({ activities: [] });
          return Promise.resolve({ ok: true });
        });
        await act(async () => {
          undo?.click();
          await flush();
        });
        expect(deleteActivityMock).toHaveBeenCalledWith('created-pipeline');
        expect(pipelineButton()?.textContent).toBe('Resume at reset');
      });

      it('offers no Undo when main returns an existing resume', async () => {
        await openBlocked();
        const existing = pipelineActivity(
          {
            name: 'Resume workflow',
            schedule: { kind: 'one_time', runAt: RESET_ISO, timezone: 'local' },
            action: {
              type: 'pipeline_execution_resume',
              executionId: 'exec-1',
              pipelineName: 'Resume workflow',
              statusReasonIds: ['limit-1'],
              provider: 'codex',
              purpose: 'usage_limit_resume',
            },
          },
          'existing-pipeline',
        );
        // Disabled locally, so the renderer creates; main deduplicates it.
        await act(async () => {
          useAutomationsStore.setState({
            activities: [{ ...existing, enabled: false }],
          });
          await flush();
        });
        createActivityMock.mockImplementation(() => {
          useAutomationsStore.setState({ activities: [existing] });
          return Promise.resolve({ ok: true, activity: existing });
        });
        await act(async () => {
          pipelineButton()?.click();
          await flush();
        });
        expect(createActivityMock).toHaveBeenCalledTimes(1);
        expect(
          query('usage-limit-resume-scheduled-pipeline-exec-1')?.textContent,
        ).toMatch(/^Scheduled for /);
        expect(
          query('usage-limit-resume-undo-schedule-pipeline-exec-1'),
        ).toBeNull();
      });

      it.each([false, undefined])(
        'never owns an unseen pipeline activity without affirmative creation provenance (%s)',
        async (created) => {
          await openBlocked();
          createActivityMock.mockImplementation((request) => {
            const activity = pipelineActivity(request, 'external-pipeline');
            useAutomationsStore.setState({ activities: [activity] });
            return Promise.resolve({ ok: true, activity, created });
          });
          await act(async () => {
            pipelineButton()?.click();
            await flush();
          });
          expect(createActivityMock).toHaveBeenCalledTimes(1);
          expect(
            query('usage-limit-resume-scheduled-pipeline-exec-1')?.textContent,
          ).toMatch(/^Scheduled for /);
          expect(
            query('usage-limit-resume-undo-schedule-pipeline-exec-1'),
          ).toBeNull();
          expect(deleteActivityMock).not.toHaveBeenCalled();
        },
      );

      it.each([false, true])(
        'includes new usage reasons and displays the complete target (older schedule: %s)',
        async (olderSchedule) => {
          const listedReasons = [
            {
              id: 'limit-1',
              kind: 'provider_usage_limit',
              provider: 'codex',
              account_scope: 'native',
            },
            { id: 'other-1', kind: 'input_required', provider: 'codex' },
          ];
          getExecutionMock.mockResolvedValue({
            success: true,
            data: { status_reasons: listedReasons },
          });
          await openBlocked();
          getExecutionMock.mockResolvedValue({
            success: true,
            data: {
              status_reasons: [
                ...listedReasons,
                {
                  id: 'limit-2',
                  kind: 'provider_usage_limit',
                  provider: 'codex',
                  account_scope: 'native',
                },
                {
                  id: 'claude-limit',
                  kind: 'provider_usage_limit',
                  provider: 'claude',
                  account_scope: 'native',
                },
              ],
            },
          });
          if (olderSchedule) {
            // A schedule for the listed usage reason must not suppress the
            // new target that also includes the subsequently paused step.
            listSessionsMock.mockResolvedValue([
              {
                ...mixedGroups[0],
                sessions: [{ ...pipeline, statusReasonIds: ['limit-1'] }],
              },
            ]);
            await act(async () => {
              useAutomationsStore.setState({
                activities: [
                  {
                    version: 1,
                    id: 'older-resume',
                    name: 'Resume',
                    enabled: true,
                    failureCount: 0,
                    createdAt: '',
                    updatedAt: '',
                    nextRunAt: RESET_ISO,
                    schedule: {
                      kind: 'one_time',
                      runAt: RESET_ISO,
                      timezone: 'local',
                    },
                    action: {
                      type: 'pipeline_execution_resume',
                      executionId: 'exec-1',
                      statusReasonIds: ['limit-1'],
                      provider: 'codex',
                      purpose: 'usage_limit_resume',
                      pipelineName: 'Build',
                    },
                  },
                ],
              });
              // Reopen so the registry lists only the original usage reason.
              useUsageLimitResumePromptStore.getState().close();
              await flush();
            });
            await open('home');
          }
          createActivityMock.mockImplementation((request) => {
            const activity: ScheduledActivity = {
              ...request,
              version: 1,
              id: 'pipeline-resume',
              enabled: true,
              failureCount: 0,
              createdAt: '',
              updatedAt: '',
              nextRunAt: RESET_ISO,
            };
            useAutomationsStore.setState({ activities: [activity] });
            return Promise.resolve({ ok: true, activity });
          });
          await act(async () => {
            pipelineButton()?.click();
            await flush();
          });
          expect(createActivityMock).toHaveBeenCalledTimes(1);
          expect(createActivityMock.mock.calls[0]?.[0].action).toMatchObject({
            type: 'pipeline_execution_resume',
            statusReasonIds: ['limit-1', 'limit-2'],
            provider: 'codex',
          });
          expect(
            query('usage-limit-resume-scheduled-pipeline-exec-1')?.textContent,
          ).toMatch(/^Scheduled for /);
          expect(pipelineButton()).toBeNull();
        },
      );

      it('requires every applicable interruption in an existing scheduled target', async () => {
        getExecutionMock.mockResolvedValue({
          success: true,
          data: {
            status_reasons: [
              {
                id: 'limit-1',
                kind: 'provider_usage_limit',
                provider: 'codex',
                account_scope: 'native',
              },
              {
                id: 'other-1',
                kind: 'provider_authentication_required',
                provider: 'codex',
              },
            ],
          },
        });
        await openBlocked();
        await act(async () => {
          useAutomationsStore.setState({
            activities: [
              {
                version: 1,
                id: 'pipeline-resume',
                name: 'Resume',
                enabled: true,
                failureCount: 0,
                createdAt: '',
                updatedAt: '',
                nextRunAt: RESET_ISO,
                schedule: {
                  kind: 'one_time',
                  runAt: RESET_ISO,
                  timezone: 'local',
                },
                action: {
                  type: 'pipeline_execution_resume',
                  executionId: 'exec-1',
                  provider: 'codex',
                  purpose: 'usage_limit_resume',
                  statusReasonIds: ['limit-1'],
                  pipelineName: 'Build',
                },
              },
            ],
          });
          await flush();
        });
        expect(
          query('usage-limit-resume-scheduled-pipeline-exec-1'),
        ).toBeNull();
        expect(pipelineButton()).not.toBeNull();
        await act(async () => {
          useAutomationsStore.setState((state) => ({
            activities: state.activities.map((activity) =>
              activity.action.type === 'pipeline_execution_resume'
                ? {
                    ...activity,
                    action: {
                      ...activity.action,
                      statusReasonIds: ['limit-1', 'other-1'],
                    },
                  }
                : activity,
            ),
          }));
          await flush();
        });
        expect(
          query('usage-limit-resume-scheduled-pipeline-exec-1')?.textContent,
        ).toMatch(/^Scheduled for /);
        expect(pipelineButton()).toBeNull();
      });

      it.each([
        ['provider_authentication_required', true],
        ['app_shutdown', true],
        ['provider_authentication_required', false],
        ['app_shutdown', false],
      ] as const)(
        'schedules a %s target only with a known provider reset (%s)',
        async (kind, knownReset) => {
          listSessionsMock.mockResolvedValue([
            {
              ...mixedGroups[0],
              sessions: [
                {
                  ...pipeline,
                  statusReasonIds: ['other-1'],
                  resumeReasons: [
                    kind === 'app_shutdown' ? 'app_shutdown' : 'authentication',
                  ],
                },
              ],
            },
          ]);
          getExecutionMock.mockResolvedValue({
            success: true,
            data: {
              status_reasons: [
                {
                  id: 'other-1',
                  kind,
                  provider: 'codex',
                  account_scope: 'native',
                  resets_at: new Date(NOW_MS + DAY_MS).toISOString(),
                },
              ],
            },
          });
          await openBlocked();
          if (!knownReset)
            refreshMock.mockImplementation(() => {
              const snapshot = usage([{ provider: 'codex' }]);
              useObservabilityStore.setState({ usage: snapshot });
              return Promise.resolve(snapshot);
            });
          await act(async () => {
            pipelineButton()?.click();
            await flush();
          });
          if (knownReset)
            expect(createActivityMock.mock.calls[0]?.[0]).toMatchObject({
              schedule: { kind: 'one_time', runAt: RESET_ISO },
              action: {
                type: 'pipeline_execution_resume',
                executionId: 'exec-1',
                pipelineName: 'Release',
                provider: 'codex',
                statusReasonIds: ['other-1'],
              },
            });
          else {
            expect(createActivityMock).not.toHaveBeenCalled();
            expect(
              document.querySelector('[role="alert"]')?.textContent,
            ).toContain('reset time isn’t available');
          }
        },
      );

      it('does not schedule a partially resolved set of paused reasons', async () => {
        await openBlocked();
        getExecutionMock.mockResolvedValue({
          success: true,
          data: {
            status_reasons: [
              {
                id: 'limit-1',
                kind: 'provider_usage_limit',
                provider: 'codex',
                account_scope: 'native',
                detected_at: new Date(0).toISOString(),
                source: { job_id: 'j', step_id: 's', attempt: 0, iteration: 0 },
              },
            ],
          },
        });
        await act(async () => {
          pipelineButton()?.click();
          await flush();
        });
        expect(createActivityMock).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          'Couldn’t find this workflow’s paused steps',
        );
      });

      it('shows a recoverable error when the paused reasons are missing', async () => {
        await openBlocked();
        getExecutionMock.mockResolvedValue({
          success: true,
          data: { status_reasons: [] },
        });
        await act(async () => {
          pipelineButton()?.click();
          await flush();
        });
        expect(createActivityMock).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          'Couldn’t find this workflow’s paused steps',
        );
        expect(pipelineButton()?.disabled).toBe(false);
      });
    });
  });
});
