/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AutomationMutationResponse,
  ScheduledActivity,
  UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import {
  deleteOwnedInterruptedResume,
  findScheduledInterruptedResumeActivity,
  matchesInterruptedResumeActivity,
  useScheduleInterruptedResume,
} from '../useScheduleInterruptedResume';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const FUTURE = '2026-10-27T12:00:00.000Z';
const pipeline: UsageLimitedSessionItem = {
  kind: 'pipeline',
  executionId: 'exec',
  statusReasonIds: ['r1', 'r2'],
  provider: 'codex',
  pipelineName: 'Release',
  detectedAt: 1,
  pausedStepCount: 2,
  modelLabels: [],
  otherBlockingReasonCount: 0,
};
function activity(): ScheduledActivity {
  return {
    version: 1,
    id: 'resume',
    name: 'Resume',
    enabled: true,
    failureCount: 0,
    schedule: { kind: 'one_time', runAt: FUTURE, timezone: 'local' },
    action: {
      type: 'pipeline_execution_resume',
      executionId: 'exec',
      statusReasonIds: ['r2', 'r1'],
      provider: 'codex',
      purpose: 'usage_limit_resume',
      pipelineName: 'Release',
    },
    nextRunAt: FUTURE,
    createdAt: '',
    updatedAt: '',
  };
}

