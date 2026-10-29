import type { CanopyStreamCursor } from '@canopy/protocol/canopy-core';

import { createCanopyEventSubscription } from '../events/subscription';
import type {
  CanopyEventFrame,
  CanopyEventsConnection,
  CanopyEventSubscription,
} from '../events/types';
import { createEventsCore, type EventsCore } from './fixtures/events-core';

const AUTHORITY = 'authority-1';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

interface WrapOptions {
  readonly authorityId?: string | null;
  readonly ack?: boolean;
  readonly acceptedCursor?: CanopyStreamCursor | null;
  readonly beforeOpen?: () => Promise<void>;
  readonly mapFrame?: (frame: CanopyEventFrame) => CanopyEventFrame;
}

/** Narrow structural wrapper around a real framed client. */
const wrap = (
  client: CanopyEventsConnection,
  overrides: WrapOptions = {},
): CanopyEventsConnection => {
  const { manifest } = client;
  return {
    identity:
      overrides.authorityId === undefined
        ? client.identity
        : { ...client.identity, authorityId: overrides.authorityId },
    manifest: {
      operations: manifest.operations,
      events: manifest.events,
      streams: manifest.streams,
      has: (kind, name): boolean =>
        !(
          overrides.ack === false &&
          kind === 'operations' &&
          name === 'core.events.ack'
        ) && manifest.has(kind, name),
    },
    get signal(): AbortSignal {
      return client.signal;
    },
    openStream: async (
      name,
      params,
      options,
    ): ReturnType<CanopyEventsConnection['openStream']> => {
      await overrides.beforeOpen?.();
      const { mapFrame } = overrides;
      const onFrame = options?.onFrame;
      const handle = await client.openStream(name, params, {
        ...options,
        onFrame:
          onFrame &&
          ((frame): void => onFrame(mapFrame ? mapFrame(frame) : frame)),
      });
      return {
        ...handle,
        openResult: {
          ...handle.openResult,
          acceptedCursor:
            overrides.acceptedCursor === undefined
              ? handle.openResult.acceptedCursor
              : overrides.acceptedCursor,
        },
      };
    },
    instruction: (name, params, options) =>
      client.instruction(name, params, options),
  };
};

