import {
  CanopyStreamCursorSchema,
  CoreEventsSubscribeParamsSchema,
  isCanopySnapshotRequiredError,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { CanopyClientError, toCanopyClientError } from '../errors';
import { CanopyEventLedger } from './ledger';
import type {
  CanopyEventContext,
  CanopyEventFrame,
  CanopyEventHandle,
  CanopyEventsConnection,
  CanopyEventSubscription,
  CanopyEventSubscriptionOptions,
} from './types';

type State = ReturnType<CanopyEventSubscription['state']>;
type SnapshotReason = Parameters<
  CanopyEventSubscriptionOptions['snapshot']
>[0]['reason'];
interface Authority {
  version: number;
  cursor: CanopyStreamCursor | null;
  loaded: boolean;
  daemonEpoch: string | null;
  state: State;
  error: Error | null;
  tail: Promise<void>;
  session: Session | null;
}
interface Session {
  readonly version: number;
  readonly client: CanopyEventsConnection;
  readonly context: CanopyEventContext;
  readonly controller: AbortController;
  ledger: CanopyEventLedger;
  handle: CanopyEventHandle | null;
  end: Extract<CanopyEventFrame, { kind: 'end' }> | null;
  accepting: boolean;
  pumping: boolean;
  work: Promise<void>;
  snapshots: number;
  removeAbort: () => void;
}

const failure = (
  kind:
    | 'invalid_argument'
    | 'failed_precondition'
    | 'cancelled'
    | 'resource_exhausted'
    | 'capability_unavailable'
    | 'internal',
  message: string,
): CanopyClientError =>
  new CanopyClientError({ kind, message, retry: { kind: 'never' } });

/** One filtered subscription with independent durable resume state per authority. */
export function createCanopyEventSubscription(
  options: CanopyEventSubscriptionOptions,
): CanopyEventSubscription {
  const params = CoreEventsSubscribeParamsSchema.parse({
    families: Array.from(new Set(options.families)).sort(),
    scope: options.scope,
  });
  const subscriptionKey = JSON.stringify({
    families: params.families,
    scope: Object.fromEntries(
      Object.entries(params.scope ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  const limits = {
    maxBufferedOutput: options.maxBufferedOutput ?? 256,
    maxBufferedOutputBytes: options.maxBufferedOutputBytes ?? 1024 * 1024,
    maxPendingEvents: options.maxPendingEvents ?? 1024,
  };
  const maxSnapshots = options.maxSnapshotAttempts ?? 3;
  // Validate before any connection, callback, or store mutation.
  new CanopyEventLedger(limits, null);
  if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1)
    throw failure('invalid_argument', 'Invalid snapshot attempt limit.');
  const authorities = new Map<string, Authority>();
  let closed = options.signal?.aborted ?? false;
  const current = (authority: Authority, session: Session): boolean =>
    !closed &&
    authority.version === session.version &&
    authority.session === session &&
    !session.controller.signal.aborted;
  const stop = (session: Session): void => {
    session.accepting = false;
    session.removeAbort();
    session.controller.abort();
    session.handle?.close();
  };
  const fail = (
    authority: Authority,
    session: Session,
    error: unknown,
  ): void => {
    if (!current(authority, session)) return;
    authority.error = toCanopyClientError(error);
    authority.state = session.client.signal.aborted ? 'detached' : 'failed';
    stop(session);
  };
  const save = async (
    authority: Authority,
    session: Session,
    cursor: CanopyStreamCursor | null,
  ): Promise<void> => {
    await options.store?.save(
      session.context.authorityId,
      subscriptionKey,
      cursor ? { ...cursor } : null,
    );
    if (current(authority, session))
      authority.cursor = cursor ? { ...cursor } : null;
  };
  const snapshot = async (
    authority: Authority,
    session: Session,
    reason: SnapshotReason,
  ): Promise<void> => {
    if (++session.snapshots > maxSnapshots)
      throw failure(
        'resource_exhausted',
        'Snapshot recovery did not converge.',
      );
    authority.state = 'rehydrating';
    await save(authority, session, null);
    if (!current(authority, session)) return;
    const result = await options.snapshot({ ...session.context, reason });
    if (!current(authority, session)) return;
    const cursor =
      result === null ? null : CanopyStreamCursorSchema.parse(result);
    if (cursor && cursor.daemonEpoch !== session.context.daemonEpoch)
      throw failure(
        'failed_precondition',
        'Snapshot cursor belongs to another daemon epoch.',
      );
    await save(authority, session, cursor);
  };

  const open = async (
    authority: Authority,
    session: Session,
  ): Promise<void> => {
    while (current(authority, session)) {
      session.ledger = new CanopyEventLedger(limits, authority.cursor);
      session.end = null;
      session.accepting = true;
      try {
        const handle = await session.client.openStream(
          'core.events.subscribe',
          { ...params, cursor: authority.cursor },
          {
            signal: session.controller.signal,
            onFrame: (frame) => {
              if (!current(authority, session) || !session.accepting) return;
              if (frame.kind === 'end') {
                session.accepting = false;
                session.end = frame;
              } else {
                try {
                  if (
                    frame.cursor.daemonEpoch !== session.context.daemonEpoch ||
                    frame.item.cursor.daemonEpoch !==
                      frame.cursor.daemonEpoch ||
                    frame.item.cursor.sequence !== frame.cursor.sequence
                  )
                    throw failure(
                      'failed_precondition',
                      'Event and stream cursors disagree.',
                    );
                  session.ledger.enqueue(
                    frame.item,
                    options.classify?.({
                      ...frame.item,
                      cursor: { ...frame.item.cursor },
                    }) ?? 'lifecycle',
                  );
                } catch (error) {
                  fail(authority, session, error);
                }
              }
              if (session.handle) pump(authority, session);
            },
          },
        );
        if (!current(authority, session)) {
          handle.close();
          return;
        }
        const accepted = handle.openResult.acceptedCursor;
        const requested = authority.cursor;
        if (
          accepted?.daemonEpoch !== requested?.daemonEpoch ||
          accepted?.sequence !== requested?.sequence
        ) {
          handle.close();
          // A null accepted start refuses the checkpoint; no buffered item is handled.
          if (accepted === null && requested) {
            await snapshot(authority, session, 'snapshot_required');
            continue;
          }
          throw failure(
            'failed_precondition',
            'Daemon accepted a different event checkpoint.',
          );
        }
        session.handle = handle;
        authority.state = 'open';
        return;
      } catch (error) {
        if (!current(authority, session)) return;
        if (!isCanopySnapshotRequiredError(toCanopyClientError(error).payload))
          throw error;
        await snapshot(authority, session, 'snapshot_required');
      }
    }
  };

  const drain = async (
    authority: Authority,
    session: Session,
  ): Promise<void> => {
    while (current(authority, session)) {
      const entry = session.ledger.take();
      if (entry) {
        await options.handle(entry.delivery, { ...session.context });
        if (!current(authority, session)) return;
        const cursor = session.ledger.settle(entry);
        if (cursor) {
          await save(authority, session, cursor);
          if (!current(authority, session)) return;
          // End cursors are not checkpoints. Never ack an ended subscription.
          if (!session.end && session.handle)
            await session.client.instruction(
              'core.events.ack',
              {
                subscriptionId: session.handle.openResult.subscriptionId,
                cursor,
              },
              { signal: session.controller.signal },
            );
        }
        continue;
      }
      const end = session.end;
      if (!end) return;
      session.handle?.close();
      session.handle = null;
      if (isCanopySnapshotRequiredError(end.error)) {
        await snapshot(authority, session, 'snapshot_required');
        await open(authority, session);
        continue;
      }
      if (end.outcome === 'error')
        throw end.error
          ? new CanopyClientError(end.error)
          : toCanopyClientError(
              new Error('Event stream failed without error details.'),
            );
      authority.state = 'detached';
      stop(session);
      return;
    }
  };
  function pump(authority: Authority, session: Session): void {
    if (session.pumping || !current(authority, session)) return;
    session.pumping = true;
    session.work = Promise.resolve()
      .then(() => drain(authority, session))
      .catch((error: unknown) => fail(authority, session, error))
      .finally(() => {
        session.pumping = false;
        // Frames can arrive after drain returns but before this continuation.
        if (
          current(authority, session) &&
          (session.ledger.pendingEvents > 0 || session.end)
        )
          pump(authority, session);
      });
  }

  const attach = (client: CanopyEventsConnection): Promise<void> => {
    const authorityId = client.identity.authorityId;
    if (!authorityId)
      return Promise.reject(
        failure(
          'failed_precondition',
          'Event subscriptions require an authority identity.',
        ),
      );
    if (closed || client.signal.aborted)
      return Promise.reject(
        failure('cancelled', 'Event subscription is closed.'),
      );
    if (!client.manifest.has('operations', 'core.events.ack'))
      return Promise.reject(
        failure(
          'capability_unavailable',
          'Event subscriptions require acknowledgement capability.',
        ),
      );
    let authority = authorities.get(authorityId);
    if (!authority) {
      authority = {
        version: 0,
        cursor: null,
        loaded: false,
        daemonEpoch: null,
        state: 'detached',
        error: null,
        tail: Promise.resolve(),
        session: null,
      };
      authorities.set(authorityId, authority);
    }
    const record = authority;
    const version = ++record.version;
    if (record.session) stop(record.session);
    const task = record.tail.then(async () => {
      await record.session?.work;
      if (closed || version !== record.version) return;
      if (client.signal.aborted) {
        record.state = 'detached';
        throw failure(
          'cancelled',
          'Event connection closed before attachment.',
        );
      }
      const controller = new AbortController();
      const session: Session = {
        version,
        client,
        controller,
        context: { authorityId, daemonEpoch: client.identity.daemonEpoch },
        ledger: new CanopyEventLedger(limits, null),
        handle: null,
        end: null,
        accepting: false,
        pumping: false,
        work: Promise.resolve(),
        snapshots: 0,
        removeAbort: () => {},
      };
      record.session = session;
      record.error = null;
      const onAbort = (): void => {
        if (!current(record, session)) return;
        record.state = 'detached';
        stop(session);
      };
      client.signal.addEventListener('abort', onAbort, { once: true });
      session.removeAbort = (): void =>
        client.signal.removeEventListener('abort', onAbort);
      try {
        if (!record.loaded) {
          const loaded = await options.store?.load(
            authorityId,
            subscriptionKey,
          );
          if (!current(record, session)) return;
          record.cursor =
            loaded == null ? null : CanopyStreamCursorSchema.parse(loaded);
          record.loaded = true;
        }
        const previousEpoch = record.daemonEpoch ?? record.cursor?.daemonEpoch;
        const epochChanged =
          previousEpoch != null &&
          previousEpoch !== client.identity.daemonEpoch;
        record.daemonEpoch = client.identity.daemonEpoch;
        if (epochChanged || !record.cursor)
          await snapshot(
            record,
            session,
            epochChanged ? 'epoch_changed' : 'initial',
          );
        await open(record, session);
        if (current(record, session)) pump(record, session);
      } catch (error) {
        fail(record, session, error);
        throw error;
      }
    });
    record.tail = task.catch(() => {});
    return task;
  };
  const close = async (): Promise<void> => {
    closed = true;
    options.signal?.removeEventListener('abort', onClose);
    for (const record of Array.from(authorities.values())) {
      record.version += 1;
      record.state = 'detached';
      if (record.session) stop(record.session);
    }
    await Promise.all(
      Array.from(authorities.values()).map(async (record) => {
        await record.tail;
        await record.session?.work;
      }),
    );
  };
  const onClose = (): void => {
    void close();
  };
  options.signal?.addEventListener('abort', onClose, { once: true });
  return {
    attach,
    close,
    cursor: (id): CanopyStreamCursor | null => {
      const cursor = authorities.get(id)?.cursor;
      return cursor ? { ...cursor } : null;
    },
    state: (id) => authorities.get(id)?.state ?? 'detached',
    error: (id) => authorities.get(id)?.error ?? null,
  };
}
