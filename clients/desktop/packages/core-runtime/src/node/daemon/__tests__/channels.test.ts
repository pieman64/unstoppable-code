import type {
  CanopyErrorPayload,
  CanopySchemaOutput,
  CoreClientLeaseAcquireParamsSchema,
} from '@canopy/protocol/canopy-core';
import type { CanopyByteChannel } from '@canopy/core-transport/types';

import {
  createCanopyChannelRegistry,
  type CanopyChannelRegistry,
} from '../channels';
import {
  createCanopyLeaseRegistry,
  type CanopyDaemonClock,
  type CanopyLeaseRegistry,
} from '../leases';

type AcquireParams = CanopySchemaOutput<
  typeof CoreClientLeaseAcquireParamsSchema
>;

function manualClock(): CanopyDaemonClock & { advance(ms: number): void } {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer(run, delayMs): { cancel(): void } {
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return { cancel: () => void timers.delete(timer) };
    },
    advance(ms): void {
      now += ms;
      for (const timer of Array.from(timers).sort((a, b) => a.at - b.at))
        if (timer.at <= now && timers.delete(timer)) timer.run();
    },
  };
}

let key = 0;
function params(overrides: Partial<AcquireParams> = {}): AcquireParams {
  return {
    clientInstanceId: 'client-1',
    interfaceKind: 'desktop',
    label: 'Desktop',
    interactive: true,
    foreground: true,
    renewalIntervalMs: 15_000,
    _meta: { idempotencyKey: `channel-${(key += 1)}` },
    ...overrides,
  };
}

function fakeChannel(
  leaseId: string,
  channelId: string,
): {
  readonly channel: CanopyByteChannel;
  readonly abort: () => void;
  readonly closeCount: () => number;
  readonly closeError: () => CanopyErrorPayload | undefined;
} {
  const controller = new AbortController();
  let closes = 0;
  let error: CanopyErrorPayload | undefined;
  return {
    channel: {
      channelId,
      kind: 'test.bulk',
      leaseId,
      caps: { maxChunkBytes: 1, maxBufferedChunks: 1 },
      signal: controller.signal,
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      close(payload): void {
        if (controller.signal.aborted) return;
        closes += 1;
        error = payload;
        controller.abort();
      },
    },
    abort: () => controller.abort(),
    closeCount: () => closes,
    closeError: () => error,
  };
}

function setup(maxChannelsPerLease = 2): {
  readonly clock: ReturnType<typeof manualClock>;
  readonly leases: CanopyLeaseRegistry;
  readonly channels: CanopyChannelRegistry;
} {
  const clock = manualClock();
  const leases = createCanopyLeaseRegistry({}, clock);
  const channels = createCanopyChannelRegistry(leases, { maxChannelsPerLease });
  return { clock, leases, channels };
}

