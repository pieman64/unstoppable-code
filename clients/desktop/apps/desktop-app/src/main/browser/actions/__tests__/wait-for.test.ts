import type {
  BrowserAutomationCommand,
  BrowserDownloadTransfer,
  BrowserJavaScriptDialog,
} from '@canopy/desktop-shared/types/browser';
import {
  BrowserWaitForInvalidTargetError,
  BrowserWaitForNavigationError,
  waitForBrowserCondition,
  type BrowserWaitForOptions,
  type BrowserDownloadWaitOptions,
  type BrowserWaitForProbe,
} from '../wait-for';

function makeOptions(
  command: Extract<BrowserAutomationCommand, { kind: 'wait_for' }>,
  overrides: Partial<BrowserWaitForOptions> = {},
): BrowserWaitForOptions {
  return {
    command,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    probe: (): Promise<BrowserWaitForProbe> =>
      Promise.resolve({
        matchCount: 1,
        visibleCount: 1,
        readyState: 'complete',
      }),
    getUrl: (): string => 'https://example.test/path?token=hidden#section',
    getInflightRequestCount: (): number => 0,
    getLastNetworkActivityAt: (): number | undefined => undefined,
    isRuntimeCurrent: (): boolean => true,
    getPendingDialog: (): BrowserJavaScriptDialog | undefined => undefined,
    ...overrides,
  };
}

