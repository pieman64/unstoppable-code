import type { BrowserDownloadTransfer } from '@canopy/desktop-shared/types/browser';
import {
  captureEffectBaseline,
  collectBrowserEffects,
  sanitizeNavigationUrl,
} from '../effects';

describe('browser effects', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('settles a quiet page in 50ms using only one timer', async () => {
    jest.useFakeTimers();
    const timers = jest.spyOn(global, 'setTimeout');
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({ send, before: {} });
    await jest.advanceTimersByTimeAsync(49);
    expect(send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
    expect(timers).toHaveBeenCalledTimes(1);
    timers.mockRestore();
  });

  it('extends DOM quiet time from mutation events but caps continuous mutations at 300ms', async () => {
    jest.useFakeTimers();
    let mutations = 0;
    let notify = (): void => {};
    const unsubscribe = jest.fn((): void => {});
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: { mutationCount: 0 },
      mutationCount: () => mutations,
      subscribeSettle: (listener): (() => void) => {
        notify = listener;
        return unsubscribe;
      },
    });
    for (let time = 20; time < 300; time += 20) {
      await jest.advanceTimersByTimeAsync(20);
      mutations++;
      notify();
    }
    await jest.advanceTimersByTimeAsync(19);
    expect(send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect((await pending).domChanged).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('extends a navigation started at 40ms until commit without polling', async () => {
    jest.useFakeTimers();
    let started = false;
    let committed = false;
    let notify = (): void => {};
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      navigationStarted: () => started,
      navigationCommitted: () => committed,
      subscribeSettle: (listener): (() => void) => {
        notify = listener;
        return (): void => {};
      },
    });
    await jest.advanceTimersByTimeAsync(40);
    started = true;
    notify();
    await jest.advanceTimersByTimeAsync(360);
    expect(send).not.toHaveBeenCalled();
    committed = true;
    notify();
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('waits for delivery confirmation or its own 1s deadline', async () => {
    jest.useFakeTimers();
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      deliveryConfirmed: () => false,
      deliveryDeadline: Date.now() + 1_000,
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not cut short a half-correlated dialog and settles when its counterpart arrives', async () => {
    jest.useFakeTimers();
    let half = true;
    let notify = (): void => {};
    const until = Date.now() + 2_000;
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      pendingDialogCorrelationUntil: () => (half ? until : undefined),
      subscribeSettle: (listener): (() => void) => {
        notify = listener;
        return (): void => {};
      },
    });
    await jest.advanceTimersByTimeAsync(300);
    expect(send).not.toHaveBeenCalled();
    half = false;
    notify();
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('settles at a matching delivery notification after the minimum without polling', async () => {
    jest.useFakeTimers();
    let matched = false;
    let notify = (): void => {};
    const timers = jest.spyOn(global, 'setTimeout');
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      deliveryConfirmed: () => matched,
      deliveryDeadline: Date.now() + 1_000,
      subscribeSettle: (listener): (() => void) => {
        notify = listener;
        return (): void => {};
      },
    });
    await jest.advanceTimersByTimeAsync(75);
    expect(send).not.toHaveBeenCalled();
    matched = true;
    notify();
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
    expect(timers).toHaveBeenCalledTimes(2);
    timers.mockRestore();
  });

  it('bounds navigation and missing dialog counterparts at their 2s deadlines', async () => {
    jest.useFakeTimers();
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const until = Date.now() + 2_000;
    const pending = collectBrowserEffects({
      send,
      before: {},
      navigationStarted: () => true,
      navigationCommitted: () => false,
      pendingDialogCorrelationUntil: () => until,
      subscribeSettle: (): (() => void) => (): void => {},
    });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(['quiet', 'navigation', 'delivery', 'dialog'] as const)(
    'clamps the %s settle deadline to the timeout budget after dispatch',
    async (kind) => {
      jest.useFakeTimers();
      const startedAt = Date.now();
      const until = startedAt + 1_000;
      let settledAt: number | undefined;
      const send = jest.fn((): Promise<object> => {
        settledAt ??= Date.now();
        return Promise.resolve({});
      });
      const timeoutOptions = { timeoutMs: 200 };
      const pending = collectBrowserEffects({
        send,
        before: {},
        startedAt,
        waitMs: kind === 'quiet' ? 1_000 : 0,
        ...timeoutOptions,
        navigationStarted:
          kind === 'navigation' ? (): boolean => true : undefined,
        navigationCommitted: (): boolean => false,
        deliveryConfirmed:
          kind === 'delivery' ? (): boolean => false : undefined,
        deliveryDeadline: kind === 'delivery' ? until : undefined,
        pendingDialogCorrelationUntil:
          kind === 'dialog' ? (): number => until : undefined,
        subscribeSettle: (): (() => void) => (): void => {},
      });
      await jest.advanceTimersByTimeAsync(199);
      expect(send).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      const settledOnBudget = settledAt === startedAt + 200;
      if (!settledAt) await jest.advanceTimersByTimeAsync(3_000);
      await pending;
      expect(settledOnBudget).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it('uses the 100ms floor when the requested settle timeout is shorter', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    let settledAt: number | undefined;
    const send = jest.fn((): Promise<object> => {
      settledAt ??= Date.now();
      return Promise.resolve({});
    });
    const timeoutOptions = { timeoutMs: 50 };
    const pending = collectBrowserEffects({
      send,
      before: {},
      waitMs: 500,
      ...timeoutOptions,
    });
    await jest.advanceTimersByTimeAsync(99);
    expect(send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    const settledOnFloor = settledAt === startedAt + 100;
    if (!settledAt) await jest.advanceTimersByTimeAsync(500);
    await pending;
    expect(settledOnFloor).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on abort and ignores later settle notifications', async () => {
    jest.useFakeTimers();
    let notify = (): void => {};
    const controller = new AbortController();
    const unsubscribe = jest.fn((): void => {});
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      signal: controller.signal,
      subscribeSettle: (listener): (() => void) => {
        notify = listener;
        return unsubscribe;
      },
    });
    controller.abort();
    await expect(pending).resolves.toEqual({});
    notify();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('removes query, fragment, and credentials from navigation URLs', () => {
    expect(
      sanitizeNavigationUrl('https://name:secret@example.com/path?q=secret#s'),
    ).toBe('https://example.com/path');
  });

  it('collects value-free navigation, DOM, and focus changes', async () => {
    const mutations = 3;
    const send = jest.fn((method: string): Promise<object> => {
      if (method === 'Page.getFrameTree')
        return Promise.resolve({
          frameTree: {
            frame: { url: 'https://example.com/next?token=1', loaderId: 'new' },
          },
        });
      return Promise.resolve({ result: { value: 'BUTTON:1' } });
    });
    const result = await collectBrowserEffects({
      send,
      before: {
        url: 'https://example.com/start',
        loaderId: 'old',
        mutationCount: 1,
        focus: 'INPUT:0',
      },
      waitMs: 0,
      mutationCount: () => mutations,
    });
    expect(result).toEqual({
      navigation: {
        kind: 'new_document',
        url: 'https://example.com/next',
        committed: true,
      },
      domChanged: true,
      focusMoved: true,
    });
  });

  it("sees focus move inside a frame target's document, read in the target's own session", async () => {
    // The top document's focus stays on the iframe; the frame's moves.
    let frameFocus = 'HTML:0/BODY:1/INPUT:0';
    const send = jest.fn(
      (
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
      ): Promise<object> => {
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({
            result: {
              value:
                params.objectId === 'target' && sessionId === 'child'
                  ? frameFocus
                  : 'wrong',
            },
          });
        if (method === 'Runtime.evaluate')
          return Promise.resolve({
            result: {
              value:
                sessionId === undefined ? 'HTML:0/BODY:1/IFRAME:3' : 'wrong',
            },
          });
        return Promise.resolve({});
      },
    );
    const focusDocument = { objectId: 'target', sessionId: 'child' };
    const before = await captureEffectBaseline({ send, focusDocument });
    frameFocus = 'HTML:0/BODY:1/BUTTON:1';
    const result = await collectBrowserEffects({
      send,
      before,
      waitMs: 0,
      focusDocument,
    });
    expect(result.focusMoved).toBe(true);
    const unmoved = await collectBrowserEffects({
      send,
      before: await captureEffectBaseline({ send, focusDocument }),
      waitMs: 0,
      focusDocument,
    });
    expect(unmoved.focusMoved).toBe(false);
    expect(
      send.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn'),
    ).toHaveLength(4);
  });

  it('does no reads after an abort during settling', async () => {
    const controller = new AbortController();
    const send = jest.fn((): Promise<object> => Promise.resolve({}));
    const result = collectBrowserEffects({
      send,
      before: {},
      waitMs: 500,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).resolves.toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it('detects fragment-only navigation but never exposes it', async () => {
    const send = jest.fn(
      (method: string): Promise<object> =>
        Promise.resolve(
          method === 'Page.getFrameTree'
            ? {
                frameTree: {
                  frame: { url: 'https://example.com/path?q=secret#after' },
                },
              }
            : { result: { value: '' } },
        ),
    );
    const effects = await collectBrowserEffects({
      send,
      before: { url: 'https://example.com/path?q=secret#before' },
      waitMs: 0,
    });
    expect(effects.navigation).toEqual({
      kind: 'same_document',
      url: 'https://example.com/path',
      committed: true,
    });
  });

  it('extends settling until a started navigation commits', async () => {
    let committed = false;
    const send = jest.fn(
      (method: string): Promise<object> =>
        Promise.resolve(
          method === 'Page.getFrameTree'
            ? {
                frameTree: {
                  frame: { url: 'https://example.com/after', loaderId: 'two' },
                },
              }
            : { result: { value: '' } },
        ),
    );
    const pending = collectBrowserEffects({
      send,
      before: { url: 'https://example.com/before', loaderId: 'one' },
      waitMs: 0,
      navigationStarted: () => true,
      navigationCommitted: () => committed,
    });
    expect(send).not.toHaveBeenCalled();
    committed = true;
    const effects = await pending;
    expect(effects.navigation?.kind).toBe('new_document');
  });
});

describe('download effects', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const download: BrowserDownloadTransfer = {
    kind: 'download',
    id: 'download-1',
    browserId: 'browser-1',
    source: 'agent',
    actionId: 'action-1',
    origin: 'https://example.test/export',
    fileName: 'report.pdf',
    receivedBytes: 10,
    totalBytes: 100,
    status: 'in_progress',
    startedAt: 1,
  };
  it('extends settle past 300ms while attributed downloads progress then observes completion', async () => {
    let downloads = [download];
    const send = jest.fn(() => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      timeoutMs: 1_000,
      getDownloads: (): BrowserDownloadTransfer[] => downloads,
    });
    await jest.advanceTimersByTimeAsync(400);
    expect(send).not.toHaveBeenCalled();
    downloads = [{ ...download, status: 'complete', receivedBytes: 100 }];
    await jest.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ downloads });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('caps a progressing download at the action timeout and reports progress', async () => {
    const send = jest.fn(() => Promise.resolve({}));
    const pending = collectBrowserEffects({
      send,
      before: {},
      timeoutMs: 500,
      getDownloads: (): BrowserDownloadTransfer[] => [download],
    });
    await jest.advanceTimersByTimeAsync(499);
    expect(send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ downloads: [download] });
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each([
    'paused',
    'interrupted',
    'cancelled',
    'failed',
    'complete',
  ] as const)('does not extend a %s transfer', async (status) => {
    const transfers = [{ ...download, status }];
    const pending = collectBrowserEffects({
      send: () => Promise.resolve({}),
      before: {},
      timeoutMs: 1_000,
      getDownloads: (): BrowserDownloadTransfer[] => transfers,
    });
    await jest.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ downloads: transfers });
  });
  it('includes downloads beside a dialog without observational CDP reads', async () => {
    const send = jest.fn(() => Promise.resolve({}));
    const completed = { ...download, status: 'complete' as const };
    const pending = collectBrowserEffects({
      send,
      before: {},
      getPendingDialog: () => ({
        id: 'dialog-1',
        browserId: 'browser-1',
        url: 'https://example.test/',
        type: 'alert',
        message: 'Saved',
        openedAt: 1,
      }),
      getDownloads: (): BrowserDownloadTransfer[] => [completed],
    });
    await jest.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({
      dialog: { message: 'Saved' },
      downloads: [completed],
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('cancels progressing settle without leaking timers or returning stale downloads', async () => {
    const controller = new AbortController();
    const pending = collectBrowserEffects({
      send: () => Promise.resolve({}),
      before: {},
      timeoutMs: 1_000,
      signal: controller.signal,
      getDownloads: (): BrowserDownloadTransfer[] => [download],
    });
    await jest.advanceTimersByTimeAsync(400);
    controller.abort();
    expect(await pending).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });
});