describe('daemon channel registry', () => {
  it('refuses opens without the connection lease before checking its cap', () => {
    const { leases, channels } = setup(1);
    const lease = leases.acquire('connection-a', params());
    const tracked = fakeChannel(lease.leaseId, 'channel-a');
    channels.track('connection-a', tracked.channel);

    expect(channels.admit('connection-a', 'wrong-lease')).toMatchObject({
      kind: 'not_found',
      code: 'core.client.lease.notFound',
      message: "Open channels with this connection's live client lease.",
      retry: { kind: 'never' },
    });
    expect(channels.admit('missing-connection', lease.leaseId)).toMatchObject({
      kind: 'not_found',
      code: 'core.client.lease.notFound',
    });
    expect(channels.admit('connection-a', lease.leaseId)).toMatchObject({
      kind: 'resource_exhausted',
      message: 'The lease already has 1 open channels.',
      details: { maxChannelsPerLease: 1 },
      retry: { kind: 'never' },
    });
  });

  it('reuses a per-lease slot after a channel aborts', () => {
    const { leases, channels } = setup(1);
    const lease = leases.acquire('connection-a', params());
    const first = fakeChannel(lease.leaseId, 'channel-a');
    channels.track('connection-a', first.channel);
    expect(channels.count(lease.leaseId)).toBe(1);

    first.abort();

    expect(channels.count(lease.leaseId)).toBe(0);
    expect(channels.admit('connection-a', lease.leaseId)).toBeNull();
  });

  it('isolates caps between leases', () => {
    const { leases, channels } = setup(1);
    const firstLease = leases.acquire('connection-a', params());
    const secondLease = leases.acquire(
      'connection-b',
      params({ clientInstanceId: 'client-2' }),
    );
    channels.track(
      'connection-a',
      fakeChannel(firstLease.leaseId, 'channel-a').channel,
    );

    expect(channels.count(firstLease.leaseId)).toBe(1);
    expect(channels.count(secondLease.leaseId)).toBe(0);
    expect(channels.admit('connection-b', secondLease.leaseId)).toBeNull();
  });

  it('closes channels as cancelled when their lease is released', () => {
    const { leases, channels } = setup();
    const lease = leases.acquire('connection-a', params());
    const tracked = fakeChannel(lease.leaseId, 'channel-a');
    channels.track('connection-a', tracked.channel);

    expect(leases.release('connection-a')).toBe(true);

    expect(tracked.closeError()).toEqual({
      kind: 'cancelled',
      message: "The channel's lease was released.",
      retry: { kind: 'never' },
    });
    expect(channels.count(lease.leaseId)).toBe(0);
  });

  it('closes channels as notFound when their lease expires', () => {
    const { clock, leases, channels } = setup();
    const lease = leases.acquire('connection-a', params());
    const tracked = fakeChannel(lease.leaseId, 'channel-a');
    channels.track('connection-a', tracked.channel);

    clock.advance(60_000);

    expect(tracked.closeError()).toEqual({
      kind: 'not_found',
      code: 'core.client.lease.notFound',
      message: "The channel's lease was evicted.",
      retry: { kind: 'never' },
    });
    expect(channels.count(lease.leaseId)).toBe(0);
  });

  it('closes only the previous connection channels when a lease is rebound', () => {
    const { leases, channels } = setup();
    const lease = leases.acquire('connection-a', params());
    const oldConnection = fakeChannel(lease.leaseId, 'channel-a');
    channels.track('connection-a', oldConnection.channel);

    leases.acquire('connection-b', params({ previousLeaseId: lease.leaseId }));
    const newConnection = fakeChannel(lease.leaseId, 'channel-b');
    channels.track('connection-b', newConnection.channel);

    expect(oldConnection.closeError()).toEqual({
      kind: 'failed_precondition',
      code: 'core.client.lease.invalidState',
      message: 'The lease moved to another connection.',
      retry: { kind: 'never' },
    });
    expect(newConnection.closeCount()).toBe(0);
    expect(channels.count(lease.leaseId)).toBe(1);
  });

  it('closes tracked channels and unsubscribes from lease events on close', () => {
    const leases = createCanopyLeaseRegistry({}, manualClock());
    const stopEnd = jest.fn();
    const stopChange = jest.fn();
    const onEnd = leases.onEnd.bind(leases);
    const onChange = leases.onChange.bind(leases);
    jest.spyOn(leases, 'onEnd').mockImplementation((listener) => {
      const unsubscribe = onEnd(listener);
      return (): void => {
        stopEnd();
        unsubscribe();
      };
    });
    jest.spyOn(leases, 'onChange').mockImplementation((listener) => {
      const unsubscribe = onChange(listener);
      return (): void => {
        stopChange();
        unsubscribe();
      };
    });
    const channels = createCanopyChannelRegistry(leases, {
      maxChannelsPerLease: 2,
    });
    const lease = leases.acquire('connection-a', params());
    const tracked = fakeChannel(lease.leaseId, 'channel-a');
    channels.track('connection-a', tracked.channel);

    channels.close();
    leases.release('connection-a');

    expect(tracked.closeCount()).toBe(1);
    expect(channels.count(lease.leaseId)).toBe(0);
    expect(stopEnd).toHaveBeenCalledTimes(1);
    expect(stopChange).toHaveBeenCalledTimes(1);
  });

  it('requires a positive safe integer channel cap', () => {
    const leases = createCanopyLeaseRegistry();
    for (const maxChannelsPerLease of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        createCanopyChannelRegistry(leases, { maxChannelsPerLease }),
      ).toThrow(RangeError);
  });
});
