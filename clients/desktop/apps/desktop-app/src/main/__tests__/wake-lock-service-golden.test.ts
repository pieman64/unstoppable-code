import {
  resetWakeLockDiagWarningForTests,
  WakeLockService,
  type PowerSaveBlockerLike,
} from '../power/wake-lock-service';
import type { AppDiagnosticRecord } from '../observability/service';

// Golden capture (CAN-5066): the exact records, broadcasts and blocker calls
// of the in-process wake lock, pinned before its policy moved to core.

interface Blocker extends PowerSaveBlockerLike {
  calls: string[];
  failNextStart: boolean;
}

function createBlocker(): Blocker {
  const started = new Set<number>();
  let nextId = 1;
  const blocker: Blocker = {
    calls: [],
    failNextStart: false,
    start: (type) => {
      blocker.calls.push(`start:${type}`);
      if (blocker.failNextStart) {
        blocker.failNextStart = false;
        throw new Error('inhibitor unavailable');
      }
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop: (id) => {
      blocker.calls.push(`stop:${id}`);
      started.delete(id);
    },
    isStarted: (id) => started.has(id),
  };
  return blocker;
}

function capture(blocker: Blocker): {
  service: WakeLockService;
  records: Omit<AppDiagnosticRecord, 'timestamp'>[];
  states: unknown[];
} {
  const records: Omit<AppDiagnosticRecord, 'timestamp'>[] = [];
  const states: unknown[] = [];
  const service = new WakeLockService({
    platform: 'darwin',
    powerSaveBlocker: blocker,
    recordDiagnostic: ({ timestamp, ...record }): void => {
      expect(typeof timestamp).toBe('string');
      records.push(record);
    },
    now: (): number => 5,
  });
  service.setBroadcastHandlers({
    stateChanged: (state): void => {
      states.push(state);
    },
  });
  return { service, records, states };
}

describe('WakeLockService golden behavior', () => {
  let emitWarningSpy: jest.SpyInstance;

  beforeEach(() => {
    resetWakeLockDiagWarningForTests();
    emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    emitWarningSpy.mockRestore();
  });

  it('records a full holder lifecycle in order', () => {
    const blocker = createBlocker();
    const { service, records, states } = capture(blocker);

    service.acquire('chat:w/t/c', 'agent chat turn');
    service.acquire('pipeline:exec-1', 'pipeline execution');
    service.release('chat:w/t/c');
    service.setEnabled(false);
    service.setEnabled(true);
    service.release('pipeline:exec-1');
    service.acquire('delegation:w/t/c', 'delegated task');
    service.shutdown();

    expect(blocker.calls).toEqual([
      'start:prevent-app-suspension',
      'stop:1',
      'start:prevent-app-suspension',
      'stop:2',
      'start:prevent-app-suspension',
      'stop:3',
    ]);
    expect(records).toEqual([
      {
        version: 1,
        kind: 'wake_lock_acquired',
        holderKey: 'chat#1',
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_started',
        blockerId: 1,
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_acquired',
        holderKey: 'pipeline#2',
        holderCount: 2,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_released',
        holderKey: 'chat#1',
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_stopped',
        blockerId: 1,
        holderCount: 1,
        enabled: false,
      },
      {
        version: 1,
        kind: 'wake_lock_started',
        blockerId: 2,
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_released',
        holderKey: 'pipeline#2',
        holderCount: 0,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_stopped',
        blockerId: 2,
        holderCount: 0,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_acquired',
        holderKey: 'delegation#3',
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_started',
        blockerId: 3,
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_stopped',
        blockerId: 3,
        holderCount: 1,
        enabled: true,
      },
    ]);
    expect(states).toEqual([
      { active: false, enabled: true, holderCount: 0 },
      { active: true, enabled: true, holderCount: 1 },
      { active: true, enabled: true, holderCount: 2 },
      { active: true, enabled: true, holderCount: 1 },
      { active: false, enabled: false, holderCount: 1 },
      { active: true, enabled: true, holderCount: 1 },
      { active: false, enabled: true, holderCount: 0 },
      { active: true, enabled: true, holderCount: 1 },
      { active: false, enabled: true, holderCount: 0 },
    ]);
    expect(service.getHolders()).toEqual([]);
  });

  it('retries a failed start on a same-key re-acquire and warns once per error', () => {
    const blocker = createBlocker();
    blocker.failNextStart = true;
    const { service, records, states } = capture(blocker);

    service.acquire('chat:a', 'agent chat turn');
    service.acquire('chat:a', 'agent chat turn');

    expect(blocker.calls).toEqual([
      'start:prevent-app-suspension',
      'start:prevent-app-suspension',
    ]);
    expect(records).toEqual([
      {
        version: 1,
        kind: 'wake_lock_acquired',
        holderKey: 'chat#1',
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_error',
        reason: 'inhibitor unavailable',
        holderCount: 1,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_started',
        blockerId: 1,
        holderCount: 1,
        enabled: true,
      },
    ]);
    expect(states).toEqual([
      { active: false, enabled: true, holderCount: 0 },
      { active: false, enabled: true, holderCount: 1 },
      { active: true, enabled: true, holderCount: 1 },
    ]);
    expect(emitWarningSpy).toHaveBeenCalledTimes(1);
    expect(emitWarningSpy).toHaveBeenCalledWith('inhibitor unavailable', {
      type: 'CanopyWarning',
      code: 'CANOPY_WAKE_LOCK_ERROR',
    });
  });

  it('restarts a blocker Electron stopped on its own at the next holder change', () => {
    const blocker = createBlocker();
    const { service, records } = capture(blocker);

    service.acquire('chat:a', 'agent chat turn');
    blocker.stop(1);
    blocker.calls.length = 0;
    service.acquire('chat:b', 'agent chat turn');

    expect(blocker.calls).toEqual(['start:prevent-app-suspension']);
    expect(records.slice(2)).toEqual([
      {
        version: 1,
        kind: 'wake_lock_acquired',
        holderKey: 'chat#2',
        holderCount: 2,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_stopped',
        blockerId: 1,
        holderCount: 2,
        enabled: true,
      },
      {
        version: 1,
        kind: 'wake_lock_started',
        blockerId: 2,
        holderCount: 2,
        enabled: true,
      },
    ]);
    expect(service.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 2,
    });
  });
});
