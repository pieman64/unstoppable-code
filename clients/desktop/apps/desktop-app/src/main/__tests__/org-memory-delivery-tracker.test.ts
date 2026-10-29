import type {
  OrgMemoryDeliveryAckDetails,
  OrgMemoryFetchResult,
} from '../memory/memory-client';
import { createOrgMemoryDeliveryTracker } from '../memory/delivery-tracker';

// Acks go to the org the search was made in (CAN-3457).
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const memoryFact = {
  factText: 'fact',
  validAt: null,
  sourceTurnIds: ['turn-1'],
};

interface Deferred {
  promise: Promise<OrgMemoryFetchResult | null>;
  resolve: (value: OrgMemoryFetchResult | null) => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve: (value: OrgMemoryFetchResult | null) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<OrgMemoryFetchResult | null>(
    (innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    },
  );
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function injectableResult(
  searchId: string,
  organizationExternalId = ORG,
): OrgMemoryFetchResult {
  return {
    organizationExternalId,
    searchId,
    renderedBlock: '<org_memory>fact</org_memory>',
    facts: [memoryFact],
  };
}

describe('createOrgMemoryDeliveryTracker', () => {
  const ackMock = jest.fn<
    Promise<void>,
    [string, string, OrgMemoryDeliveryAckDetails?]
  >(() => Promise.resolve());

  beforeEach(() => {
    ackMock.mockClear();
  });

  function makeTracker(
    resultPromise: Promise<OrgMemoryFetchResult | null>,
  ): ReturnType<typeof createOrgMemoryDeliveryTracker> {
    return createOrgMemoryDeliveryTracker({
      resultPromise,
      dispatchStartedAt: Date.now(),
      clientChatId: 'chat-1',
      ack: (organizationExternalId, searchId, details) =>
        ackMock(organizationExternalId, searchId, details),
    });
  }

  it('fires exactly one delivered ack and ignores later settles', async () => {
    const tracker = makeTracker(Promise.resolve(injectableResult('search-1')));

    tracker.ackDelivered(ORG, 'search-1');
    tracker.ackDelivered(ORG, 'search-1');
    tracker.ackDropped(ORG, 'search-1', 'send_failed');
    tracker.noteDispatchExit();
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock).toHaveBeenCalledWith(
      ORG,
      'search-1',
      expect.objectContaining({ outcome: 'delivered', clientChatId: 'chat-1' }),
    );
    const details = ackMock.mock.calls[0]?.[2];
    expect(typeof details?.clientElapsedMs).toBe('number');
  });

  it('fires exactly one dropped ack and ignores later settles', async () => {
    const tracker = makeTracker(Promise.resolve(injectableResult('search-2')));

    tracker.ackDropped(ORG, 'search-2', 'send_failed');
    tracker.ackDropped(ORG, 'search-2', 'send_failed');
    tracker.ackDelivered(ORG, 'search-2');
    tracker.noteDispatchExit();
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock).toHaveBeenCalledWith(
      ORG,
      'search-2',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'send_failed',
      }),
    );
  });

  it('attributes an aborted dispatch once the in-flight result resolves', async () => {
    const pending = deferred();
    const tracker = makeTracker(pending.promise);

    // Dispatch exits (throw or early return) before any ack.
    tracker.noteDispatchExit();
    await flushMicrotasks();
    expect(ackMock).not.toHaveBeenCalled();

    pending.resolve(injectableResult('search-3'));
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock).toHaveBeenCalledWith(
      ORG,
      'search-3',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'turn_aborted',
        clientChatId: 'chat-1',
      }),
    );
    const details = ackMock.mock.calls[0]?.[2];
    expect(typeof details?.clientElapsedMs).toBe('number');
  });

  it('attributes an aborted dispatch whose result had already resolved', async () => {
    const tracker = makeTracker(Promise.resolve(injectableResult('search-4')));

    tracker.noteDispatchExit();
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock).toHaveBeenCalledWith(
      ORG,
      'search-4',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'turn_aborted',
      }),
    );
  });

  it('keeps race_timeout precedence when a race-lost dispatch also aborts', async () => {
    const pending = deferred();
    const tracker = makeTracker(pending.promise);

    tracker.noteRaceLoss();
    tracker.noteDispatchExit();
    pending.resolve(injectableResult('search-5'));
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock).toHaveBeenCalledWith(
      ORG,
      'search-5',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'race_timeout',
      }),
    );
  });

  it('does not ack a result without a searchId or without facts', async () => {
    const withoutSearchId = makeTracker(
      Promise.resolve({
        organizationExternalId: ORG,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
      }),
    );
    withoutSearchId.noteDispatchExit();
    const withoutFacts = makeTracker(
      Promise.resolve({
        organizationExternalId: ORG,
        searchId: 'search-6',
        renderedBlock: '<org_memory>context</org_memory>',
        facts: [],
      }),
    );
    withoutFacts.noteRaceLoss();
    withoutFacts.noteDispatchExit();
    const withNull = makeTracker(Promise.resolve(null));
    withNull.noteDispatchExit();
    await flushMicrotasks();

    expect(ackMock).not.toHaveBeenCalled();
  });

  it('treats a rejected fetch as no result instead of throwing', async () => {
    const pending = deferred();
    const tracker = makeTracker(pending.promise);

    tracker.noteRaceLoss();
    tracker.noteDispatchExit();
    pending.reject(new Error('fetch failed'));
    await flushMicrotasks();

    expect(ackMock).not.toHaveBeenCalled();
  });

  it('does not attribute an abort after the outcome was already settled', async () => {
    const tracker = makeTracker(Promise.resolve(injectableResult('search-7')));

    tracker.ackDelivered(ORG, 'search-7');
    tracker.noteDispatchExit();
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ outcome: 'delivered' }),
    );
  });

  it('attributes a late drop to the org the result was searched in', async () => {
    const pending = deferred();
    const tracker = makeTracker(pending.promise);

    tracker.noteRaceLoss();
    pending.resolve(injectableResult('search-8', OTHER_ORG));
    await flushMicrotasks();

    expect(ackMock).toHaveBeenCalledWith(
      OTHER_ORG,
      'search-8',
      expect.objectContaining({ dropReason: 'race_timeout' }),
    );
  });
});