describe('client event subscription edges over a fake framed daemon', () => {
  const cores: EventsCore[] = [];
  const subscriptions: CanopyEventSubscription[] = [];
  const gates: Gate[] = [];
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
  const hold = (): Gate => {
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = { promise, release };
    gates.push(gate);
    return gate;
  };
  afterEach(async () => {
    // close() awaits in-flight callbacks; never leave a deliberate gate shut.
    for (const gate of gates.splice(0)) gate.release();
    await Promise.all(subscriptions.splice(0).map((s) => s.close()));
    await Promise.all(cores.splice(0).map((s) => s.close()));
  });

  it('drains a frame arriving between an idle drain and its completion microtasks', async () => {
    const daemon = core();
    const client = await daemon.connect();
    const gate = hold();
    const handled: string[] = [];
    let deferred: (() => void) | undefined;
    const connection: CanopyEventsConnection = {
      identity: client.identity,
      manifest: client.manifest,
      signal: client.signal,
      openStream: (name, params, options) =>
        client.openStream(name, params, {
          ...options,
          onFrame: (frame): void => {
            if (frame.kind === 'item' && frame.cursor.sequence === 2)
              deferred = (): void => options?.onFrame?.(frame);
            else options?.onFrame?.(frame);
          },
        }),
      instruction: async (
        name,
        params,
        options,
      ): ReturnType<CanopyEventsConnection['instruction']> => {
        const result = await client.instruction(name, params, options);
        if (params.cursor.sequence === 1)
          queueMicrotask(() => queueMicrotask(() => deferred?.()));
        return result;
      },
    };
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: async (delivery) => {
        if (delivery.kind === 'event') handled.push(delivery.event.eventId);
        if (handled.length === 1) await gate.promise;
      },
    });
    await subscription.attach(connection);
    const first = await daemon.append('core.chat.started');
    const second = await daemon.append('core.chat.finished');
    await flush();
    expect(handled).toEqual([first.eventId]);
    gate.release();
    await flush();
    expect(handled).toEqual([first.eventId, second.eventId]);
    expect(subscription.cursor(AUTHORITY)).toEqual(second.cursor);
  });

  it('does not load or snapshot a client disconnected while waiting for the prior handler', async () => {
    const daemon = core();
    const gate = hold();
    const loads: string[] = [];
    const reasons: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: ({ reason }) => {
        reasons.push(reason);
        return Promise.resolve(null);
      },
      store: {
        load: (id) => {
          loads.push(id);
          return Promise.resolve(null);
        },
        save: () => {
          return Promise.resolve();
        },
      },
      handle: () => Promise.resolve(gate.promise),
    });
    await subscription.attach(await daemon.connect());
    await daemon.append('core.chat.status');
    await flush();
    const nextClient = await daemon.connect();
    const attaching = subscription.attach(nextClient);
    const result = expect(attaching).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    await nextClient.close();
    gate.release();
    await result;
    expect(reasons).toEqual(['initial']);
    expect(loads).toEqual([AUTHORITY]);
    expect(daemon.subscriptions).toHaveLength(1);
  });

  it('isolates classifier cursor edits from the event checkpoint', async () => {
    const daemon = core();
    const seen: number[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      classify: (event) => {
        event.cursor.sequence = 999;
        event.cursor.daemonEpoch = 'other';
        return 'lifecycle';
      },
      handle: (delivery) => {
        if (delivery.kind === 'event')
          seen.push(delivery.event.cursor.sequence);
        return Promise.resolve();
      },
    });
    await subscription.attach(await daemon.connect());
    const event = await daemon.append('core.chat.status');
    await flush();
    expect(seen).toEqual([event.cursor.sequence]);
    expect(subscription.cursor(AUTHORITY)).toEqual(event.cursor);
    expect(daemon.acknowledgements[0]?.cursor).toEqual(event.cursor);
  });

  it('isolates handler context and cursor-store edits from subsequent checkpoints', async () => {
    const daemon = core();
    const owners: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: (_delivery, context) => {
        context.authorityId = 'other';
        context.daemonEpoch = 'other';
        return Promise.resolve();
      },
      store: {
        load: () => Promise.resolve(null),
        save: (id, _key, cursor) => {
          owners.push(id);
          if (cursor) {
            cursor.sequence = 999;
            cursor.daemonEpoch = 'other';
          }
          return Promise.resolve();
        },
      },
    });
    await subscription.attach(await daemon.connect());
    const first = await daemon.append('core.chat.status');
    await flush();
    expect(subscription.cursor(AUTHORITY)).toEqual(first.cursor);
    const last = await daemon.append('core.chat.finished');
    await flush();
    expect(owners.every((id) => id === AUTHORITY)).toBe(true);
    expect(subscription.cursor(AUTHORITY)).toEqual(last.cursor);
    expect(daemon.acknowledgements.map((ack) => ack.cursor.sequence)).toEqual([
      1, 2,
    ]);
  });

  it.each([
    { daemonEpoch: 'epoch-1', sequence: 10 },
    { daemonEpoch: 'other', sequence: 0 },
  ])(
    'rejects a mismatched accepted checkpoint before buffered events are handled (%j)',
    async (acceptedCursor) => {
      const daemon = core();
      await daemon.append('core.chat.status');
      const seen: string[] = [];
      const subscription = subscribe({
        families: ['core.chat'],
        snapshot: () => Promise.resolve(null),
        handle: (delivery) => {
          if (delivery.kind === 'event') seen.push(delivery.event.eventId);
          return Promise.resolve();
        },
      });
      await expect(
        subscription.attach(wrap(await daemon.connect(), { acceptedCursor })),
      ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
      expect(seen).toEqual([]);
      expect(subscription.cursor(AUTHORITY)).toBeNull();
      expect(daemon.acknowledgements).toEqual([]);
    },
  );

  it('fails on an error end without details instead of silently detaching', async () => {
    const daemon = core();
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: () => Promise.resolve(),
    });
    await subscription.attach(
      wrap(await daemon.connect(), {
        mapFrame: (frame) => ({
          kind: 'end',
          cursor: frame.cursor,
          outcome: 'error',
          error: null,
        }),
      }),
    );
    await daemon.append('core.chat.status');
    await flush();
    expect(subscription.state(AUTHORITY)).toBe('failed');
    expect(subscription.error(AUTHORITY)).toMatchObject({
      payload: { kind: 'internal' },
    });
    expect(daemon.acknowledgements).toEqual([]);
  });

  it('halts on a cursor-store save failure without advancing or wire-acking', async () => {
    const daemon = core();
    const handled: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => Promise.resolve(null),
      handle: (delivery) => {
        if (delivery.kind === 'event') handled.push(delivery.event.eventId);

        return Promise.resolve();
      },
      store: {
        load: () => Promise.resolve(null),
        save: (_authority, _key, cursor) => {
          if (cursor) throw new Error('store offline');

          return Promise.resolve();
        },
      },
    });
    await subscription.attach(await daemon.connect());
    const event = await daemon.append('core.chat.status');
    await flush();
    expect(handled).toEqual([event.eventId]);
    expect(subscription.state(AUTHORITY)).toBe('failed');
    expect(subscription.error(AUTHORITY)?.message).toBe('store offline');
    expect(subscription.cursor(AUTHORITY)).toBeNull();
    expect(daemon.acknowledgements).toHaveLength(0);
    await daemon.append('core.chat.finished');
    await flush();
    expect(handled).toEqual([event.eventId]);
    expect(daemon.acknowledgements).toHaveLength(0);
  });

  it('serializes a same-authority reattach behind a pending handler; the zombie result never advances or acks', async () => {
    const daemon = core();
    const gate = hold();
    const handled: string[] = [];
    const saves: (number | null)[] = [];
    let snapshots = 0;
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => {
        snapshots += 1;
        return Promise.resolve(null);
      },
      handle: async (delivery) => {
        if (delivery.kind === 'event') handled.push(delivery.event.eventId);
        if (handled.length === 1) await gate.promise;
      },
      store: {
        load: () => Promise.resolve(null),
        save: (_a, _k, cursor) => {
          saves.push(cursor?.sequence ?? null);

          return Promise.resolve();
        },
      },
    });
    await subscription.attach(await daemon.connect());
    const event = await daemon.append('core.chat.status');
    await flush();
    expect(handled).toEqual([event.eventId]);
    let reattached: Promise<void> = Promise.resolve();
    try {
      reattached = subscription.attach(await daemon.connect());
      await flush();
      expect(snapshots).toBe(1);
      expect(daemon.subscriptions).toHaveLength(1);
    } finally {
      gate.release();
    }
    await reattached;
    await flush();
    expect(snapshots).toBe(2);
    expect(daemon.subscriptions).toHaveLength(2);
    expect(daemon.subscriptions[1]?.cursor).toBeNull();
    // Each snapshot clears the checkpoint, then persists its (null) result.
    expect(saves).toEqual([null, null, null, null, event.cursor.sequence]);
    expect(handled).toEqual([event.eventId, event.eventId]);
    expect(daemon.acknowledgements.map((ack) => ack.subscriptionId)).toEqual([
      'events-sub-2',
    ]);
    expect(subscription.cursor(AUTHORITY)).toEqual(event.cursor);
    expect(subscription.state(AUTHORITY)).toBe('open');
  });

  it('serializes a same-authority reattach behind a pending cursor save; the zombie save never acks or sets the cursor', async () => {
    const daemon = core();
    const gate = hold();
    const saves: (number | null)[] = [];
    let snapshots = 0;
    let observedAtReattach: CanopyStreamCursor | null = null;
    const subscription = subscribe({
      families: ['core.chat'],
      snapshot: () => {
        snapshots += 1;
        return Promise.resolve(null);
      },
      handle: () => {
        return Promise.resolve();
      },
      store: {
        load: () => Promise.resolve(null),
        save: async (_a, _k, cursor) => {
          saves.push(cursor?.sequence ?? null);
          if (cursor && saves.filter((s) => s !== null).length === 1)
            await gate.promise;
        },
      },
    });
    await subscription.attach(await daemon.connect());
    const event = await daemon.append('core.chat.status');
    await flush();
    expect(saves).toEqual([null, null, event.cursor.sequence]);
    let reattached: Promise<void> = Promise.resolve();
    try {
      reattached = subscription.attach(await daemon.connect());
      await flush();
      expect(snapshots).toBe(1);
      expect(daemon.subscriptions).toHaveLength(1);
    } finally {
      gate.release();
    }
    await reattached;
    observedAtReattach = daemon.subscriptions[1]?.cursor ?? null;
    await flush();
    expect(observedAtReattach).toBeNull();
    expect(snapshots).toBe(2);
    expect(saves).toEqual([
      null,
      null,
      event.cursor.sequence,
      null,
      null,
      event.cursor.sequence,
    ]);
    expect(daemon.acknowledgements.map((ack) => ack.subscriptionId)).toEqual([
      'events-sub-2',
    ]);
    expect(subscription.cursor(AUTHORITY)).toEqual(event.cursor);
  });

  it('persists independent canonical cursors per family/scope filter and resumes an equivalent filter', async () => {
    const daemon = core();
    const records = new Map<string, CanopyStreamCursor | null>();
    const store = {
      load: (
        authority: string,
        key: string,
      ): Promise<CanopyStreamCursor | null> =>
        Promise.resolve(records.get(`${authority}|${key}`) ?? null),
      save: (
        authority: string,
        key: string,
        cursor: CanopyStreamCursor | null,
      ): Promise<void> => {
        records.set(`${authority}|${key}`, cursor);

        return Promise.resolve();
      },
    };
    const reasons: string[] = [];
    const snapshot = ({ reason }: { reason: string }): Promise<null> => {
      reasons.push(reason);
      return Promise.resolve(null);
    };
    const chat = subscribe({
      families: ['core.chat'],
      scope: { workspaceId: 'w1', chatId: 'c1' },
      store,
      snapshot,
      handle: () => {
        return Promise.resolve();
      },
    });
    const terminal = subscribe({
      families: ['core.terminal'],
      store,
      snapshot,
      handle: () => {
        return Promise.resolve();
      },
    });
    await chat.attach(await daemon.connect());
    await terminal.attach(await daemon.connect());
    const chatEvent = await daemon.append(
      'core.chat.status',
      {},
      { workspaceId: 'w1', chatId: 'c1' },
    );
    await daemon.append(
      'core.chat.status',
      {},
      { workspaceId: 'w1', chatId: 'other' },
    );
    const terminalEvent = await daemon.append('core.terminal.output');
    await flush();
    expect(records.size).toBe(2);
    expect(Array.from(records.values())).toEqual(
      expect.arrayContaining([chatEvent.cursor, terminalEvent.cursor]),
    );
    expect(chat.cursor(AUTHORITY)).toEqual(chatEvent.cursor);
    expect(terminal.cursor(AUTHORITY)).toEqual(terminalEvent.cursor);
    await chat.close();

    const equivalent = subscribe({
      families: ['core.chat', 'core.chat'],
      scope: { chatId: 'c1', workspaceId: 'w1' },
      store,
      snapshot,
      handle: () => {
        return Promise.resolve();
      },
    });
    await equivalent.attach(await daemon.connect());
    expect(records.size).toBe(2);
    expect(reasons).toEqual(['initial', 'initial']);
    expect(daemon.subscriptions.at(-1)?.cursor).toEqual(chatEvent.cursor);
  });

  it.each(['open', 'end'] as const)(
    'bounds repeated %s snapshot_required recovery against a persistently stale checkpoint',
    async (snapshotRequired) => {
      const daemon = core({ snapshotRequired });
      await daemon.append('core.chat.status');
      await daemon.append('core.chat.status');
      daemon.expireThrough(2);
      const stale: CanopyStreamCursor = { daemonEpoch: 'epoch-1', sequence: 1 };
      const reasons: string[] = [];
      const handle = jest.fn(() => {
        return Promise.resolve();
      });
      const subscription = subscribe({
        families: ['core.chat'],
        maxSnapshotAttempts: 2,
        handle,
        store: {
          load: () => Promise.resolve(stale),
          save: () => {
            return Promise.resolve();
          },
        },
        snapshot: ({ reason }) => {
          reasons.push(reason);
          return Promise.resolve(stale);
        },
      });
      const attached = subscription.attach(await daemon.connect());
      await expect(attached).rejects.toMatchObject({
        payload: { kind: 'resource_exhausted' },
      });
      await flush();
      expect(reasons).toEqual(['snapshot_required', 'snapshot_required']);
      expect(daemon.subscriptions).toHaveLength(3);
      expect(subscription.state(AUTHORITY)).toBe('failed');
      expect(subscription.error(AUTHORITY)?.message).toBe(
        'Snapshot recovery did not converge.',
      );
      await flush();
      expect(daemon.subscriptions).toHaveLength(3);
      expect(handle).not.toHaveBeenCalled();
      expect(daemon.acknowledgements).toHaveLength(0);
    },
  );

  it('closes cleanly during a pending snapshot without persisting or subscribing', async () => {
    const daemon = core();
    const gate = hold();
    const saves: (number | null)[] = [];
    let entered = false;
    const subscription = subscribe({
      families: ['core.chat'],
      handle: () => {
        return Promise.resolve();
      },
      store: {
        load: () => Promise.resolve(null),
        save: (_a, _k, cursor) => {
          saves.push(cursor?.sequence ?? null);

          return Promise.resolve();
        },
      },
      snapshot: async () => {
        entered = true;
        await gate.promise;
        return daemon.cursor();
      },
    });
    const attached = subscription.attach(await daemon.connect());
    let closing: Promise<void> = Promise.resolve();
    try {
      await flush();
      expect(entered).toBe(true);
      closing = subscription.close();
    } finally {
      gate.release();
    }
    await attached;
    await closing;
    expect(saves).toEqual([null]);
    expect(daemon.subscriptions).toHaveLength(0);
    expect(subscription.state(AUTHORITY)).toBe('detached');
    await expect(
      subscription.attach(await daemon.connect()),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
  });

  it('aborts cleanly while the stream open is pending and delivers nothing afterwards', async () => {
    const daemon = core();
    const gate = hold();
    const controller = new AbortController();
    let opening = false;
    const handle = jest.fn(() => {
      return Promise.resolve();
    });
    const subscription = subscribe({
      families: ['core.chat'],
      signal: controller.signal,
      snapshot: () => Promise.resolve(null),
      handle,
    });
    const attached = subscription.attach(
      wrap(await daemon.connect(), {
        beforeOpen: async () => {
          opening = true;
          await gate.promise;
        },
      }),
    );
    try {
      await flush();
      expect(opening).toBe(true);
      controller.abort();
    } finally {
      gate.release();
    }
    await attached;
    await flush();
    expect(subscription.state(AUTHORITY)).toBe('detached');
    await daemon.append('core.chat.status');
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(daemon.acknowledgements).toHaveLength(0);
    expect(subscription.cursor(AUTHORITY)).toBeNull();
  });

  describe('foreign, malformed, or missing identity and cursors', () => {
    it('rejects a null authority before loading, snapshotting, or subscribing', async () => {
      const daemon = core();
      const load = jest.fn(() => Promise.resolve(null));
      const snapshot = jest.fn(() => Promise.resolve(null));
      const subscription = subscribe({
        families: ['core.chat'],
        snapshot,
        handle: () => {
          return Promise.resolve();
        },
        store: {
          load,
          save: () => {
            return Promise.resolve();
          },
        },
      });
      await expect(
        subscription.attach(
          wrap(await daemon.connect(), { authorityId: null }),
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'failed_precondition' },
      });
      expect(load).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(daemon.subscriptions).toHaveLength(0);
    });

    it('fails closed on a malformed stored cursor without overwriting it', async () => {
      const daemon = core();
      const save = jest.fn(() => {
        return Promise.resolve();
      });
      const snapshot = jest.fn(() => Promise.resolve(null));
      const subscription = subscribe({
        families: ['core.chat'],
        snapshot,
        handle: () => {
          return Promise.resolve();
        },
        store: {
          load: () => Promise.resolve({ daemonEpoch: 'epoch-1', sequence: -1 }),
          save,
        },
      });
      await expect(
        subscription.attach(await daemon.connect()),
      ).rejects.toThrow();
      expect(subscription.state(AUTHORITY)).toBe('failed');
      expect(save).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(daemon.subscriptions).toHaveLength(0);
    });

    it('rejects a snapshot checkpoint from another daemon epoch without persisting it', async () => {
      const daemon = core();
      const saves: (CanopyStreamCursor | null)[] = [];
      const subscription = subscribe({
        families: ['core.chat'],
        handle: () => {
          return Promise.resolve();
        },
        store: {
          load: () => Promise.resolve(null),
          save: (_a, _k, cursor) => {
            saves.push(cursor);

            return Promise.resolve();
          },
        },
        snapshot: () =>
          Promise.resolve({ daemonEpoch: 'epoch-foreign', sequence: 0 }),
      });
      await expect(
        subscription.attach(await daemon.connect()),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          message: 'Snapshot cursor belongs to another daemon epoch.',
        },
      });
      expect(saves).toEqual([null]);
      expect(daemon.subscriptions).toHaveLength(0);
      expect(subscription.cursor(AUTHORITY)).toBeNull();
    });

    it.each([
      [
        'a stream cursor that disagrees with its event',
        (frame: CanopyEventFrame): CanopyEventFrame =>
          frame.kind === 'item'
            ? {
                ...frame,
                cursor: {
                  ...frame.cursor,
                  sequence: frame.cursor.sequence + 1,
                },
              }
            : frame,
      ],
      [
        'a consistently foreign epoch',
        (frame: CanopyEventFrame): CanopyEventFrame => {
          if (frame.kind !== 'item') return frame;
          const cursor = { ...frame.cursor, daemonEpoch: 'epoch-foreign' };
          return { ...frame, cursor, item: { ...frame.item, cursor } };
        },
      ],
    ])(
      'halts on %s without handling, advancing, or acking',
      async (_label, mapFrame) => {
        const daemon = core();
        const handle = jest.fn(() => {
          return Promise.resolve();
        });
        const subscription = subscribe({
          families: ['core.chat'],
          snapshot: () => Promise.resolve(null),
          handle,
        });
        await subscription.attach(wrap(await daemon.connect(), { mapFrame }));
        await daemon.append('core.chat.status');
        await flush();
        expect(subscription.state(AUTHORITY)).toBe('failed');
        expect(handle).not.toHaveBeenCalled();
        expect(subscription.cursor(AUTHORITY)).toBeNull();
        expect(daemon.acknowledgements).toHaveLength(0);
      },
    );

    it('rejects a connection without acknowledgement capability before any snapshot or subscribe', async () => {
      const daemon = core();
      const saves: (number | null)[] = [];
      const subscription = subscribe({
        families: ['core.chat'],
        snapshot: () => Promise.resolve(null),
        handle: () => {
          return Promise.resolve();
        },
        store: {
          load: () => Promise.resolve(null),
          save: (_a, _k, cursor) => {
            saves.push(cursor?.sequence ?? null);

            return Promise.resolve();
          },
        },
      });
      await expect(
        subscription.attach(wrap(await daemon.connect(), { ack: false })),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(saves).toEqual([]);
      expect(daemon.subscriptions).toHaveLength(0);
      expect(subscription.cursor(AUTHORITY)).toBeNull();
      expect(daemon.acknowledgements).toHaveLength(0);
    });
  });

  it('records an epoch change even when the previous snapshot has no cursor', async () => {
    const daemon = core();
    const reasons: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      handle: () => {
        return Promise.resolve();
      },
      snapshot: ({ reason }) => {
        reasons.push(reason);
        return Promise.resolve(null);
      },
    });
    await subscription.attach(await daemon.connect());
    daemon.restart('epoch-2');
    await subscription.attach(await daemon.connect());
    expect(reasons).toEqual(['initial', 'epoch_changed']);
  });

  it('fails on maxPendingEvents overload with slow in-flight output and never acks past the omitted lifecycle event', async () => {
    const daemon = core();
    const gate = hold();
    const handled: string[] = [];
    const subscription = subscribe({
      families: ['core.chat'],
      maxPendingEvents: 2,
      snapshot: () => Promise.resolve(null),
      classify: (event) =>
        event.name.endsWith('.output') ? 'output' : 'lifecycle',
      handle: async (delivery) => {
        if (delivery.kind !== 'event') return;
        handled.push(delivery.event.name);
        if (delivery.event.name === 'core.chat.output' && handled.length === 2)
          await gate.promise;
      },
    });
    await subscription.attach(await daemon.connect());
    const started = await daemon.append('core.chat.started');
    await flush();
    expect(daemon.acknowledgements.map((ack) => ack.cursor)).toEqual([
      started.cursor,
    ]);
    let omitted: CanopyStreamCursor = started.cursor;
    try {
      await daemon.append('core.chat.output');
      await daemon.append('core.chat.output');
      omitted = (await daemon.append('core.chat.finished')).cursor;
      await flush();
      expect(subscription.state(AUTHORITY)).toBe('failed');
      expect(subscription.error(AUTHORITY)).toMatchObject({
        payload: { kind: 'resource_exhausted' },
      });
    } finally {
      gate.release();
    }
    await flush();
    expect(handled).toEqual(['core.chat.started', 'core.chat.output']);
    expect(subscription.cursor(AUTHORITY)).toEqual(started.cursor);
    expect(
      Math.max(...daemon.acknowledgements.map((ack) => ack.cursor.sequence)),
    ).toBeLessThan(omitted.sequence);
    expect(daemon.acknowledgements.map((ack) => ack.cursor)).toEqual([
      started.cursor,
    ]);

    // Reattaching resumes from the durable cursor, so the omitted lifecycle event is redelivered.
    await subscription.attach(await daemon.connect());
    await flush();
    expect(daemon.subscriptions.at(-1)?.cursor).toEqual(started.cursor);
    // Lifecycle may preempt queued output, so only the redelivered set is stable.
    expect([...handled.slice(2)].sort()).toEqual([
      'core.chat.finished',
      'core.chat.output',
      'core.chat.output',
    ]);
    expect(subscription.cursor(AUTHORITY)).toEqual(omitted);
  });
});