describe('matchesInterruptedResumeActivity', () => {
  it('requires the complete pipeline target, independent of reason order', () => {
    const candidate = activity();
    expect(matchesInterruptedResumeActivity(candidate, pipeline, NOW)).toBe(
      true,
    );
    if (candidate.action.type !== 'pipeline_execution_resume')
      throw new Error('expected pipeline');
    candidate.action.statusReasonIds = ['r1', 'r1'];
    expect(matchesInterruptedResumeActivity(candidate, pipeline, NOW)).toBe(
      false,
    );
    candidate.action.statusReasonIds = ['r1'];
    expect(matchesInterruptedResumeActivity(candidate, pipeline, NOW)).toBe(
      false,
    );
  });
  it('ignores recurring and completed activities even with a stale future prediction', () => {
    const candidate = activity();
    expect(
      matchesInterruptedResumeActivity(
        {
          ...candidate,
          schedule: {
            kind: 'cron',
            expression: '0 12 * * *',
            timezone: 'local',
          },
        },
        pipeline,
        NOW,
      ),
    ).toBe(false);
    expect(
      matchesInterruptedResumeActivity(
        {
          ...candidate,
          lastResult: {
            status: 'success',
            completedAt: new Date(NOW).toISOString(),
          },
        },
        pipeline,
        NOW,
      ),
    ).toBe(false);
  });
  it('ignores disabled, expired, invalid, and unrelated targets', () => {
    const candidate = activity();
    for (const value of [
      { ...candidate, enabled: false },
      { ...candidate, nextRunAt: new Date(NOW).toISOString() },
      { ...candidate, nextRunAt: 'bad' },
    ])
      expect(matchesInterruptedResumeActivity(value, pipeline, NOW)).toBe(
        false,
      );
    expect(
      matchesInterruptedResumeActivity(
        candidate,
        { ...pipeline, executionId: 'other' },
        NOW,
      ),
    ).toBe(false);
    expect(
      matchesInterruptedResumeActivity(
        candidate,
        { ...pipeline, provider: 'claude' },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('findScheduledInterruptedResumeActivity', () => {
  it('returns the first eligible matching activity', () => {
    const first = { ...activity(), id: 'first' };
    const second = { ...activity(), id: 'second' };
    expect(
      findScheduledInterruptedResumeActivity(
        [{ ...first, id: 'disabled', enabled: false }, first, second],
        pipeline,
        NOW,
      )?.id,
    ).toBe('first');
    expect(
      findScheduledInterruptedResumeActivity([first], null, NOW),
    ).toBeNull();
  });
});

describe('deleteOwnedInterruptedResume', () => {
  const deleteActivity = jest.fn();
  const realNow = Date.now;

  beforeEach(() => {
    Date.now = (): number => NOW;
    deleteActivity.mockReset().mockResolvedValue({ ok: true });
    useAutomationsStore.setState({ activities: [], deleteActivity });
  });

  afterEach(() => {
    Date.now = realNow;
  });

  it('deletes only the owned activity, never another match', async () => {
    const owned = activity();
    const other = { ...activity(), id: 'other' };
    useAutomationsStore.setState({ activities: [other, owned] });
    await expect(
      deleteOwnedInterruptedResume({ activity: owned, target: pipeline }),
    ).resolves.toEqual({ kind: 'removed' });
    expect(deleteActivity).toHaveBeenCalledTimes(1);
    expect(deleteActivity).toHaveBeenCalledWith('resume');
  });

  it.each([
    ['missing', (): ScheduledActivity[] => [{ ...activity(), id: 'other' }]],
    [
      'fired',
      (): ScheduledActivity[] => [
        {
          ...activity(),
          lastResult: {
            status: 'success',
            completedAt: new Date(NOW).toISOString(),
          },
        },
      ],
    ],
    [
      'retargeted',
      (): ScheduledActivity[] => [
        {
          ...activity(),
          action: {
            type: 'pipeline_execution_resume',
            executionId: 'other',
            pipelineName: 'Other pipeline',
            statusReasonIds: ['r1', 'r2'],
            provider: 'codex',
            purpose: 'usage_limit_resume',
          },
        },
      ],
    ],
  ])('deletes nothing when the owned activity is %s', async (_, current) => {
    useAutomationsStore.setState({ activities: current() });
    await expect(
      deleteOwnedInterruptedResume({ activity: activity(), target: pipeline }),
    ).resolves.toEqual({ kind: 'missing' });
    expect(deleteActivity).not.toHaveBeenCalled();
  });

  it('deletes an owned activity the store has not listed yet', async () => {
    await expect(
      deleteOwnedInterruptedResume(
        { activity: activity(), target: pipeline },
        { awaitingListing: true },
      ),
    ).resolves.toEqual({ kind: 'removed' });
    expect(deleteActivity).toHaveBeenCalledWith('resume');
  });

  it('never deletes an unlisted activity whose snapshot is no longer pending', async () => {
    await expect(
      deleteOwnedInterruptedResume(
        { activity: { ...activity(), enabled: false }, target: pipeline },
        { awaitingListing: true },
      ),
    ).resolves.toEqual({ kind: 'missing' });
    expect(deleteActivity).not.toHaveBeenCalled();
  });

  it('reports the response error, or the default copy without one', async () => {
    useAutomationsStore.setState({ activities: [activity()] });
    deleteActivity.mockResolvedValueOnce({ ok: false, error: 'Locked' });
    await expect(
      deleteOwnedInterruptedResume({ activity: activity(), target: pipeline }),
    ).resolves.toEqual({ kind: 'failed', error: 'Locked' });
    deleteActivity.mockResolvedValueOnce({ ok: false, error: '' });
    await expect(
      deleteOwnedInterruptedResume({ activity: activity(), target: pipeline }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'Couldn’t undo this scheduled resume. Try again.',
    });
  });
});

describe('schedule and Undo share an in-flight guard', () => {
  it.each(['schedule', 'undo'] as const)(
    'returns busy for duplicate and conflicting calls during %s without changing the active state',
    async (operation) => {
      jest.useFakeTimers({ now: NOW });
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const session: UsageLimitedSessionItem = {
        kind: 'chat',
        projectId: 'ws',
        worktreeId: 'wt',
        worktreeName: 'Worktree',
        chatId: 'chat',
        provider: 'codex',
        chatTitle: 'Chat',
        detectedAt: 1,
      };
      const owned = {
        activity: {
          ...activity(),
          action: {
            type: 'worktree_session_prompt' as const,
            workspaceId: 'ws',
            worktreeId: 'wt',
            chatId: 'chat',
            prompt: 'Continue',
            purpose: 'usage_limit_resume' as const,
          },
        },
        target: session,
      };
      let respond: (response: AutomationMutationResponse) => void = () =>
        undefined;
      const pending = (): Promise<AutomationMutationResponse> =>
        new Promise((resolve) => {
          respond = resolve;
        });
      const createActivity = jest.fn(pending);
      const deleteActivity = jest.fn(pending);
      useAutomationsStore.setState({
        activities: operation === 'undo' ? [owned.activity] : [],
        hydrate: () => Promise.resolve(),
        createActivity,
        deleteActivity,
      });
      useObservabilityStore.setState({
        refreshProviderUsageSnapshot: () =>
          Promise.resolve({
            updatedAt: '',
            providers: [
              {
                provider: 'codex',
                authState: 'authenticated',
                hasRemainingLimits: false,
                rateLimits: [
                  {
                    limitId: 'codex',
                    secondary: { usedPercent: 100, resetsAt: FUTURE },
                  },
                ],
              },
            ],
          }),
      });
      let current: ReturnType<typeof useScheduleInterruptedResume> | undefined;
      function Probe(): null {
        current = useScheduleInterruptedResume(false, 1, () => '', []);
        return null;
      }
      function hook(): ReturnType<typeof useScheduleInterruptedResume> {
        if (!current) throw new Error('Hook did not mount');
        return current;
      }
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      };
      try {
        await act(async () => {
          root.render(createElement(Probe));
          await flush();
        });
        await act(async () => {
          void (operation === 'schedule'
            ? hook().schedule(session)
            : hook().unschedule(session, owned));
          await flush();
        });
        expect(hook().isBusy(session)).toBe(true);
        expect(Array.from(hook().operations.values())).toEqual([operation]);
        await act(async () => {
          await expect(hook().schedule(session)).resolves.toEqual({
            kind: 'busy',
          });
          await expect(hook().unschedule(session, owned)).resolves.toEqual({
            kind: 'busy',
          });
          await flush();
        });
        expect(createActivity).toHaveBeenCalledTimes(
          operation === 'schedule' ? 1 : 0,
        );
        expect(deleteActivity).toHaveBeenCalledTimes(
          operation === 'undo' ? 1 : 0,
        );
        expect(Array.from(hook().operations.values())).toEqual([operation]);
        expect(hook().errors).toEqual({});
        await act(async () => {
          respond({ ok: false, error: 'Active failure' });
          await flush();
        });
        expect(hook().isBusy(session)).toBe(false);
        expect(hook().operations.size).toBe(0);
        expect(Object.values(hook().errors)).toEqual(['Active failure']);
      } finally {
        act(() => root.unmount());
        container.remove();
        jest.useRealTimers();
      }
    },
  );
});