describe('waitForBrowserCondition', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    [{ kind: 'wait_for', locator: '#ready', state: 'visible' }, 1, 1, true],
    [{ kind: 'wait_for', locator: '#ready', state: 'attached' }, 1, 0, true],
    [{ kind: 'wait_for', locator: '#ready', state: 'hidden' }, 1, 0, true],
    [{ kind: 'wait_for', locator: '#ready', state: 'detached' }, 0, 0, true],
    [{ kind: 'wait_for', text: 'Ready', state: 'visible' }, 1, 1, true],
    [{ kind: 'wait_for', text: 'Ready', state: 'attached' }, 1, 0, true],
    [{ kind: 'wait_for', text: 'Ready', state: 'hidden' }, 0, 0, true],
    [{ kind: 'wait_for', text: 'Ready', state: 'detached' }, 0, 0, true],
  ] as const)(
    'uses the requested locator state',
    async (command, matchCount, visibleCount, satisfied) => {
      const result = await waitForBrowserCondition(
        makeOptions(command, {
          probe: (): Promise<BrowserWaitForProbe> =>
            Promise.resolve({
              matchCount,
              visibleCount,
              readyState: 'interactive',
            }),
          timeoutMs: 0,
        }),
      );
      expect(result).toMatchObject({
        status: 'completed',
        waitFor: {
          satisfied,
          observed: { matchCount, visibleCount, readyState: 'interactive' },
        },
      });
    },
  );

  it('matches URL substrings and anchored * globs against the full URL but redacts query and fragment', async () => {
    const substring = await waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', url: '/path?token=hidden' },
        {
          timeoutMs: 0,
        },
      ),
    );
    expect(substring).toMatchObject({
      status: 'completed',
      waitFor: {
        satisfied: true,
        observed: { url: 'https://example.test/path' },
      },
    });

    const glob = await waitForBrowserCondition(
      makeOptions(
        {
          kind: 'wait_for',
          url: 'https://example.test/*/path?token=hidden#section',
        },
        {
          getUrl: (): string =>
            'https://example.test/team/path?token=hidden#section',
          timeoutMs: 0,
        },
      ),
    );
    expect(glob).toMatchObject({
      status: 'completed',
      waitFor: { satisfied: true },
    });
  });

  it('waits for complete load and 500ms of network idle', async () => {
    const completed = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', loadState: 'network_idle' },
        { timeoutMs: 1_000 },
      ),
    );
    await jest.advanceTimersByTimeAsync(499);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(await completed).toMatchObject({
      status: 'completed',
      waitFor: {
        satisfied: true,
        observed: { readyState: 'complete', inflightRequests: 0 },
      },
    });
  });

  it('restarts the network idle period when requests finish', async () => {
    let inflight = 1;
    let activity = Date.now();
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', loadState: 'network_idle' },
        {
          timeoutMs: 1_500,
          getInflightRequestCount: (): number => inflight,
          getLastNetworkActivityAt: (): number => activity,
        },
      ),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    inflight = 0;
    activity = Date.now();
    await jest.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      status: 'completed',
      waitFor: { satisfied: true },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('times out and aborts a hanging host probe with no remaining timers', async () => {
    let probeSignal: AbortSignal | undefined;
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', locator: '#never' },
        {
          timeoutMs: 150,
          probe: (signal): Promise<BrowserWaitForProbe> => {
            probeSignal = signal;
            return new Promise(() => {});
          },
        },
      ),
    );
    await jest.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({
      status: 'timeout',
      waitFor: { satisfied: false, elapsedMs: 150 },
    });
    expect(probeSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('treats a probe command timeout at the deadline as a wait timeout', async () => {
    const deadline = Date.now() + 1_000;
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', locator: '#never' },
        {
          timeoutMs: 1_000,
          probe: (): Promise<BrowserWaitForProbe> =>
            new Promise((_resolve, reject) => {
              setTimeout(() => {
                jest.setSystemTime(deadline);
                reject(new Error('Browser command timed out: wait-for-probe'));
              }, 10);
            }),
        },
      ),
    );

    await jest.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      waitFor: { satisfied: false },
    });
  });

  it('reports a genuine probe error before the deadline as failed', async () => {
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', locator: '#never' },
        {
          timeoutMs: 1_000,
          probe: (): Promise<BrowserWaitForProbe> =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('probe exploded')), 10);
            }),
        },
      ),
    );

    await jest.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      message: 'probe exploded',
    });
  });

  it('returns a completed unsatisfied receipt when the deadline expires', async () => {
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', text: 'Never there' },
        {
          timeoutMs: 250,
          probe: (): Promise<BrowserWaitForProbe> =>
            Promise.resolve({
              matchCount: 0,
              visibleCount: 0,
              readyState: 'loading',
            }),
        },
      ),
    );
    await jest.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({
      status: 'timeout',
      waitFor: {
        satisfied: false,
        elapsedMs: 250,
        observed: { matchCount: 0, visibleCount: 0, readyState: 'loading' },
      },
    });
  });

  it('polls no more than once per 100ms', async () => {
    const probe = jest.fn<Promise<BrowserWaitForProbe>, [AbortSignal, number]>(
      (): Promise<BrowserWaitForProbe> =>
        Promise.resolve({
          matchCount: 0,
          visibleCount: 0,
          readyState: 'loading',
        }),
    );
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', text: 'Ready' },
        { timeoutMs: 250, pollIntervalMs: 400, probe },
      ),
    );
    await jest.advanceTimersByTimeAsync(200);
    expect(probe).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(50);
    await pending;
  });

  it('observes DOMContentLoaded before the full page finishes loading', async () => {
    const outcome = await waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', loadState: 'domcontentloaded' },
        {
          isNavigating: (): boolean => true,
          probe: (): Promise<BrowserWaitForProbe> =>
            Promise.resolve({
              readyState: 'interactive',
              matchCount: 0,
              visibleCount: 0,
            }),
        },
      ),
    );
    expect(outcome).toMatchObject({
      status: 'completed',
      waitFor: { satisfied: true },
    });
  });

  it('cancels a pending probe and returns promptly', async () => {
    const controller = new AbortController();
    const probe = jest.fn(
      (): Promise<BrowserWaitForProbe> =>
        new Promise<BrowserWaitForProbe>(() => {}),
    );
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', locator: '#ready' },
        { signal: controller.signal, probe },
      ),
    );
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(probe.mock.calls[0]?.[0].aborted).toBe(true);
  });

  it('classifies invalid locators and retries a probe interrupted by navigation', async () => {
    const invalid = await waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', locator: '[' },
        {
          probe: (): Promise<BrowserWaitForProbe> =>
            Promise.reject(
              new BrowserWaitForInvalidTargetError('Invalid locator.'),
            ),
        },
      ),
    );
    expect(invalid).toEqual({
      status: 'invalid_target',
      message: 'Invalid locator.',
    });

    let probes = 0;
    const navigationPending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', text: 'Ready' },
        {
          timeoutMs: 250,
          pollIntervalMs: 1,
          probe: (): Promise<BrowserWaitForProbe> => {
            probes += 1;
            return probes === 1
              ? Promise.reject(new BrowserWaitForNavigationError())
              : Promise.resolve({
                  matchCount: 1,
                  visibleCount: 1,
                  readyState: 'complete',
                });
          },
        },
      ),
    );
    await jest.advanceTimersByTimeAsync(100);
    const navigation = await navigationPending;
    expect(navigation).toMatchObject({
      status: 'completed',
      waitFor: { satisfied: true },
    });
    expect(probes).toBe(2);
  });

  it('stops when the runtime is lost or a dialog is pending', async () => {
    const lost = await waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', text: 'Ready' },
        {
          isRuntimeCurrent: (): boolean => false,
        },
      ),
    );
    expect(lost).toEqual({ status: 'runtime_lost' });

    const dialog: BrowserJavaScriptDialog = {
      id: 'dialog-1',
      browserId: 'browser-1',
      type: 'alert',
      message: 'stop',
      url: 'https://example.test/path',
      openedAt: 1,
    };
    const blocked = await waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', text: 'Ready' },
        {
          getPendingDialog: (): BrowserJavaScriptDialog => dialog,
        },
      ),
    );
    expect(blocked).toEqual({ status: 'dialog', dialog });
  });
  it('does not probe faster when a shorter interval is requested', async () => {
    const probe = jest.fn(
      (): Promise<BrowserWaitForProbe> =>
        Promise.resolve({
          matchCount: 0,
          visibleCount: 0,
          readyState: 'loading',
        }),
    );
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', text: 'Ready' },
        { timeoutMs: 250, pollIntervalMs: 1, probe },
      ),
    );
    await jest.advanceTimersByTimeAsync(99);
    expect(probe).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(150);
    await pending;
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['runtime', 'dialog'] as const)(
    'stops a hanging probe promptly on %s change',
    async (change) => {
      let current = true;
      let dialog: BrowserJavaScriptDialog | undefined;
      const expectedDialog: BrowserJavaScriptDialog = {
        id: 'dialog-2',
        browserId: 'browser-1',
        type: 'alert',
        message: 'stop',
        url: 'https://example.test/path',
        openedAt: 1,
      };
      let probeSignal: AbortSignal | undefined;
      const pending = waitForBrowserCondition(
        makeOptions(
          { kind: 'wait_for', locator: '#ready' },
          {
            timeoutMs: 60_000,
            probe: (signal): Promise<BrowserWaitForProbe> => {
              probeSignal = signal;
              return new Promise(() => {});
            },
            isRuntimeCurrent: (): boolean => current,
            getPendingDialog: (): BrowserJavaScriptDialog | undefined => dialog,
          },
        ),
      );
      await jest.advanceTimersByTimeAsync(1);
      if (change === 'runtime') current = false;
      else dialog = expectedDialog;
      await jest.advanceTimersByTimeAsync(99);
      expect(await pending).toEqual(
        change === 'runtime'
          ? { status: 'runtime_lost' }
          : { status: 'dialog', dialog: expectedDialog },
      );
      expect(probeSignal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['load', 'domcontentloaded', 'network_idle'] as const)(
    'does not satisfy %s against a document during navigation',
    async (loadState) => {
      let navigating = true;
      const pending = waitForBrowserCondition(
        makeOptions(
          { kind: 'wait_for', loadState },
          {
            timeoutMs: 1_000,
            isNavigating: (): boolean => navigating,
            getLastNetworkActivityAt: (): number => Date.now() - 5_000,
          },
        ),
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      navigating = false;
      await jest.advanceTimersByTimeAsync(
        loadState === 'network_idle' ? 600 : 100,
      );
      expect(await pending).toMatchObject({
        status: 'completed',
        waitFor: { satisfied: true },
      });
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});

describe('download waits', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const download: BrowserDownloadTransfer = {
    kind: 'download',
    id: 'download-1',
    browserId: 'browser-1',
    source: 'agent',
    origin: 'https://example.test/export',
    fileName: 'report.pdf',
    receivedBytes: 10,
    totalBytes: 100,
    status: 'in_progress',
    startedAt: 1,
  };
  it.each([{}, { downloadId: 'download-1' }])(
    'uses task files instead of probing the document: %j',
    async (condition) => {
      const finished = {
        ...download,
        status: 'complete' as const,
        receivedBytes: 100,
      };
      const waitForDownload = jest.fn((options: BrowserDownloadWaitOptions) => {
        options.onProgress?.(finished);
        return Promise.resolve(finished);
      });
      const probe = jest.fn(() => Promise.reject(new Error('must not probe')));
      const since = Date.now();
      const pending = waitForBrowserCondition(
        makeOptions(
          { kind: 'wait_for', download: condition },
          { probe, waitForDownload },
        ),
      );
      await jest.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({
        status: 'completed',
        waitFor: { satisfied: true, observed: { download: finished } },
      });
      expect(waitForDownload).toHaveBeenCalledTimes(1);
      const input = waitForDownload.mock.calls[0]?.[0];
      expect(input?.downloadId).toBe(
        'downloadId' in condition ? condition.downloadId : undefined,
      );
      expect(input?.since).toBe(since);
      expect(input?.signal).toBeInstanceOf(AbortSignal);
      expect(typeof input?.onProgress).toBe('function');
      expect(probe).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it('times out false with the latest progress and aborts the store watcher', async () => {
    let watcherSignal: AbortSignal | undefined;
    const waitForDownload = jest.fn(
      (
        options: BrowserDownloadWaitOptions,
      ): Promise<BrowserDownloadTransfer | undefined> => {
        watcherSignal = options.signal;
        options.onProgress?.(download);
        return new Promise((resolve) =>
          options.signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          }),
        );
      },
    );
    const pending = waitForBrowserCondition(
      makeOptions(
        { kind: 'wait_for', download: {} },
        { timeoutMs: 200, waitForDownload },
      ),
    );
    await jest.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({
      status: 'timeout',
      waitFor: { satisfied: false, elapsedMs: 200, observed: { download } },
    });
    expect(watcherSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['cancelled', 'runtime_lost', 'dialog'] as const)(
    'aborts pending download watches on %s',
    async (reason) => {
      const controller = new AbortController();
      let current = true;
      let dialog: BrowserJavaScriptDialog | undefined;
      let watcherSignal: AbortSignal | undefined;
      const waitForDownload = (
        options: BrowserDownloadWaitOptions,
      ): Promise<BrowserDownloadTransfer | undefined> => {
        watcherSignal = options.signal;
        return new Promise((resolve) =>
          options.signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          }),
        );
      };
      const pending = waitForBrowserCondition(
        makeOptions(
          { kind: 'wait_for', download: {} },
          {
            signal: controller.signal,
            isRuntimeCurrent: () => current,
            getPendingDialog: () => dialog,
            waitForDownload,
          },
        ),
      );
      await jest.advanceTimersByTimeAsync(1);
      if (reason === 'cancelled') controller.abort();
      if (reason === 'runtime_lost') current = false;
      if (reason === 'dialog')
        dialog = {
          id: 'dialog-1',
          browserId: 'browser-1',
          url: 'https://example.test/',
          type: 'alert',
          message: 'Hello',
          openedAt: Date.now(),
        };
      await jest.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ status: reason });
      expect(watcherSignal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});

describe('download watcher admission ordering', () => {
  it('registers synchronously before a next download can be admitted in the same tick', async () => {
    const waitForDownload = jest.fn(() => Promise.resolve(undefined));
    const pending = waitForBrowserCondition(
      makeOptions({ kind: 'wait_for', download: {} }, { waitForDownload }),
    );
    const registeredBeforeReturn = waitForDownload.mock.calls.length;
    await pending;
    expect(registeredBeforeReturn).toBe(1);
  });
});
