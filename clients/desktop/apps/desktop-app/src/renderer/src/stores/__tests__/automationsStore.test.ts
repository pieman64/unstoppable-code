/**
 * @jest-environment jsdom
 */
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import type {
  AutomationCreateRequest,
  AutomationMutationResponse,
  AutomationsListResponse,
  AutomationUpdateRequest,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';

function makeActivity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: overrides.id ?? 'activity-1',
    name: overrides.name ?? 'Daily digest',
    enabled: overrides.enabled ?? true,
    schedule: overrides.schedule ?? {
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'local',
    },
    action: overrides.action ?? {
      type: 'app_advisor_prompt',
      prompt: 'hello',
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    failureCount: overrides.failureCount ?? 0,
    ...(overrides.lastRunAt ? { lastRunAt: overrides.lastRunAt } : {}),
    ...(overrides.nextRunAt ? { nextRunAt: overrides.nextRunAt } : {}),
    ...(overrides.lastResult ? { lastResult: overrides.lastResult } : {}),
  };
}

function makeRun(
  overrides: Partial<ScheduledActivityRun> = {},
): ScheduledActivityRun {
  return {
    id: overrides.id ?? 'run-1',
    activityId: overrides.activityId ?? 'activity-1',
    activityName: overrides.activityName ?? 'Daily digest',
    scheduledFor: overrides.scheduledFor ?? new Date().toISOString(),
    manual: overrides.manual ?? false,
    status: overrides.status ?? 'success',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

const listMock = jest.fn<Promise<AutomationsListResponse>, []>();
const createMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [AutomationCreateRequest]
>();
const updateMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [AutomationUpdateRequest]
>();
const deleteMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [{ id: string }]
>();
const runNowMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [{ id: string }]
>();
const cancelRunMock = jest.fn<
  Promise<AutomationMutationResponse>,
  [{ runId: string }]
>();
let onChangedListener: ((snapshot: AutomationsListResponse) => void) | null =
  null;
const onChangedMock = jest.fn(
  (cb: (snapshot: AutomationsListResponse) => void): (() => void) => {
    onChangedListener = cb;
    return (): void => {
      onChangedListener = null;
    };
  },
);

beforeEach(() => {
  listMock.mockReset();
  // Organization projects default on when LaunchDarkly is not configured;
  // this suite covers the legacy (context-free) paths.
  const flagSnapshot = getDefaultFeatureFlagSnapshot();
  flagSnapshot.values['canopy-shared-org-projects-enabled'] = false;
  useFeatureFlagsStore.setState({ snapshot: flagSnapshot });
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  runNowMock.mockReset();
  cancelRunMock.mockReset();
  onChangedMock.mockClear();
  onChangedListener = null;
  listMock.mockResolvedValue({ activities: [], recentRuns: [] });
  createMock.mockResolvedValue({ ok: true, activity: makeActivity() });
  updateMock.mockResolvedValue({ ok: true, activity: makeActivity() });
  deleteMock.mockResolvedValue({ ok: true });
  runNowMock.mockResolvedValue({ ok: true, run: makeRun() });
  cancelRunMock.mockResolvedValue({ ok: true, run: makeRun() });

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      automations: {
        list: listMock,
        create: createMock,
        update: updateMock,
        delete: deleteMock,
        runNow: runNowMock,
        cancelRun: cancelRunMock,
        onChanged: onChangedMock,
      },
    },
  });

  useAutomationsStore.setState({
    activities: [],
    recentRuns: [],
    loading: false,
    hydrated: false,
    error: null,
    mutationError: null,
  });
});

