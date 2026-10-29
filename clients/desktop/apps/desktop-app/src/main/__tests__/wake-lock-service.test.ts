import {
  resetWakeLockDiagWarningForTests,
  WakeLockService,
  type PowerSaveBlockerLike,
} from '../power/wake-lock-service';
import type { AppDiagnosticRecord } from '../observability/service';

function createPowerSaveBlocker(): PowerSaveBlockerLike & {
  start: jest.Mock<number, ['prevent-app-suspension']>;
  stop: jest.Mock<void, [number]>;
  isStarted: jest.Mock<boolean, [number]>;
  startedIds: Set<number>;
} {
  const startedIds = new Set<number>();
  let nextId = 1;
  const blocker = {
    startedIds,
    start: jest.fn(() => {
      const id = nextId;
      nextId += 1;
      startedIds.add(id);
      return id;
    }),
    stop: jest.fn((id: number) => {
      startedIds.delete(id);
    }),
    isStarted: jest.fn((id: number) => startedIds.has(id)),
  };
  return blocker;
}

const platforms: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

describe.each(platforms)('WakeLockService on %s', (platform) => {
  let emitWarningSpy: jest.SpyInstance;
  let diagnostics: jest.Mock<void, [AppDiagnosticRecord]>;

  beforeEach(() => {
    resetWakeLockDiagWarningForTests();
    diagnostics = jest.fn<void, [AppDiagnosticRecord]>();
    emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    emitWarningSpy.mockRestore();
  });

  it('starts once for the first holder and not for the second', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('chat:a', 'agent chat turn');
    service.acquire('pipeline:b', 'pipeline execution');

    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(service.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 2,
    });
  });

  it('does not start the blocker on unsupported platforms', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform: 'freebsd',
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('chat:a', 'agent chat turn');

    expect(blocker.start).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 1,
    });
  });

  it('keeps running until the last holder is released', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('a', 'one');
    service.acquire('b', 'two');
    service.release('a');

    expect(blocker.stop).not.toHaveBeenCalled();
    expect(service.getState().active).toBe(true);

    service.release('b');

    expect(blocker.stop).toHaveBeenCalledWith(1);
    expect(service.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 0,
    });
  });

  it('updates duplicate holder reasons without starting again', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('a', 'old');
    service.acquire('a', 'new');

    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(service.getHolders()).toEqual([
      expect.objectContaining({ key: 'a', reason: 'new' }),
    ]);
  });

  it('ignores unknown releases without broadcasting or diagnostics', () => {
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: createPowerSaveBlocker(),
      recordDiagnostic: diagnostics,
    });
    const stateChanged = jest.fn();
    service.setBroadcastHandlers({ stateChanged });
    stateChanged.mockClear();

    service.release('missing');

    expect(stateChanged).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('tracks holders while disabled and starts when re-enabled', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.setEnabled(false);
    service.acquire('a', 'disabled');

    expect(blocker.start).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({
      active: false,
      enabled: false,
      holderCount: 1,
    });

    service.setEnabled(true);

    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 1,
    });
  });

  it('stops when disabled but keeps holders', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('a', 'active');
    service.setEnabled(false);

    expect(blocker.stop).toHaveBeenCalledWith(1);
    expect(service.getState()).toEqual({
      active: false,
      enabled: false,
      holderCount: 1,
    });
    expect(service.getHolders()).toHaveLength(1);
  });

  it('shutdown stops, clears holders, and broadcasts final state', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });
    const stateChanged = jest.fn();
    service.setBroadcastHandlers({ stateChanged });

    service.acquire('a', 'active');
    service.shutdown();

    expect(blocker.stop).toHaveBeenCalledWith(1);
    expect(service.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 0,
    });
    expect(stateChanged).toHaveBeenLastCalledWith({
      active: false,
      enabled: true,
      holderCount: 0,
    });
  });

  it('deduplicates unchanged broadcast states', () => {
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: createPowerSaveBlocker(),
      recordDiagnostic: diagnostics,
    });
    const stateChanged = jest.fn();
    service.setBroadcastHandlers({ stateChanged });
    stateChanged.mockClear();

    service.acquire('a', 'old');
    service.acquire('a', 'new');

    expect(stateChanged).toHaveBeenCalledTimes(1);
  });

  it('emits an error and leaves inactive when Electron reports an invalid start', () => {
    const blocker = createPowerSaveBlocker();
    blocker.isStarted.mockReturnValue(false);
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('a', 'active');

    expect(service.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 1,
    });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'wake_lock_error',
        holderCount: 1,
      }),
    );
    expect(emitWarningSpy).toHaveBeenCalled();
  });

  it('preserves blockerId when stop() throws so a later shutdown retries', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });

    service.acquire('a', 'active');
    expect(service.getState().active).toBe(true);

    // First stop() throws; the service must keep the blockerId so it can
    // retry on a later reconcile/shutdown rather than orphan the OS wake lock.
    blocker.stop.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    service.release('a');

    expect(blocker.stop).toHaveBeenCalledTimes(1);
    // OS-level blocker is still active because stop() threw, so state reports
    // active=true and the holder is gone but blockerId is preserved.
    expect(service.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 0,
    });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'wake_lock_error',
        reason: 'boom',
        blockerId: 1,
      }),
    );

    // Subsequent shutdown retries stop(); this time the default mock succeeds
    // and clears the blocker, leaving the service in a fully released state.
    service.shutdown();

    expect(blocker.stop).toHaveBeenCalledTimes(2);
    expect(blocker.stop).toHaveBeenLastCalledWith(1);
    expect(service.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 0,
    });
  });

  it('reports thrown start failures without claiming inhibition', () => {
    const blocker = createPowerSaveBlocker();
    blocker.start.mockImplementation(() => {
      throw new Error('inhibitor unavailable');
    });
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });
    service.acquire('chat:a', 'agent chat turn');
    expect(service.getState().active).toBe(false);
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'wake_lock_error',
        reason: 'inhibitor unavailable',
      }),
    );
  });

  it('reports status probe failures through diagnostics', () => {
    const blocker = createPowerSaveBlocker();
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: blocker,
      recordDiagnostic: diagnostics,
    });
    service.acquire('chat:a', 'agent chat turn');
    blocker.isStarted.mockImplementationOnce(() => {
      throw new Error('status unavailable');
    });
    expect(service.getState().active).toBe(false);
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'wake_lock_error',
        reason: 'status unavailable',
        blockerId: 1,
      }),
    );
  });

  it('is a no-op when Electron is unavailable', () => {
    const service = new WakeLockService({
      platform,
      powerSaveBlocker: null,
      recordDiagnostic: diagnostics,
    });

    service.acquire('a', 'active');
    service.acquire('b', 'active');

    expect(service.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 2,
    });
    expect(
      diagnostics.mock.calls.filter(
        ([record]) => record.kind === 'wake_lock_error',
      ),
    ).toHaveLength(1);
  });
});
