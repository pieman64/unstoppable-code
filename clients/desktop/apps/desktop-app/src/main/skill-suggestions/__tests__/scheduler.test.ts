import {
  SkillSuggestionScheduler,
  type SchedulerRunContext,
} from '../scheduler';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

describe('skill suggestion scheduler', () => {
  let busy: boolean;
  let scanEnabled: boolean;
  let activity: (() => void) | null;
  let runs: SchedulerRunContext[];
  let release: (() => void) | null;
  let scheduler: SkillSuggestionScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    busy = false;
    scanEnabled = true;
    activity = null;
    runs = [];
    release = null;
    scheduler = new SkillSuggestionScheduler({
      isScanEnabled: (): boolean => scanEnabled,
      hasBusySession: (): boolean => busy,
      subscribeActivity: (listener): (() => void) => {
        activity = listener;
        return () => {
          activity = null;
        };
      },
      runPass: (context): Promise<void> => {
        runs.push(context);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      debounceMs: 1000,
    });
    scheduler.start();
  });
  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });

  it('runs only after the idle debounce, never at startup', () => {
    expect(runs).toHaveLength(0);
    activity?.();
    jest.advanceTimersByTime(999);
    expect(runs).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
  });

  it('cancels a run and the debounce when a session becomes busy', () => {
    activity?.();
    jest.advanceTimersByTime(1000);
    expect(runs[0]?.isCancelled()).toBe(false);
    busy = true;
    activity?.();
    expect(runs[0]?.isCancelled()).toBe(true);
    expect(runs[0]?.slicer.stopped).toBe(true);
  });

  it('re-arms after a cancelled run finishes once sessions are idle', async () => {
    activity?.();
    jest.advanceTimersByTime(1000);
    busy = true;
    activity?.();
    // Idle again while the cancelled run is still finishing.
    busy = false;
    activity?.();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    expect(runs).toHaveLength(2);
  });

  it('does nothing while the scan gate is closed, as in E2E builds', () => {
    scanEnabled = false;
    activity?.();
    jest.advanceTimersByTime(5000);
    expect(runs).toHaveLength(0);
  });

  it('stops in-flight work when the gate closes', async () => {
    activity?.();
    jest.advanceTimersByTime(1000);
    scanEnabled = false;
    expect(runs[0]?.isCancelled()).toBe(true);
    scheduler.cancelInFlight();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    scanEnabled = true;
    activity?.();
    jest.advanceTimersByTime(1000);
    expect(runs).toHaveLength(2);
  });
});
