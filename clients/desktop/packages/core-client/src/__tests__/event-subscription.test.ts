import { createCanopyEventSubscription } from '../events/subscription';
import type {
  CanopyEventDelivery,
  CanopyEventSubscription,
} from '../events/types';
import { createEventsCore, type EventsCore } from './fixtures/events-core';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
const pause = (): { promise: Promise<void>; release: () => void } => {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe('client event subscriptions over a fake framed daemon', () => {
  const gates: ReturnType<typeof pause>[] = [];
  const hold = (): ReturnType<typeof pause> => {
    const gate = pause();
    gates.push(gate);
    return gate;
  };
  const cores: EventsCore[] = [];
  const subscriptions: CanopyEventSubscription[] = [];
  const core = (
    options: Parameters<typeof createEventsCore>[0] = {},
  ): EventsCore => {
    const instance = createEventsCore(options);
    cores.push(instance);
    return instance;
  };
  const subscribe = (
    options: Parameters<typeof createCanopyEventSubscription>[0],
  ): CanopyEventSubscription => {
    const subscription = createCanopyEventSubscription(options);
    subscriptions.push(subscription);
    return subscription;
  };
  afterEach(async () => {
    for (const gate of gates.splice(0)) gate.release();
    await Promise.all(subscriptions.splice(0).map((s) => s.close()));
    await Promise.all(cores.splice(0).map((s) => s.close()));
  });

  it('delivers and saves only after durable handling, then wire-acks the saved cursor', async () => {
    const daemon = core();
    const gate = hold();
    const saved: number[] = [];
    const handle = jest.fn(() => Promise.resolve(gate.promise));
    const subscription = subscribe({
      families: ['core.chat'],
      handle,
      snapshot: () => Promise.resolve(null),
      store: {
        load: () => Promise.resolve(null),
        save: (_authority, _key, cursor) => {
          if (cursor) saved.push(cursor.sequence);
          expect(daemon.acknowledgements).toHaveLength(0);

          return Promise.resolve();
        },
      },
    });
    await subscription.attach(await daemon.connect());
    const event = await daemon.append('core.chat.status');
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
    expect(daemon.acknowledgements).toHaveLength(0);
    gate.release();
    await flush();
    expect(saved).toEqual([event.cursor.sequence]);
    expect(daemon.acknowledgements[0]?.cursor).toEqual(event.cursor);
    expect(subscription.cursor('authority-1')).toEqual(event.cursor);
  });

  it('resumes a reconnect from the last durable cursor and replays missed status', async () => {
    const daemon = core();
    const seen: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: (delivery) => {
        if (delivery.kind === 'event') seen.push(delivery.event.eventId);

        return Promise.resolve();
      },
    });
    const client = await daemon.connect();
    await subscription.attach(client);
    const first = await daemon.append('core.chat.status');
    await flush();
    await client.close();
    const second = await daemon.append('core.chat.finished');
    await subscription.attach(await daemon.connect());
    await flush();
    expect(daemon.subscriptions[1]?.cursor).toEqual(first.cursor);
    expect(seen).toEqual([first.eventId, second.eventId]);
  });

  it.each(['open', 'end'] as const)(
    'rehydrates an expired cursor from %s snapshot_required before resubscribing',
    async (snapshotRequired) => {
      const daemon = core({ snapshotRequired });
      const first = await daemon.append('core.chat.status');
      const reasons: string[] = [];
      const seen: string[] = [];
      const subscription = subscribe({
        families: ['core.chat'],
        store: {
          load: () => Promise.resolve(first.cursor),
          save: () => {
            return Promise.resolve();
          },
        },
        snapshot: ({ reason }) => {
          reasons.push(reason);
          return Promise.resolve(daemon.cursor());
        },
        handle: (delivery) => {
          if (delivery.kind === 'event') seen.push(delivery.event.eventId);

          return Promise.resolve();
        },
      });
      await daemon.append('core.chat.finished');
      daemon.expireThrough(2);
      await subscription.attach(await daemon.connect());
      await flush();
      expect(reasons).toEqual(['snapshot_required']);
      expect(daemon.subscriptions.map((s) => s.cursor?.sequence)).toEqual([
        1, 2,
      ]);
      const live = await daemon.append('core.chat.status');
      await flush();
      expect(seen).toEqual([live.eventId]);
      expect(subscription.state('authority-1')).toBe('open');
    },
  );

  it('snapshots a changed daemon epoch and never sends the previous epoch cursor', async () => {
    const daemon = core();
    const reasons: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      handle: () => {
        return Promise.resolve();
      },
      snapshot: ({ reason }) => {
        reasons.push(reason);
        return Promise.resolve(daemon.cursor());
      },
    });
    await subscription.attach(await daemon.connect());
    await daemon.append('core.chat.status');
    await flush();
    daemon.restart('epoch-2');
    await subscription.attach(await daemon.connect());
    expect(reasons).toEqual(['initial', 'epoch_changed']);
    expect(daemon.subscriptions[1]?.cursor).toEqual({
      daemonEpoch: 'epoch-2',
      sequence: 0,
    });
  });

  it('replays last status to a late subscriber and isolates authority cursors', async () => {
    const a = core({ authorityId: 'a' });
    const b = core({ authorityId: 'b' });
    const status = await a.append('core.chat.finished');
    const contexts: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: (_delivery, context) => {
        contexts.push(context.authorityId);

        return Promise.resolve();
      },
    });
    await subscription.attach(await a.connect());
    await subscription.attach(await b.connect());
    await flush();
    expect(subscription.cursor('a')).toEqual(status.cursor);
    expect(subscription.cursor('b')).toBeNull();
    const bStatus = await b.append('core.chat.status');
    await flush();
    expect(subscription.cursor('b')).toEqual(bStatus.cursor);
    expect(contexts).toEqual(['a', 'b']);
    expect(b.subscriptions[0]?.cursor).toBeNull();
  });

  it('prioritizes lifecycle over queued output without acknowledging past an unresolved gap', async () => {
    const daemon = core();
    const gate = hold();
    const deliveries: CanopyEventDelivery[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      maxBufferedOutput: 1,
      classify: (event) =>
        event.name.endsWith('.output') ? 'output' : 'lifecycle',
      snapshot: () => Promise.resolve(null),
      handle: async (delivery) => {
        deliveries.push(delivery);
        if (deliveries.length === 1) await gate.promise;
      },
    });
    await subscription.attach(await daemon.connect());
    await daemon.append('core.chat.output');
    await flush();
    await daemon.append('core.chat.output');
    await daemon.append('core.chat.finished');
    await flush();
    expect(daemon.acknowledgements).toHaveLength(0);
    gate.release();
    await flush();
    expect(
      deliveries.map((d) => (d.kind === 'gap' ? 'gap' : d.event.name)),
    ).toEqual(['core.chat.output', 'gap', 'core.chat.finished']);
    expect(subscription.cursor('authority-1')).toEqual(daemon.cursor());
  });

  it('halts on durable handling failure without advancing or acknowledging', async () => {
    const daemon = core();
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: () => {
        throw new Error('disk full');

        return Promise.resolve();
      },
    });
    await subscription.attach(await daemon.connect());
    await daemon.append('core.chat.finished');
    await flush();
    expect(subscription.state('authority-1')).toBe('failed');
    expect(subscription.error('authority-1')?.message).toBe('disk full');
    expect(subscription.cursor('authority-1')).toBeNull();
    expect(daemon.acknowledgements).toHaveLength(0);
  });
});
