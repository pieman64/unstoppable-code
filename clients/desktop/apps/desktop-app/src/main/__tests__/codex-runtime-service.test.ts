const mockShutdown = jest.fn((): Promise<void> => Promise.resolve());
const mockCreateCodexRuntimeService = jest.fn(() => ({
  shutdown: mockShutdown,
}));

jest.mock('@canopy/desktop-shared/node/codex-runtime', () => ({
  createCodexRuntimeService: mockCreateCodexRuntimeService,
  resetCanonicalCodexHomeForTests: jest.fn(),
}));
jest.mock('../codex/runtime-host-adapter', () => ({}));
jest.mock('../codex/capability-store', () => ({
  getDesktopCodexCapabilityStore: jest.fn(() => ({})),
}));

import {
  getCodexRuntimeService,
  onCodexRuntimeServiceReplaced,
  resetCodexRuntimeServiceForTests,
  shutdownCodexRuntimeService,
} from '../codex/runtime-service';

describe('onCodexRuntimeServiceReplaced', () => {
  beforeEach(async () => {
    await resetCodexRuntimeServiceForTests();
    jest.clearAllMocks();
  });

  it('notifies observers when a live runtime is shut down for replacement', async () => {
    const listener = jest.fn();
    const unsubscribe = onCodexRuntimeServiceReplaced(listener);

    const first = getCodexRuntimeService();
    await shutdownCodexRuntimeService();
    expect(listener).toHaveBeenCalledTimes(1);

    // A second shutdown with no live runtime is not a replacement.
    await shutdownCodexRuntimeService();
    expect(listener).toHaveBeenCalledTimes(1);

    expect(getCodexRuntimeService()).not.toBe(first);
    unsubscribe();
    await shutdownCodexRuntimeService();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps shutting down when an observer throws', async () => {
    const failing = jest.fn(() => {
      throw new Error('observer failed');
    });
    const healthy = jest.fn();
    const disposeFailing = onCodexRuntimeServiceReplaced(failing);
    const disposeHealthy = onCodexRuntimeServiceReplaced(healthy);

    getCodexRuntimeService();
    await expect(shutdownCodexRuntimeService()).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    disposeFailing();
    disposeHealthy();
  });
});
