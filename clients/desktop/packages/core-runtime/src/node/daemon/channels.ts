import type { CanopyByteChannel } from '@canopy/core-transport/types';
import type {
  CanopyCallerDescriptor,
  CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';

import type {
  CanopyClientLeaseView,
  CanopyLeaseEnd,
  CanopyLeaseRegistry,
} from './leases';

export interface CanopyChannelContext {
  readonly connectionId: string;
  readonly lease: CanopyClientLeaseView;
  readonly caller: CanopyCallerDescriptor;
}

export interface CanopyChannelKindOptions {
  /** Grants needed, besides `core.client.manage`, to see and open this kind. */
  readonly requiredGrants?: readonly string[];
  /** Takes each accepted channel. No consumer ships before W6. */
  accept(channel: CanopyByteChannel, context: CanopyChannelContext): void;
}

export interface CanopyChannelOptions {
  /** Accepted kinds; none by default, so every open is refused. */
  readonly kinds?: Readonly<Record<string, CanopyChannelKindOptions>>;
  /** Open channels per lease; default 8. */
  readonly maxChannelsPerLease?: number;
}

export const CANOPY_DEFAULT_MAX_CHANNELS_PER_LEASE = 8;

export interface CanopyChannelRegistry {
  readonly maxChannelsPerLease: number;
  /** Lease and per-lease cap checks for an open on `connectionId`. */
  admit(connectionId: string, leaseId: string): CanopyErrorPayload | null;
  /** Counts an accepted channel under its lease until the channel closes. */
  track(connectionId: string, channel: CanopyByteChannel): boolean;
  count(leaseId: string): number;
  close(): void;
}

const NEVER: CanopyErrorPayload['retry'] = { kind: 'never' };

const LEASE_NOT_HELD: CanopyErrorPayload = {
  kind: 'not_found',
  code: 'core.client.lease.notFound',
  message: "Open channels with this connection's live client lease.",
  retry: NEVER,
};

const LEASE_MOVED: CanopyErrorPayload = {
  kind: 'failed_precondition',
  code: 'core.client.lease.invalidState',
  message: 'The lease moved to another connection.',
  retry: NEVER,
};

const PLANE_CLOSED: CanopyErrorPayload = {
  kind: 'cancelled',
  message: 'The daemon control plane is closed.',
  retry: NEVER,
};

const LEASE_ENDED: Readonly<Record<CanopyLeaseEnd, CanopyErrorPayload>> = {
  released: {
    kind: 'cancelled',
    message: "The channel's lease was released.",
    retry: NEVER,
  },
  evicted: {
    kind: 'not_found',
    code: 'core.client.lease.notFound',
    message: "The channel's lease was evicted.",
    retry: NEVER,
  },
};

/**
 * Binds bulk channels to the connection-bound lease that admitted them: a
 * release, eviction or rebind elsewhere closes them.
 */
export function createCanopyChannelRegistry(
  leases: CanopyLeaseRegistry,
  options: { readonly maxChannelsPerLease: number },
): CanopyChannelRegistry {
  const { maxChannelsPerLease } = options;
  if (!Number.isSafeInteger(maxChannelsPerLease) || maxChannelsPerLease < 1)
    throw new RangeError('maxChannelsPerLease must be a positive integer.');
  /** leaseId → channel → the connection it was opened on. */
  const byLease = new Map<string, Map<CanopyByteChannel, string>>();
  let closed = false;

  const untrack = (channel: CanopyByteChannel): void => {
    const channels = byLease.get(channel.leaseId);
    if (!channels?.delete(channel)) return;
    if (channels.size === 0) byLease.delete(channel.leaseId);
  };
  const closeWhere = (
    leaseId: string,
    error: CanopyErrorPayload,
    matches: (connectionId: string) => boolean = () => true,
  ): void => {
    for (const [channel, connectionId] of Array.from(
      byLease.get(leaseId) ?? [],
    ))
      if (matches(connectionId)) {
        untrack(channel);
        channel.close(error);
      }
  };

  const offEnd = leases.onEnd((lease, end) =>
    closeWhere(lease.leaseId, LEASE_ENDED[end]),
  );
  // `onEnd` has already closed an ended lease's channels; what remains here
  // is a live lease rebound to another connection.
  const offChange = leases.onChange(() => {
    for (const leaseId of Array.from(byLease.keys())) {
      const holder = leases.holder(leaseId);
      closeWhere(leaseId, LEASE_MOVED, (owner) => owner !== holder);
    }
  });

  return {
    maxChannelsPerLease,
    admit(connectionId, leaseId): CanopyErrorPayload | null {
      if (closed) return PLANE_CLOSED;
      if (leases.lease(connectionId)?.leaseId !== leaseId)
        return LEASE_NOT_HELD;
      if ((byLease.get(leaseId)?.size ?? 0) >= maxChannelsPerLease)
        return {
          kind: 'resource_exhausted',
          message: `The lease already has ${maxChannelsPerLease} open channels.`,
          details: { maxChannelsPerLease },
          retry: NEVER,
        };
      return null;
    },
    track(connectionId, channel): boolean {
      const holder = leases.holder(channel.leaseId);
      if (closed || holder !== connectionId) {
        channel.close(
          closed
            ? PLANE_CLOSED
            : holder === null
              ? LEASE_NOT_HELD
              : LEASE_MOVED,
        );
        return false;
      }
      if (channel.signal.aborted) return false;
      const channels =
        byLease.get(channel.leaseId) ?? new Map<CanopyByteChannel, string>();
      byLease.set(channel.leaseId, channels.set(channel, connectionId));
      channel.signal.addEventListener('abort', () => untrack(channel), {
        once: true,
      });
      return true;
    },
    count: (leaseId) => byLease.get(leaseId)?.size ?? 0,
    close(): void {
      if (closed) return;
      closed = true;
      offEnd();
      offChange();
      for (const leaseId of Array.from(byLease.keys()))
        closeWhere(leaseId, PLANE_CLOSED);
    },
  };
}
