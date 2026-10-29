// The subscription module imports the cloud-credential store only for its
// default `getCredentials`; the tests inject their own, so stub the store to
// keep electron/secure-store wiring out of the test graph.
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: jest.fn(),
}));

import {
  createPlanRealtimeSubscription,
  parseSseEvents,
  type PlanRealtimeFetch,
} from '../plans/plan-realtime-subscription';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

function planDetailFrame(planId: string, revision: number, id: number): string {
  const envelope = {
    type: 'plan.detail',
    eventId: `plan.detail:${planId}@x`,
    occurredAt: '2026-01-01T00:00:00.000Z',
    sequence: id,
    payload: { planId, revision },
  };
  return `id: ${id}\nevent: plan.detail\ndata: ${JSON.stringify(envelope)}\n\n`;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const credentials = { baseUrl: 'https://cloud.example', apiKey: 'secret-key' };

describe('parseSseEvents', () => {
  it('parses event/data/id fields and ignores comments', () => {
    const buffer =
      ': keepalive\n\nid: 5\nevent: plan.detail\ndata: {"a":1}\n\n';
    const { events, remainder } = parseSseEvents(buffer);
    expect(remainder).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'plan.detail',
      id: '5',
      data: '{"a":1}',
    });
  });

  it('joins multi-line data and returns a trailing partial frame as remainder', () => {
    const buffer = 'event: x\ndata: line1\ndata: line2\n\nid: 9\ndata: partial';
    const { events, remainder } = parseSseEvents(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2');
    expect(remainder).toBe('id: 9\ndata: partial');
  });
});

describe('createPlanRealtimeSubscription', () => {
  it('invokes onSignal with the parsed payload on a plan.detail frame', async () => {
    const onSignal = jest.fn();
    const fetchImpl: jest.MockedFunction<PlanRealtimeFetch> = jest.fn();
    fetchImpl
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: streamFromChunks([planDetailFrame('plan-1', 4, 11)]),
      })
      // After the stream ends, the reconnect hits a 404 → terminal-quiet.
      .mockResolvedValue({ status: 404, ok: false, body: null });
    const delayImpl = jest.fn((): Promise<void> => Promise.resolve());

    const sub = createPlanRealtimeSubscription({
      remoteId: 'plan-1',
      onSignal,
      getCredentials: () => Promise.resolve(credentials),
      fetchImpl,
      delayImpl,
    });

    await waitFor(() => onSignal.mock.calls.length > 0);
    expect(onSignal).toHaveBeenCalledWith({ planId: 'plan-1', revision: 4 });

    const url = fetchImpl.mock.calls[0][0];
    expect(url.startsWith(`${credentials.baseUrl}/api/v1/`)).toBe(true);
    expect(url.endsWith('/plans/plan-1/stream')).toBe(true);
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers.Authorization).toBe(`Bearer ${credentials.apiKey}`);
    expect(init.headers.Accept).toBe('text/event-stream');

    sub.stop();
  });

  it('is terminal-quiet on a 404 (no reconnect)', async () => {
    const onSignal = jest.fn();
    const fetchImpl: jest.MockedFunction<PlanRealtimeFetch> = jest.fn();
    fetchImpl.mockResolvedValue({ status: 404, ok: false, body: null });
    const delayImpl = jest.fn((): Promise<void> => Promise.resolve());

    const sub = createPlanRealtimeSubscription({
      remoteId: 'plan-404',
      onSignal,
      getCredentials: () => Promise.resolve(credentials),
      fetchImpl,
      delayImpl,
    });

    await waitFor(() => fetchImpl.mock.calls.length > 0);
    // Give the loop a chance to (incorrectly) reconnect; it must not.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delayImpl).not.toHaveBeenCalled();
    expect(onSignal).not.toHaveBeenCalled();

    sub.stop();
  });

  it.each([401, 403])(
    'is terminal-quiet on a %i (rejected credentials, no reconnect)',
    async (status) => {
      const onSignal = jest.fn();
      const fetchImpl: jest.MockedFunction<PlanRealtimeFetch> = jest.fn();
      fetchImpl.mockResolvedValue({ status, ok: false, body: null });
      const delayImpl = jest.fn((): Promise<void> => Promise.resolve());

      const sub = createPlanRealtimeSubscription({
        remoteId: 'plan-auth',
        onSignal,
        getCredentials: () => Promise.resolve(credentials),
        fetchImpl,
        delayImpl,
      });

      await waitFor(() => fetchImpl.mock.calls.length > 0);
      // Give the loop a chance to (incorrectly) reconnect; it must not.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(delayImpl).not.toHaveBeenCalled();
      expect(onSignal).not.toHaveBeenCalled();

      sub.stop();
    },
  );

  it('reconnects with backoff after a stream ends, resuming with Last-Event-ID', async () => {
    const onSignal = jest.fn();
    const fetchImpl: jest.MockedFunction<PlanRealtimeFetch> = jest.fn();
    fetchImpl
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: streamFromChunks([planDetailFrame('plan-2', 1, 77)]),
      })
      .mockResolvedValueOnce({ status: 404, ok: false, body: null });
    const delayImpl = jest.fn((): Promise<void> => Promise.resolve());

    const sub = createPlanRealtimeSubscription({
      remoteId: 'plan-2',
      onSignal,
      getCredentials: () => Promise.resolve(credentials),
      fetchImpl,
      delayImpl,
    });

    await waitFor(() => fetchImpl.mock.calls.length >= 2);
    expect(delayImpl).toHaveBeenCalledTimes(1);
    // First reconnect uses the base backoff (attempt 0).
    expect(delayImpl.mock.calls[0][0]).toBe(5000);
    // The reconnect carries the last seen event id.
    expect(fetchImpl.mock.calls[1][1].headers['Last-Event-ID']).toBe('77');

    sub.stop();
  });

  it('stops quietly when credential resolution fails (cloud not configured)', async () => {
    const onSignal = jest.fn();
    const fetchImpl: jest.MockedFunction<PlanRealtimeFetch> = jest.fn();
    const delayImpl = jest.fn((): Promise<void> => Promise.resolve());
    const configError = new Error('not configured');
    configError.name = 'CanopyCloudConfigError';

    const sub = createPlanRealtimeSubscription({
      remoteId: 'plan-3',
      onSignal,
      getCredentials: () => Promise.reject(configError),
      fetchImpl,
      delayImpl,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(delayImpl).not.toHaveBeenCalled();

    sub.stop();
  });
});
