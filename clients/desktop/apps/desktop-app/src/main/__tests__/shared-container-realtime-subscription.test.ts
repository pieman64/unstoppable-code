import {
  createSharedContainerInboxSubscription,
  createSharedContainerRealtimeSubscription,
  type SharedContainerRealtimeFetch,
} from '../shared-containers/realtime-subscription';

function streamOf(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

describe('shared-container realtime subscription', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('parses detail signals and resumes with Last-Event-ID', async () => {
    const signals: unknown[] = [];
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: streamOf(
          'id: event-7\nevent: sharedcontainer.detail\ndata: {"payload":{"containerId":"container-1","revision":7}}\n\n',
        ),
      })
      .mockImplementationOnce(
        async (_url: string, init: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            init.signal.addEventListener(
              'abort',
              () => resolve({ status: 499, ok: false, body: null }),
              { once: true },
            );
          }),
      );
    const subscription = createSharedContainerRealtimeSubscription({
      containerId: 'container-1',
      organizationId: 'org-1',
      onSignal: (signal) => signals.push(signal),
      getCredentials: () =>
        Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
      fetchImpl,
      delayImpl: () => Promise.resolve(),
    });

    await eventually(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(signals).toEqual([{ containerId: 'container-1', revision: 7 }]);
    const secondCall = fetchImpl.mock.calls[1] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(secondCall[1].headers['Last-Event-ID']).toBe('event-7');
    subscription.stop();
  });

  it.each([401, 403])(
    'treats HTTP %i as terminal access loss',
    async (status) => {
      const onAccessDenied = jest.fn();
      const delayImpl = jest.fn(() => Promise.resolve());
      createSharedContainerRealtimeSubscription({
        containerId: 'container-1',
        organizationId: 'org-1',
        onSignal: jest.fn(),
        onAccessDenied,
        getCredentials: () =>
          Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
        fetchImpl: () => Promise.resolve({ status, ok: false, body: null }),
        delayImpl,
      });

      await eventually(() => expect(onAccessDenied).toHaveBeenCalledTimes(1));
      expect(delayImpl).not.toHaveBeenCalled();
    },
  );

  it('retries a disabled 404 stream on the long backoff path', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ status: 404, ok: false, body: null }),
    );
    const delayImpl = jest.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const subscription = createSharedContainerRealtimeSubscription({
      containerId: 'container-1',
      organizationId: 'org-1',
      onSignal: jest.fn(),
      getCredentials: () =>
        Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
      fetchImpl,
      delayImpl,
    });

    await eventually(() => expect(delayImpl).toHaveBeenCalled());
    expect(delayImpl.mock.calls[0][0]).toBeGreaterThanOrEqual(60_000);
    expect(delayImpl.mock.calls[0][0]).toBeLessThanOrEqual(15 * 60_000);
    subscription.stop();
  });

  it('removes each completed retry delay abort listener', async () => {
    jest.useFakeTimers();
    const addEventListener = jest.spyOn(
      AbortSignal.prototype,
      'addEventListener',
    );
    const removeEventListener = jest.spyOn(
      AbortSignal.prototype,
      'removeEventListener',
    );
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ status: 500, ok: false, body: null }),
    );
    const subscription = createSharedContainerRealtimeSubscription({
      containerId: 'container-1',
      organizationId: 'org-1',
      onSignal: jest.fn(),
      getCredentials: () =>
        Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
      fetchImpl,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const abortListener = addEventListener.mock.calls.find(
      ([type]) => type === 'abort',
    )?.[1];
    expect(abortListener).toBeDefined();

    await jest.advanceTimersByTimeAsync(5_000);

    expect(removeEventListener).toHaveBeenCalledWith('abort', abortListener);
    subscription.stop();
  });
});

describe('shared-container inbox realtime subscription', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses the account-scoped URL and signals for any detail payload', async () => {
    const onSignal = jest.fn();
    const fetchImpl: jest.MockedFunction<SharedContainerRealtimeFetch> =
      jest.fn();
    fetchImpl
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: streamOf(
          'id: event-9\nevent: sharedcontainer.detail\ndata: {"payload":{"containerId":"never-opened","futureShape":true}}\n\n',
        ),
      })
      .mockImplementationOnce(
        async (_url, init) =>
          new Promise((resolve) => {
            init.signal.addEventListener(
              'abort',
              () => resolve({ status: 499, ok: false, body: null }),
              { once: true },
            );
          }),
      );
    const subscription = createSharedContainerInboxSubscription({
      onSignal,
      getCredentials: () =>
        Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
      fetchImpl,
      delayImpl: () => Promise.resolve(),
    });

    await eventually(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://cloud.test/api/v1/shared-containers/shared-with-me/stream',
    );
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1]?.[1].headers['Last-Event-ID']).toBe(
      'event-9',
    );
    subscription.stop();
  });

  it.each([401, 403])(
    'treats HTTP %i as terminal access loss',
    async (status) => {
      const onAccessDenied = jest.fn();
      const delayImpl = jest.fn(() => Promise.resolve());
      createSharedContainerInboxSubscription({
        onSignal: jest.fn(),
        onAccessDenied,
        getCredentials: () =>
          Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
        fetchImpl: () => Promise.resolve({ status, ok: false, body: null }),
        delayImpl,
      });

      await eventually(() => expect(onAccessDenied).toHaveBeenCalledTimes(1));
      expect(delayImpl).not.toHaveBeenCalled();
    },
  );

  it('retries a missing inbox stream on the quiet long backoff path', async () => {
    const delayImpl = jest.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const subscription = createSharedContainerInboxSubscription({
      onSignal: jest.fn(),
      getCredentials: () =>
        Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
      fetchImpl: () => Promise.resolve({ status: 404, ok: false, body: null }),
      delayImpl,
    });

    await eventually(() => expect(delayImpl).toHaveBeenCalledTimes(1));
    expect(delayImpl).toHaveBeenCalledWith(60_000, expect.any(AbortSignal));
    subscription.stop();
  });
});