describe('automationsStore', () => {
  it('joins an in-flight refresh and lets both callers await its actual completion', async () => {
    let finish: (snapshot: AutomationsListResponse) => void = () => {};
    listMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = useAutomationsStore.getState().hydrate();
    const second = useAutomationsStore
      .getState()
      .hydrate({ joinInFlight: true });
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const calls = listMock.mock.calls.length;
    finish({ activities: [makeActivity()], recentRuns: [] });
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(settled).toBe(true);
    expect(useAutomationsStore.getState().activities).toHaveLength(1);
    listMock.mockResolvedValue({ activities: [], recentRuns: [] });
    await useAutomationsStore.getState().hydrate();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'waits for the replacement snapshot when a reveal refresh is superseded (already pending: %s)',
    async (alreadyPending) => {
      useAutomationsStore.setState({ hydrated: true });
      let finishFirst: (snapshot: AutomationsListResponse) => void = () => {};
      let finishReplacement: (
        snapshot: AutomationsListResponse,
      ) => void = () => {};
      listMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
      );
      listMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finishReplacement = resolve;
        }),
      );
      const first = alreadyPending
        ? useAutomationsStore.getState().hydrate()
        : null;
      const revealRefresh = useAutomationsStore
        .getState()
        .hydrate({ joinInFlight: true });
      let revealSettled = false;
      void revealRefresh.then(() => {
        revealSettled = true;
      });
      const replacement = useAutomationsStore.getState().hydrate();
      finishFirst({ activities: [], recentRuns: [] });
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
      const settledBeforeReplacement = revealSettled;
      const installed = makeActivity({ id: 'installed-after-replacement' });
      finishReplacement({ activities: [installed], recentRuns: [] });
      await Promise.all([first, revealRefresh, replacement]);
      expect(settledBeforeReplacement).toBe(false);
      expect(revealSettled).toBe(true);
      expect(listMock).toHaveBeenCalledTimes(2);
      expect(useAutomationsStore.getState().activities).toEqual([installed]);
      expect(useAutomationsStore.getState().loading).toBe(false);
    },
  );

  it('hydrate replaces activities and recent runs from window.api.automations.list', async () => {
    const activity = makeActivity({ id: 'a' });
    const run = makeRun({ id: 'r' });
    listMock.mockResolvedValueOnce({
      activities: [activity],
      recentRuns: [run],
    });

    await useAutomationsStore.getState().hydrate();

    const state = useAutomationsStore.getState();
    expect(state.activities).toEqual([activity]);
    expect(state.recentRuns).toEqual([run]);
    expect(state.hydrated).toBe(true);
    expect(state.error).toBeNull();
  });

  it('does not overwrite a newer broadcast with the older reveal refresh response', async () => {
    let finish: (snapshot: AutomationsListResponse) => void = () => {};
    listMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const unsubscribe = useAutomationsStore.getState().subscribeBridge();
    const refresh = useAutomationsStore
      .getState()
      .hydrate({ joinInFlight: true });
    const installed = makeActivity({ id: 'fresh' });
    onChangedListener?.({ activities: [installed], recentRuns: [] });
    finish({ activities: [], recentRuns: [] });
    await refresh;
    unsubscribe();
    expect(useAutomationsStore.getState().activities).toEqual([installed]);
  });

  it('keeps a later ordinary refresh independent and does not publish its older predecessor', async () => {
    let finish: (snapshot: AutomationsListResponse) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = useAutomationsStore.getState().hydrate();
    const installed = makeActivity({ id: 'fresh' });
    listMock.mockResolvedValueOnce({ activities: [installed], recentRuns: [] });
    await useAutomationsStore.getState().hydrate();
    finish({ activities: [], recentRuns: [] });
    await first;
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(useAutomationsStore.getState().activities).toEqual([installed]);
  });

  it('captures an error string when list rejects', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'));

    await useAutomationsStore.getState().hydrate();

    expect(useAutomationsStore.getState().error).toBe('boom');
  });

  it('subscribeBridge wires onChanged so broadcasts replace local state', () => {
    const off = useAutomationsStore.getState().subscribeBridge();
    expect(onChangedMock).toHaveBeenCalledTimes(1);

    onChangedListener?.({
      activities: [makeActivity({ id: 'live' })],
      recentRuns: [],
    });
    expect(useAutomationsStore.getState().activities[0]?.id).toBe('live');
    expect(useAutomationsStore.getState().hydrated).toBe(true);

    off();
    expect(onChangedListener).toBeNull();
  });

  it('createActivity proxies the request and clears mutationError on success', async () => {
    useAutomationsStore.setState({ mutationError: 'previous' });
    const created = makeActivity({ id: 'created' });
    createMock.mockResolvedValueOnce({ ok: true, activity: created });

    const result = await useAutomationsStore.getState().createActivity({
      name: 'New',
      schedule: { kind: 'cron', expression: '* * * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'hi' },
    });

    expect(result).toEqual({ ok: true, activity: created });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(useAutomationsStore.getState().mutationError).toBeNull();
  });

  it('updateActivity records mutationError on { ok: false }', async () => {
    updateMock.mockResolvedValueOnce({ ok: false, error: 'nope' });

    const result = await useAutomationsStore.getState().updateActivity({
      id: 'a',
      enabled: false,
    });

    expect(result).toEqual({ ok: false, error: 'nope' });
    expect(useAutomationsStore.getState().mutationError).toBe('nope');
  });

  it('deleteActivity forwards the id under { id }', async () => {
    await useAutomationsStore.getState().deleteActivity('to-delete');
    expect(deleteMock).toHaveBeenCalledWith({ id: 'to-delete' });
  });

  it('runNow forwards the id under { id } and returns a run', async () => {
    const run = makeRun({ id: 'now' });
    runNowMock.mockResolvedValueOnce({ ok: true, run });
    const result = await useAutomationsStore.getState().runNow('activity-1');
    expect(runNowMock).toHaveBeenCalledWith({ id: 'activity-1' });
    expect(result).toEqual({ ok: true, run });
  });

  it('cancelRun forwards the run id under { runId }', async () => {
    await useAutomationsStore.getState().cancelRun('run-to-cancel');
    expect(cancelRunMock).toHaveBeenCalledWith({ runId: 'run-to-cancel' });
  });

  it('records mutationError when the IPC throws', async () => {
    createMock.mockRejectedValueOnce(new Error('explode'));
    const result = await useAutomationsStore.getState().createActivity({
      name: 'New',
      schedule: { kind: 'cron', expression: '* * * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'hi' },
    });
    expect(result).toEqual({ ok: false, error: 'explode' });
    expect(useAutomationsStore.getState().mutationError).toBe('explode');
  });
});
