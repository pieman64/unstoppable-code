import {
  deliverCanopy,
  toCanopyClientError,
  type CanopyClientError,
  type CanopyReplayDirective,
} from '../index';
import { until } from './fixtures/lease-regression-harness';
import { ReceiptCore, type ReceiptClient } from './fixtures/receipt-core';

const KEY = { idempotencyKey: 'record-1' };

interface Delivery {
  outcome: Promise<{ value?: unknown; error?: CanopyClientError }>;
  clients: ReceiptClient[];
}

/**
 * Delivers one call to the current account's core, reconnecting when the last
 * connection dropped: a host's `attach`, reduced to its routing.
 */
function deliver(
  core: ReceiptCore,
  replay: CanopyReplayDirective,
  send: (client: ReceiptClient) => Promise<unknown>,
  account: { current: string },
): Delivery {
  const started = account.current;
  const clients: ReceiptClient[] = [];
  const connected = async (): Promise<ReceiptClient> => {
    const last = clients.at(-1);
    if (last && !last.signal.aborted) return last;
    const client = await core.connect(account.current);
    clients.push(client);
    return client;
  };
  const outcome = deliverCanopy(async () => send(await connected()), {
    replay,
    current: () => account.current === started,
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error: toCanopyClientError(error) }),
  );
  return { outcome, clients };
}

const clientsToClose: ReceiptClient[] = [];
beforeEach(() =>
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask'],
  }),
);
afterEach(async () => {
  await Promise.all(clientsToClose.splice(0).map((client) => client.close()));
});

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await until();
}

describe('deliverCanopy against W5 receipts', () => {
  it('recovers the recorded outcome of a keyed call whose reply was lost', async () => {
    const core = new ReceiptCore();
    core.loseReply = true;
    const { outcome, clients } = deliver(
      core,
      'same_idempotency_key',
      (client) =>
        client.instruction('core.test.record', { value: 7 }, { metadata: KEY }),
      { current: 'authority-1' },
    );
    await until(() => core.effects.length === 1);
    await advance(1_000);
    clientsToClose.push(...clients);
    expect(await outcome).toEqual({ value: { recorded: 7, label: 'none' } });
    expect(core.effects).toEqual([{ method: 'core.test.record', value: 7 }]);
    // Same key, a new connection, and no cancel of the accepted work.
    expect(core.requests).toEqual([
      { method: 'core.test.record', key: 'record-1', connection: 0 },
      { method: 'core.test.record', key: 'record-1', connection: 1 },
    ]);
  });

  it('waits out an in-progress receipt, then returns its outcome', async () => {
    const core = new ReceiptCore();
    let finish = (): void => {};
    core.loseReply = true;
    core.hold = new Promise((resolve) => (finish = resolve));
    const { outcome, clients } = deliver(
      core,
      'same_idempotency_key',
      (client) =>
        client.instruction('core.test.record', { value: 3 }, { metadata: KEY }),
      { current: 'authority-1' },
    );
    await until(() => core.requests.length === 1);
    await advance(1_000);
    expect(core.requests).toHaveLength(2);
    finish();
    await advance(2_000);
    clientsToClose.push(...clients);
    expect(await outcome).toEqual({ value: { recorded: 3, label: 'none' } });
    expect(core.effects).toHaveLength(1);
    expect(core.requests).toHaveLength(3);
  });

  it('never replays an unkeyed call whose reply was lost', async () => {
    const core = new ReceiptCore();
    core.loseReply = true;
    const { outcome, clients } = deliver(
      core,
      'same_request',
      (client) => client.instruction('core.test.fire', { value: 1 }),
      { current: 'authority-1' },
    );
    await until(() => core.effects.length === 1);
    await advance(60_000);
    clientsToClose.push(...clients);
    expect((await outcome).error?.payload).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'never' },
    });
    expect(core.effects).toHaveLength(1);
    expect(core.requests).toHaveLength(1);
  });

  it('does not recover a lost reply on another account', async () => {
    const core = new ReceiptCore();
    const account = { current: 'authority-1' };
    core.loseReply = true;
    const { outcome, clients } = deliver(
      core,
      'same_idempotency_key',
      (client) =>
        client.instruction('core.test.record', { value: 5 }, { metadata: KEY }),
      account,
    );
    await until(() => core.effects.length === 1);
    account.current = 'authority-2';
    await advance(60_000);
    clientsToClose.push(...clients);
    expect((await outcome).error?.payload).toMatchObject({
      kind: 'failed_precondition',
      retry: { kind: 'after_refresh', resource: 'destination' },
    });
    expect(clients).toHaveLength(1);
    expect(core.requests).toHaveLength(1);
  });
});
