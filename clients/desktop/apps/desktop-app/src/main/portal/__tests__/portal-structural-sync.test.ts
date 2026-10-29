import {
  isCanopyPortalActive,
  pushPortalOverviewSnapshot,
} from '../portal-event-bus';
import {
  cancelPortalStructuralSync,
  schedulePortalStructuralSync,
} from '../portal-structural-sync';

jest.mock('../portal-event-bus', () => ({
  isCanopyPortalActive: jest.fn(),
  pushPortalOverviewSnapshot: jest.fn(),
}));

const mockedActive = jest.mocked(isCanopyPortalActive);
const mockedPush = jest.mocked(pushPortalOverviewSnapshot);

describe('portal-structural-sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    cancelPortalStructuralSync();
    jest.useRealTimers();
  });

  it('does nothing when no portal session is active', () => {
    mockedActive.mockReturnValue(false);

    schedulePortalStructuralSync();
    jest.runOnlyPendingTimers();

    expect(mockedPush).not.toHaveBeenCalled();
  });

  it('pushes a fresh overview snapshot after the debounce window', () => {
    mockedActive.mockReturnValue(true);

    schedulePortalStructuralSync();
    expect(mockedPush).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(mockedPush).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of structural mutations into a single push', () => {
    mockedActive.mockReturnValue(true);

    schedulePortalStructuralSync();
    schedulePortalStructuralSync();
    schedulePortalStructuralSync();
    jest.runOnlyPendingTimers();

    expect(mockedPush).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending push on shutdown teardown', () => {
    mockedActive.mockReturnValue(true);

    schedulePortalStructuralSync();
    cancelPortalStructuralSync();
    jest.runOnlyPendingTimers();

    expect(mockedPush).not.toHaveBeenCalled();
  });
});
