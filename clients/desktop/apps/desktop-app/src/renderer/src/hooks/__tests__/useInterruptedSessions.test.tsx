/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AutomationsListResponse,
  ScheduledActivity,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import type { InterruptedSessionsSummary } from '@/lib/interruptedSessions';
import { useAutomationsStore } from '@/stores/automationsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useInterruptedSessions } from '../useInterruptedSessions';
import { useObservabilityStore } from '@/stores/observabilityStore';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function chatGroup(workspaceId: string): UsageLimitedSessionGroup {
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
        provider: 'claude',
        detectedAt: 1,
        chatTitle: 'Chat',
        worktreeName: 'wt',
      },
    ],
  };
}

const NOW = Date.parse('2026-10-25T12:00:00.000Z');

function resumeFor(
  workspaceId: string,
  nextRunAt = '2026-10-25T13:00:00.000Z',
  id = `resume-${workspaceId}`,
): ScheduledActivity {
  return {
    version: 1,
    id,
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
  };
}

function snapshotOf(activities: ScheduledActivity[]): AutomationsListResponse {
  return { activities, recentRuns: [] };
}

function SummaryProbe({
  isInContext,
  onSummary,
  active = true,
}: {
  active?: boolean;
  isInContext: (workspaceId: string) => boolean;
  onSummary: (summary: InterruptedSessionsSummary) => void;
}): JSX.Element {
  onSummary(useInterruptedSessions(active, isInContext));
  return <></>;
}

