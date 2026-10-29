import {
  CanopyClientError,
  createCanopyAuthorityRegistry,
  createCanopyClientLease,
  type CanopyAuthorityConnection,
  type CanopyClientLease,
  type CanopyLeaseClient,
} from '@canopy/core-client';
import {
  CanopyCallerDescriptorSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

type Connection = CanopyLeaseClient & CanopyAuthorityConnection;
export interface ElectronDaemonSession<C extends Connection> {
  readonly client: C;
  readonly lease: Pick<CanopyClientLease<C>, 'state' | 'lease' | 'register'>;
  close(): Promise<void>;
}
export interface ElectronDaemonConnectionService<C extends Connection> {
  /** Caller and owner lifetime are resolved by trusted main, never renderer payloads. */
  get(
    caller: CanopyCallerDescriptor,
    owner: AbortSignal,
  ): Promise<ElectronDaemonSession<C>>;
  dispose(): Promise<void>;
}
export interface ElectronDaemonConnectionOptions<C extends Connection> {
  readonly enabled: boolean;
  readonly authorityId: string | ((signal: AbortSignal) => Promise<string>);
  readonly attach: (signal: AbortSignal) => Promise<C>;
  readonly setupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}
const failure = (
  kind: CanopyClientError['payload']['kind'],
  message: string,
): CanopyClientError =>
  new CanopyClientError({ kind, message, retry: { kind: 'never' } });

/** One connection/lease per trusted caller lifetime, shared by its migrated consumers. */
export function createElectronDaemonConnectionService<C extends Connection>(
  options: ElectronDaemonConnectionOptions<C>,
): ElectronDaemonConnectionService<C> {
  type Entry = {
    scope: string;
    owner: AbortSignal;
    pending: Promise<ElectronDaemonSession<C>>;
    close: () => Promise<void>;
    usable: () => boolean;
    failedAt?: number;
  };
  const entries = new Map<string, Entry>();
  const admissions = new Map<string, Promise<unknown>>();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  async function get(
    raw: CanopyCallerDescriptor,
    owner: AbortSignal,
  ): Promise<ElectronDaemonSession<C>> {
    if (disposed || owner.aborted)
      throw failure('cancelled', 'Desktop connection owner is closed.');
    if (!options.enabled)
      throw failure(
        'capability_unavailable',
        'Desktop daemon transport is disabled.',
      );
    const parsed = CanopyCallerDescriptorSchema.safeParse(raw);
    if (!parsed.success || parsed.data.interfaceKind !== 'desktop')
      throw failure('unauthenticated', 'Desktop caller identity is invalid.');
    const caller = parsed.data;
    const scope = stableStringify(caller);
    const existing = entries.get(caller.clientInstanceId);
    if (
      existing?.scope === scope &&
      existing.owner === owner &&
      (existing.failedAt === undefined
        ? existing.usable()
        : performance.now() - existing.failedAt < 1_000)
    )
      return existing.pending;
    if (existing) {
      await existing.close();
      entries.delete(caller.clientInstanceId);
    }
    if (disposed || owner.aborted)
      throw failure('cancelled', 'Desktop connection owner is closed.');
    const lifetime = new AbortController();
    let authorityId: string;
    const clients = new Set<C>();
    const attachments = new Set<Promise<C>>();
    let lease: CanopyClientLease<C> | undefined;
    let closing: Promise<void> | undefined;
    const stop = (): CanopyClientError =>
      lifetime.signal.reason instanceof CanopyClientError
        ? lifetime.signal.reason
        : failure('cancelled', 'Desktop connection owner is closed.');
    let rejectSetup = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectSetup = (): void => reject(stop());
      lifetime.signal.addEventListener('abort', rejectSetup, { once: true });
    });
    const setupTimer = setTimeout(
      () =>
        lifetime.abort(
          failure('deadline_exceeded', 'Desktop connection setup timed out.'),
        ),
      options.setupTimeoutMs ?? 30_000,
    );
    const close = (): Promise<void> => {
      if (closing) return closing;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (async (): Promise<void> => {
        lifetime.abort(stop());
        owner.removeEventListener('abort', onLoss);
        try {
          await lease?.release('normal_shutdown');
        } finally {
          const closings = Array.from(clients, (client) => client.close());
          await Promise.allSettled([...closings, ...Array.from(attachments)]);
          await Promise.all(closings);
        }
      })().then(() => {
        closing = Promise.resolve();
        const cached = entries.get(caller.clientInstanceId);
        if (cached?.pending !== pending) return;
        const retire = (): void => {
          if (entries.get(caller.clientInstanceId) === cached)
            entries.delete(caller.clientInstanceId);
        };
        if (cached.failedAt === undefined) retire();
        else
          setTimeout(
            retire,
            Math.max(0, 1_000 - (performance.now() - cached.failedAt)),
          ).unref();
      });
      closing = Promise.race([
        cleanup,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                failure(
                  'deadline_exceeded',
                  'Desktop connection cleanup timed out.',
                ),
              ),
            options.cleanupTimeoutMs ?? 5_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      return closing;
    };
    const onLoss = (): void => {
      void close().catch(() => undefined);
    };
    const connect = async (): Promise<C> => {
      if (lifetime.signal.aborted) throw stop();
      const client = await options.attach(lifetime.signal);
      clients.add(client);
      client.signal.addEventListener('abort', () => clients.delete(client), {
        once: true,
      });
      if (client.signal.aborted) clients.delete(client);
      if (
        lifetime.signal.aborted ||
        client.identity.authorityId !== authorityId ||
        client.identity.profile === 'worker'
      ) {
        await client.close();
        throw failure(
          lifetime.signal.aborted ? 'cancelled' : 'failed_precondition',
          'Desktop daemon authority is unavailable.',
        );
      }
      return client;
    };
    const attach = (): Promise<C> => {
      const task = connect();
      attachments.add(task);
      void task.then(
        () => attachments.delete(task),
        () => attachments.delete(task),
      );
      return task;
    };
    const setup = (async (): Promise<ElectronDaemonSession<C>> => {
      authorityId =
        typeof options.authorityId === 'string'
          ? options.authorityId
          : await options.authorityId(lifetime.signal);
      if (caller.authorityId !== authorityId)
        throw failure(
          'failed_precondition',
          'Desktop caller selected a different authority.',
        );
      const client = await attach();
      let registryClient = client;
      let registry = createCanopyAuthorityRegistry({ primary: client });
      const fence = (connected: C): C => {
        const signal = AbortSignal.any([connected.signal, lifetime.signal]);
        const handler: ProxyHandler<object> = {
          get(target, key): unknown {
            const value: unknown = Reflect.get(target, key, target);
            if (key === 'signal') return signal;
            if (
              key === 'connection' &&
              typeof value === 'object' &&
              value !== null
            )
              return new Proxy(value, handler);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]): unknown => {
              if (lifetime.signal.aborted) throw stop();
              const result: unknown = Reflect.apply(value, target, args);
              return result instanceof Promise
                ? result.finally(() => {
                    if (lifetime.signal.aborted) throw stop();
                  })
                : result;
            };
          },
        };
        return new Proxy<C>(connected, handler);
      };
      let guardedClient = fence(client);
      const ownedLease = (lease = createCanopyClientLease({
        client,
        attach,
        identity: {
          clientInstanceId: caller.clientInstanceId,
          interfaceKind: 'desktop',
          label: 'Desktop',
        },
        renewalIntervalMs: 15_000,
        presence: () => ({ interactive: true, foreground: false }),
      }));
      await ownedLease.acquire();
      if (lifetime.signal.aborted) throw stop();
      return {
        get client(): C {
          if (lifetime.signal.aborted) throw stop();
          if (registryClient !== ownedLease.client) {
            registryClient = ownedLease.client;
            registry = createCanopyAuthorityRegistry({
              primary: registryClient,
            });
            guardedClient = fence(registryClient);
          }
          registry.resolve({
            mode: 'authority',
            authorityId,
          });
          return guardedClient;
        },
        lease: {
          register: (key, issue) => ownedLease.register(key, issue),
          get state(): CanopyClientLease<C>['state'] {
            return ownedLease.state;
          },
          get lease(): CanopyClientLease<C>['lease'] {
            return ownedLease.lease;
          },
        },
        close,
      };
    })();
    const pending: Promise<ElectronDaemonSession<C>> = Promise.race([
      setup,
      cancelled,
    ]).finally(() => {
      clearTimeout(setupTimer);
      lifetime.signal.removeEventListener('abort', rejectSetup);
    });
    const entry: Entry = {
      scope,
      owner,
      pending,
      close,
      usable: () =>
        !lifetime.signal.aborted &&
        lease?.state !== 'failed' &&
        lease?.state !== 'released',
    };
    entries.set(caller.clientInstanceId, entry);
    owner.addEventListener('abort', onLoss, { once: true });
    if (owner.aborted) onLoss();
    void pending.catch(async () => {
      entry.failedAt = performance.now();
      // Release before allowing a later attempt; no background retry of failed setup.
      await close().catch(() => undefined);
    });
    return pending;
  }
  return {
    get(caller, owner): Promise<ElectronDaemonSession<C>> {
      const previous =
        admissions.get(caller.clientInstanceId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => get(caller, owner));
      admissions.set(caller.clientInstanceId, next);
      void next
        .finally(() => {
          if (admissions.get(caller.clientInstanceId) === next)
            admissions.delete(caller.clientInstanceId);
        })
        .catch(() => undefined);
      return next;
    },
    dispose(): Promise<void> {
      disposed = true;
      disposing ??= (async (): Promise<void> => {
        const owned = Array.from(entries.values());
        entries.clear();
        await Promise.all(owned.map((entry) => entry.close()));
        await Promise.allSettled(Array.from(admissions.values()));
      })();
      return disposing;
    },
  };
}
