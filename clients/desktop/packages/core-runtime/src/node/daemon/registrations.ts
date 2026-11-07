import { APP_LEASE_STREAM_LIMIT, DEFAULT_LEASE_STREAM_LIMIT } from './limits';
import { createHash } from 'node:crypto';
import type {
  CoreClientCapabilitiesRegisterParamsSchema,
  CoreClientCapabilitiesRegisterResult,
  CoreClientLeaseEvicted,
  CanopySchemaOutput,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyLeaseRegistry } from './leases';

type Params = CanopySchemaOutput<
  typeof CoreClientCapabilitiesRegisterParamsSchema
>;
type Stream = {
  method: string;
  owner: string | null;
  requestId: string;
  controller: AbortController;
  close?: () => void;
};
type Owned = {
  capabilities: Params['capabilities'];
  revision: number;
  keys: Map<
    string,
    { hash: string; result: CoreClientCapabilitiesRegisterResult }
  >;
  streams: Set<Stream>;
};

type Disposition = {
  releasedRegistrationCount: number;
  failedRequestIds: string[];
};
type StreamRegistration = {
  signal: AbortSignal;
  attach(close: () => void): void;
  finish(disconnected: boolean): void;
};

const missing = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'not_found',
    message: 'This registration requires a live client lease.',
    retry: { kind: 'never' },
  });
const exhausted = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'resource_exhausted',
    message: 'The lease registration limit was reached.',
    retry: { kind: 'never' },
  });

/** Metadata declarations never install operations or change caller grants. */
export function createCanopyLeaseRegistrations(leases: CanopyLeaseRegistry): {
  register(
    connectionId: string,
    params: Params,
  ): CoreClientCapabilitiesRegisterResult;
  disposition(connectionId: string): Disposition;
  beginStream(
    connectionId: string,
    method: string,
    requestId: string,
  ): StreamRegistration;
  onEvicted(listener: (event: CoreClientLeaseEvicted) => void): () => void;
  close(): void;
} {
  const owned = new Map<string, Owned>();
  const listeners = new Set<(event: CoreClientLeaseEvicted) => void>();
  const count = (group: Owned | undefined): number =>
    group ? group.capabilities.length + group.streams.size : 0;
  const stop = (stream: Stream): void => {
    const close = stream.close;
    stream.close = undefined;
    stream.owner = null;
    try {
      close?.();
    } catch {
      /* One failed disposer must not strand other registrations. */
    }
    stream.controller.abort(missing());
  };
  const requireOwner = (
    connectionId: string,
  ): { leaseId: string; group: Owned; streamLimit: number } => {
    const lease = leases.lease(connectionId);
    if (!lease) throw missing();
    let group = owned.get(lease.leaseId);
    if (!group) {
      group = {
        capabilities: [],
        revision: 0,
        keys: new Map(),
        streams: new Set(),
      };
      owned.set(lease.leaseId, group);
    }
    return {
      leaseId: lease.leaseId,
      group,
      streamLimit:
        lease.interfaceKind === 'desktop'
          ? APP_LEASE_STREAM_LIMIT
          : DEFAULT_LEASE_STREAM_LIMIT,
    };
  };
  const offEnd = leases.onEnd((lease, end) => {
    const group = owned.get(lease.leaseId);
    const releasedRegistrationCount = count(group);
    owned.delete(lease.leaseId);
    group?.streams.forEach(stop);
    if (end === 'evicted') {
      const event: CoreClientLeaseEvicted = {
        leaseId: lease.leaseId,
        reason: 'expired',
        releasedRegistrationCount,
      };
      listeners.forEach((listener) => {
        try {
          listener(event);
        } catch {
          /* Isolate observers. */
        }
      });
    }
  });
  const offChange = leases.onChange(() => {
    for (const [id, group] of Array.from(owned)) {
      const holder = leases.holder(id);
      const lease = holder === null ? null : leases.lease(holder);
      const limit =
        lease?.interfaceKind === 'desktop'
          ? APP_LEASE_STREAM_LIMIT
          : DEFAULT_LEASE_STREAM_LIMIT;
      for (const [index, stream] of Array.from(group.streams).entries()) {
        if (stream.owner !== null && stream.owner !== holder) stop(stream);
        // A resumed lease can change interface kind; retained slots must not
        // bypass its new bound, even when the connection stays the same.
        if (lease && index >= limit) {
          group.streams.delete(stream);
          stop(stream);
        }
      }
    }
  });
  return {
    register(connectionId, params): CoreClientCapabilitiesRegisterResult {
      const { group } = requireOwner(connectionId);
      const names = params.capabilities.map(({ name }) => name);
      if (new Set(names).size !== names.length)
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'Capability names must be unique.',
          retry: { kind: 'never' },
        });
      const hash = createHash('sha256')
        .update(stableStringify(params.capabilities))
        .digest('hex');
      const key = params._meta.idempotencyKey;
      const prior = group.keys.get(key);
      if (prior) {
        if (prior.hash !== hash)
          throw new CanopyOperationError({
            kind: 'conflict',
            code: 'core.client.capabilities.revisionConflict',
            message:
              'The registration key was used with different capabilities.',
            retry: {
              kind: 'after_refresh',
              resource: 'core.client.capabilities',
            },
          });
        return prior.result;
      }
      if (group.keys.size >= 32) throw exhausted();
      group.capabilities = params.capabilities;
      const result = {
        registrationRevision: ++group.revision,
        effectiveCapabilities: names,
      };
      group.keys.set(key, { hash, result });
      return result;
    },
    disposition(connectionId): Disposition {
      const lease = leases.lease(connectionId);
      const group = lease ? owned.get(lease.leaseId) : undefined;
      return {
        releasedRegistrationCount: count(group),
        failedRequestIds: Array.from(group?.streams ?? [])
          .filter((stream) => stream.owner !== null && !stream.close)
          .map(({ requestId }) => requestId),
      };
    },
    beginStream(connectionId, method, requestId): StreamRegistration {
      const { leaseId, group, streamLimit } = requireOwner(connectionId);
      // Reopen one detached logical subscription; the new request owns its cursor and delivery handle.
      const retained = Array.from(group.streams).find(
        (stream) => stream.owner === null && stream.method === method,
      );
      if (!retained && group.streams.size >= streamLimit) throw exhausted();
      const stream: Stream = {
        method,
        requestId,
        owner: connectionId,
        controller: new AbortController(),
      };
      if (retained) group.streams.delete(retained);
      group.streams.add(stream);
      const live = (): boolean =>
        owned.get(leaseId) === group &&
        group.streams.has(stream) &&
        leases.holder(leaseId) === connectionId &&
        !stream.controller.signal.aborted;
      return {
        signal: stream.controller.signal,
        attach(close): void {
          if (!live()) {
            try {
              close();
            } catch {
              /* Report the expired registration, including a failed disposer. */
            }
            throw missing();
          }
          stream.close = close;
        },
        finish(disconnected): void {
          if (!disconnected && stream.owner !== null)
            group.streams.delete(stream);
          stop(stream);
        },
      };
    },
    onEvicted(listener): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close(): void {
      offEnd();
      offChange();
      listeners.clear();
      const groups = Array.from(owned.values());
      owned.clear();
      groups.forEach((group) => group.streams.forEach(stop));
    },
  };
}