describe('useInterruptedSessions', () => {
  let root: Root;
  const summaries: InterruptedSessionsSummary[] = [];

  beforeEach(() => {
    summaries.length = 0;
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
    Reflect.deleteProperty(window, 'api');
    jest.restoreAllMocks();
  });

  it('keeps an absent preload listing API distinct from a failed production request', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} });
    await act(async () => {
      root.render(
        <SummaryProbe
          isInContext={() => true}
          onSummary={(summary) => summaries.push(summary)}
        />,
      );
      await Promise.resolve();
    });
    expect(summaries.at(-1)?.count).toBe(0);
  });

  it('keeps a failed initial listing unresolved and retries on focus', async () => {
    const listUsageLimitedIdleSessions = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([chatGroup('ws-a')]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const isInContext = (): boolean => true;
    await act(async () => {
      root.render(
        <SummaryProbe
          isInContext={isInContext}
          onSummary={(summary) => summaries.push(summary)}
        />,
      );
      await Promise.resolve();
    });
    expect(summaries.at(-1)?.count).toBe(0);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(summaries.at(-1)?.count).toBe(1);
  });

  it('publishes a renamed session without churning on identical refreshes', async () => {
    const renamed = chatGroup('ws-a');
    const [session] = renamed.sessions;
    if (session?.kind !== 'chat') throw new Error('expected a chat');
    const listUsageLimitedIdleSessions = jest
      .fn()
      .mockResolvedValueOnce([chatGroup('ws-a')])
      .mockResolvedValueOnce([chatGroup('ws-a')])
      .mockResolvedValue([
        { ...renamed, sessions: [{ ...session, chatTitle: 'Renamed' }] },
      ]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const isInContext = (): boolean => true;
    await act(async () => {
      root.render(
        <SummaryProbe
          isInContext={isInContext}
          onSummary={(summary) => summaries.push(summary)}
        />,
      );
      await Promise.resolve();
    });
    const first = summaries.at(-1);
    expect(first?.sessions.map((entry) => entry.title)).toEqual(['Chat']);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(summaries.at(-1)).toBe(first);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    const next = summaries.at(-1);
    expect(next).not.toBe(first);
    expect(next?.sessions.map((entry) => entry.title)).toEqual(['Renamed']);
    // Dismissal is keyed to the signature, which a rename leaves alone.
    expect(next?.signature).toBe(first?.signature);
  });

  it('summarizes ready and waiting providers within one pipeline separately', async () => {
    const group = chatGroup('ws-a');
    const list = jest.fn().mockResolvedValue([
      {
        ...group,
        sessions: [
          {
            kind: 'pipeline',
            executionId: 'mixed-exec',
            statusReasonIds: ['claude-limit', 'codex-limit'],
            provider: 'claude',
            pipelineName: 'Mixed run',
            detectedAt: 1,
            pausedStepCount: 2,
            modelLabels: [],
            otherBlockingReasonCount: 0,
          },
        ],
      },
    ]);
    const getExecution = jest.fn().mockResolvedValue({
      success: true,
      data: {
        status_reasons: ['claude', 'codex'].map((provider) => ({
          id: `${provider}-limit`,
          provider,
          kind: 'provider_usage_limit',
          account_scope: 'native',
          source: { job_id: 'j', step_id: provider, attempt: 0, iteration: 0 },
        })),
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: list },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { getExecution },
    });
    useObservabilityStore.setState({
      initialize: jest.fn().mockResolvedValue(undefined),
      usage: {
        updatedAt: '',
        providers: [
          {
            provider: 'codex',
            authState: 'authenticated',
            hasRemainingLimits: false,
            rateLimits: [
              {
                limitId: 'codex',
                secondary: {
                  usedPercent: 100,
                  resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
              },
            ],
          },
        ],
      },
    });
    await act(async () => {
      root.render(
        <SummaryProbe
          isInContext={() => true}
          onSummary={(summary) => summaries.push(summary)}
        />,
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(summaries.at(-1)?.readiness).toMatchObject({
      total: 2,
      readyCount: 1,
      waitingCount: 1,
      waitingProviders: ['codex'],
    });
    expect(getExecution).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rejected', true],
    ['missing', true],
    ['stale', true],
    ['stale', false],
  ] as const)(
    'isolates %s pipeline projection on Home (valid chat: %s)',
    async (failure, includeChat) => {
      const group = chatGroup('ws-a');
      const list = jest.fn().mockResolvedValue([
        {
          ...group,
          sessions: [
            ...(includeChat ? group.sessions : []),
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
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { listUsageLimitedIdleSessions: list },
      });
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: { getExecution },
      });
      useObservabilityStore.setState({
        initialize: jest.fn().mockResolvedValue(undefined),
        usage: { updatedAt: '', providers: [] },
      });
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={() => true}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(summaries.at(-1)?.count).toBe(includeChat ? 1 : 0);
      expect(summaries.at(-1)?.readiness).toMatchObject({
        readyCount: includeChat ? 1 : 0,
        waitingCount: 0,
      });
    },
  );

  it('scopes the summary to the current workspace context', async () => {
    const listUsageLimitedIdleSessions = jest.fn(() =>
      Promise.resolve([chatGroup('ws-a'), chatGroup('ws-b')]),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const render = async (
      isInContext: (workspaceId: string) => boolean,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={isInContext}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        await Promise.resolve();
      });
    };

    await render(() => true);
    expect(summaries.at(-1)?.count).toBe(2);

    await render((workspaceId) => workspaceId === 'ws-a');
    expect(summaries.at(-1)?.count).toBe(1);
    await render(() => true);
    expect(summaries.at(-1)?.count).toBe(2);
  });

  it('folds refresh requests made during a listing into one follow-up listing', async () => {
    const pending: Array<(groups: UsageLimitedSessionGroup[]) => void> = [];
    const listUsageLimitedIdleSessions = jest.fn(
      () =>
        new Promise<UsageLimitedSessionGroup[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const isInContext = (): boolean => true;

    await act(async () => {
      root.render(
        <SummaryProbe
          isInContext={isInContext}
          onSummary={(summary) => summaries.push(summary)}
        />,
      );
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.shift()?.([chatGroup('ws-a')]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending.shift()?.([chatGroup('ws-a'), chatGroup('ws-b')]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);
    expect(summaries.at(-1)?.count).toBe(2);
  });

  it('waits for a pending listing when the context changes, then lists once for the new context', async () => {
    const pending: Array<(groups: UsageLimitedSessionGroup[]) => void> = [];
    const listUsageLimitedIdleSessions = jest.fn(
      () =>
        new Promise<UsageLimitedSessionGroup[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const render = async (
      isInContext: (workspaceId: string) => boolean,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={isInContext}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        await Promise.resolve();
      });
    };

    await render(() => true);
    await render((workspaceId) => workspaceId === 'ws-a');
    await render((workspaceId) => workspaceId === 'ws-b');
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.shift()?.([chatGroup('ws-a'), chatGroup('ws-b')]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending.shift()?.([
        chatGroup('ws-a'),
        chatGroup('ws-b'),
        chatGroup('ws-c'),
      ]);
      await Promise.resolve();
    });
    expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);
    expect(summaries.at(-1)?.count).toBe(1);
  });

  describe('readiness', () => {
    const RESET_MS = Date.parse('2026-10-27T18:13:00.000Z');
    const codexBlocked = {
      updatedAt: '',
      providers: [
        {
          provider: 'codex' as const,
          authState: 'authenticated' as const,
          hasRemainingLimits: false,
          rateLimits: [
            {
              limitId: 'codex',
              secondary: {
                usedPercent: 100,
                resetsAt: RESET_MS,
                windowDurationMins: 7 * 24 * 60,
              },
            },
          ],
        },
      ],
    };
    const mixed = (): UsageLimitedSessionGroup[] => {
      const group = chatGroup('ws-a');
      const [first] = group.sessions;
      if (first?.kind !== 'chat') throw new Error('expected a chat');
      return [
        {
          ...group,
          sessions: [
            first,
            { ...first, chatId: 'codex-chat', provider: 'codex' },
          ],
        },
      ];
    };

    beforeEach(() => {
      jest.useFakeTimers({ now: Date.parse('2026-10-25T12:00:00.000Z') });
      useObservabilityStore.setState({
        usage: { updatedAt: '', providers: [] },
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('cleans readiness and listing timers while inactive and on unmount', async () => {
      const intervals = jest.spyOn(window, 'setInterval');
      const clears = jest.spyOn(window, 'clearInterval');
      const list = jest.fn().mockResolvedValue(mixed());
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { listUsageLimitedIdleSessions: list },
      });
      const isInContext = (): boolean => true;
      const render = async (active: boolean): Promise<void> => {
        await act(async () => {
          root.render(
            <SummaryProbe
              active={active}
              isInContext={isInContext}
              onSummary={(summary) => summaries.push(summary)}
            />,
          );
          await Promise.resolve();
        });
      };
      await render(true);
      expect(intervals).toHaveBeenCalledTimes(2);
      await render(false);
      for (const timer of intervals.mock.results)
        expect(clears).toHaveBeenCalledWith(timer.value);
      const count = list.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(list).toHaveBeenCalledTimes(count);
      await render(true);
      act(() => root.unmount());
      for (const timer of intervals.mock.results)
        expect(clears).toHaveBeenCalledWith(timer.value);
      intervals.mockRestore();
      clears.mockRestore();
    });

    it('recomputes on usage updates and the clock without listing again', async () => {
      const intervalSpy = jest.spyOn(window, 'setInterval');
      const listUsageLimitedIdleSessions = jest.fn(() =>
        Promise.resolve(mixed()),
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { listUsageLimitedIdleSessions },
      });
      const isInContext = (): boolean => true;
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={isInContext}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.readiness).toMatchObject({
        readyCount: 2,
        waitingCount: 0,
      });
      const readySignature = summaries.at(-1)?.signature;

      await act(async () => {
        useObservabilityStore.setState({ usage: codexBlocked });
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.readiness).toMatchObject({
        readyCount: 1,
        waitingCount: 1,
        waitingProviders: ['codex'],
      });
      const waitingSignature = summaries.at(-1)?.signature;
      expect(waitingSignature).not.toBe(readySignature);

      // Clock ticks recompute readiness but never list again; the signature
      // holds until the reset actually passes.
      listUsageLimitedIdleSessions.mockClear();
      jest.setSystemTime(RESET_MS - 60_000);
      await act(async () => {
        const clock = intervalSpy.mock.calls[1]?.[0];
        if (typeof clock !== 'function')
          throw new Error('missing readiness clock');
        clock();
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.signature).toBe(waitingSignature);
      jest.setSystemTime(RESET_MS + 1);
      await act(async () => {
        const clock = intervalSpy.mock.calls[1]?.[0];
        if (typeof clock !== 'function')
          throw new Error('missing readiness clock');
        clock();
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.readiness.waitingCount).toBe(0);
      expect(summaries.at(-1)?.signature).toBe(readySignature);
      expect(listUsageLimitedIdleSessions).not.toHaveBeenCalled();
      intervalSpy.mockRestore();
    });
  });

  describe('scheduled usage-limit resumes (CAN-4970)', () => {
    let changed: ((snapshot: AutomationsListResponse) => void) | undefined;
    const unsubscribe = jest.fn();

    function installApi(options: {
      groups?: UsageLimitedSessionGroup[];
      list: () => Promise<AutomationsListResponse>;
    }): {
      listUsageLimitedIdleSessions: jest.Mock;
      list: jest.Mock;
      onChanged: jest.Mock;
    } {
      const listUsageLimitedIdleSessions = jest.fn(() =>
        Promise.resolve(
          options.groups ?? [chatGroup('ws-a'), chatGroup('ws-b')],
        ),
      );
      const list = jest.fn(options.list);
      const onChanged = jest.fn(
        (listener: (snapshot: AutomationsListResponse) => void) => {
          changed = listener;
          return unsubscribe;
        },
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          listUsageLimitedIdleSessions,
          automations: {
            list,
            onChanged,
          },
        },
      });
      return { listUsageLimitedIdleSessions, list, onChanged };
    }

    const isInContext = (): boolean => true;
    async function renderProbe(): Promise<void> {
      await act(async () => {
        root.render(
          <SummaryProbe
            isInContext={isInContext}
            onSummary={(summary) => summaries.push(summary)}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    beforeEach(() => {
      changed = undefined;
      unsubscribe.mockClear();
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('hydrates automations on a cold Home and excludes scheduled chats', async () => {
      const { list } = installApi({
        list: () => Promise.resolve(snapshotOf([resumeFor('ws-a')])),
      });
      await renderProbe();
      expect(list).toHaveBeenCalledTimes(1);
      expect(summaries.at(-1)?.count).toBe(1);
      expect(summaries.at(-1)?.signature).toBe('chat:ws-b/wt/ws-b-chat');
    });

    it('reports nothing actionable until the automations snapshot loads', async () => {
      let resolveList: (snapshot: AutomationsListResponse) => void = () =>
        undefined;
      installApi({
        list: () =>
          new Promise<AutomationsListResponse>((resolve) => {
            resolveList = resolve;
          }),
      });
      await renderProbe();
      expect(summaries.every((summary) => summary.count === 0)).toBe(true);

      await act(async () => {
        resolveList(snapshotOf([resumeFor('ws-a')]));
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.count).toBe(1);
      expect(summaries.some((summary) => summary.count === 2)).toBe(false);
    });

    it('treats a failed automations load as unresolved and recovers on refresh', async () => {
      let fail = true;
      const { list } = installApi({
        list: () =>
          fail
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(snapshotOf([])),
      });
      await renderProbe();
      expect(summaries.at(-1)?.count).toBe(0);

      fail = false;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(list).toHaveBeenCalledTimes(2);
      expect(summaries.at(-1)?.count).toBe(2);
    });

    it('hides stale eligibility after a later automation load fails and retries on focus', async () => {
      const { list } = installApi({
        list: () => Promise.resolve(snapshotOf([])),
      });
      await renderProbe();
      expect(summaries.at(-1)?.count).toBe(2);

      list.mockRejectedValueOnce(new Error('offline'));
      await act(async () => useAutomationsStore.getState().hydrate());
      expect(useAutomationsStore.getState().hydrated).toBe(true);
      expect(summaries.at(-1)?.count).toBe(0);

      list.mockResolvedValueOnce(snapshotOf([resumeFor('ws-a')]));
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(list).toHaveBeenCalledTimes(3);
      expect(summaries.at(-1)?.signature).toBe('chat:ws-b/wt/ws-b-chat');
    });

    it('withholds stale eligibility while a later automation load is pending', async () => {
      const { list } = installApi({
        list: () => Promise.resolve(snapshotOf([])),
      });
      await renderProbe();
      let resolveList: (snapshot: AutomationsListResponse) => void = () =>
        undefined;
      list.mockImplementationOnce(
        () =>
          new Promise<AutomationsListResponse>((resolve) => {
            resolveList = resolve;
          }),
      );
      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = useAutomationsStore.getState().hydrate();
      });
      expect(summaries.at(-1)?.count).toBe(0);
      await act(async () => {
        resolveList(snapshotOf([resumeFor('ws-a')]));
        await pending;
      });
      expect(summaries.at(-1)?.count).toBe(1);
    });

    it('follows automation changes without another listing', async () => {
      let current: ScheduledActivity[] = [];
      const { listUsageLimitedIdleSessions } = installApi({
        list: () => Promise.resolve(snapshotOf(current)),
      });
      // The broadcast either carries the snapshot or triggers a reload.
      const emit = async (activities: ScheduledActivity[]): Promise<void> => {
        current = activities;
        await act(async () => {
          changed?.(snapshotOf(activities));
          await Promise.resolve();
          await Promise.resolve();
        });
      };
      await renderProbe();
      expect(summaries.at(-1)?.count).toBe(2);

      const duplicate = resumeFor('ws-a', undefined, 'resume-ws-a-2');
      await emit([resumeFor('ws-a'), duplicate]);
      expect(summaries.at(-1)?.count).toBe(1);

      await emit([duplicate]);
      expect(summaries.at(-1)?.count).toBe(1);

      await emit([{ ...duplicate, enabled: false }]);
      expect(summaries.at(-1)?.count).toBe(2);
      // An unchanged interrupted set keeps the same summary object.
      const restored = summaries.at(-1);
      await emit([]);
      expect(summaries.at(-1)).toBe(restored);
      expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(1);
    });

    it('restores a chat on the next refresh after its scheduled time passes', async () => {
      installApi({
        list: () =>
          Promise.resolve(
            snapshotOf([resumeFor('ws-a', '2026-10-25T12:00:10.000Z')]),
          ),
      });
      await renderProbe();
      expect(summaries.at(-1)?.count).toBe(1);

      jest.spyOn(Date, 'now').mockReturnValue(NOW + 10_000);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.count).toBe(2);
    });

    it('hides sessions while the automations store resets for a new context', async () => {
      installApi({ list: () => Promise.resolve(snapshotOf([])) });
      await renderProbe();
      expect(summaries.at(-1)?.count).toBe(2);

      act(() =>
        useAutomationsStore.setState({ activities: [], hydrated: false }),
      );
      expect(summaries.at(-1)?.count).toBe(0);
    });

    it('invalidates a completed listing until the new context listing resolves', async () => {
      const { listUsageLimitedIdleSessions } = installApi({
        list: () => Promise.resolve(snapshotOf([])),
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
      await renderProbe();
      expect(summaries.at(-1)?.count).toBe(2);
      listUsageLimitedIdleSessions.mockImplementation(
        () => new Promise(() => undefined),
      );
      await act(async () => {
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'organization', organizationId: 'org-b' },
            revision: 2,
            organizations: [],
          },
        });
        await Promise.resolve();
      });
      expect(summaries.at(-1)?.count).toBe(0);
    });

    it('hydrates once for concurrent consumers and shares one subscription until the last unmounts', async () => {
      const { list, onChanged } = installApi({
        list: () => Promise.resolve(snapshotOf([])),
      });
      const render = (consumers: number): void =>
        root.render(
          <>
            {Array.from({ length: consumers }, (_, index) => (
              <SummaryProbe
                key={index}
                isInContext={isInContext}
                onSummary={(summary) => summaries.push(summary)}
              />
            ))}
          </>,
        );
      await act(async () => {
        render(2);
        await Promise.resolve();
      });
      expect(list).toHaveBeenCalledTimes(1);
      expect(onChanged).toHaveBeenCalledTimes(1);
      act(() => render(1));
      expect(unsubscribe).not.toHaveBeenCalled();
      act(() => root.unmount());
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      root = createRoot(document.createElement('div'));
    });

    it('detaches the automations subscription on unmount', async () => {
      installApi({ list: () => Promise.resolve(snapshotOf([])) });
      await renderProbe();
      expect(unsubscribe).not.toHaveBeenCalled();
      act(() => root.unmount());
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      root = createRoot(document.createElement('div'));
    });
  });
});
