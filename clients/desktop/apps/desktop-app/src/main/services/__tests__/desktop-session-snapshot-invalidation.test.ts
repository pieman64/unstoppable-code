import {
  cancelDesktopSessionSnapshotInvalidation,
  scheduleDesktopSessionSnapshotInvalidation,
  subscribeDesktopSessionSnapshotInvalidation,
} from '../desktop-session-snapshot-invalidation';

describe('desktop session snapshot invalidation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    cancelDesktopSessionSnapshotInvalidation();
  });

  afterEach(() => {
    cancelDesktopSessionSnapshotInvalidation();
    jest.useRealTimers();
  });

  it('coalesces a burst of main-side changes into one notification', () => {
    const listener = jest.fn();
    subscribeDesktopSessionSnapshotInvalidation(listener);

    scheduleDesktopSessionSnapshotInvalidation();
    scheduleDesktopSessionSnapshotInvalidation();
    scheduleDesktopSessionSnapshotInvalidation();
    jest.runOnlyPendingTimers();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
