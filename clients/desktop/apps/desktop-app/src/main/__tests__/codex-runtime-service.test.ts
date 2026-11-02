const mockShutdown = jest.fn((): Promise<void> => Promise.resolve());
const mockCreateCodexRuntimeService = jest.fn(() => ({
  get shutdown(): typeof mockShutdown {
    return mockShutdown;
  },
}));

jest.mock('@canopy/desktop-shared/node/codex-runtime', () => ({
  get createCodexRuntimeService(): typeof mockCreateCodexRuntimeService {
    return mockCreateCodexRuntimeService;
  },
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

import type {
  CodexIngestionLagSample,
  CodexInteractiveOwner,
} from '@canopy/desktop-shared/node/codex-runtime/runtime-service';

describe('Codex runtime ingestion lag sample contract', () => {
  it('reexports the sample type and keeps its handler on interactive owners', () => {
    const sample: CodexIngestionLagSample = {
      lagMs: 5_100,
      source: 'provider',
      sampledAtMs: 1_234,
      catchingUp: true,
    };
    const handleIngestionLagSample: NonNullable<
      CodexInteractiveOwner['handleIngestionLagSample']
    > = jest.fn();

    void handleIngestionLagSample(sample);

    expect(handleIngestionLagSample).toHaveBeenCalledWith(sample);
  });
});

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
