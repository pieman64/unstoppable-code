import { W4Resources as Resources, trackW4LateCleanup } from './w4-acquisition';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCanopyFramedConnection } from '@canopy/core-client/node';
import { createPlatformEndpointServices } from '@canopy/core-platform';
import {
  type CanopyDispatcher,
  type CanopyStreamFrame,
  type PlatformByteStream,
  type CanopyRuntimeState,
  type PlatformEndpointListener,
} from '@canopy/core-runtime';
import {
  serveCanopyDaemonControlPlane,
  type CanopyDaemonClock,
} from '@canopy/core-runtime/node';
import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CoreRuntimeManifestGetResultSchema,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  createW4FilesystemFixtureServices,
  startW4DispatcherHost,
  type W4ParityBinding,
  type W4ParityBackend,
  type W4ParityEndpoint,
  type W4ParityClient,
  type W4ParitySessionOptions,
  type W4DispatcherHost,
} from './w4-parity-harness';

const ROOTS = 'worker.filesystem.roots.list';
const DIRECTORY = 'worker.filesystem.directory.list';
const SNAPSHOT = 'core.chat.snapshot.get';
const EVENTS = 'core.chat.events';
const QUERIES = {
  [ROOTS]: CANOPY_QUERY_DEFINITIONS[ROOTS],
  [DIRECTORY]: CANOPY_QUERY_DEFINITIONS[DIRECTORY],
  [SNAPSHOT]: CANOPY_QUERY_DEFINITIONS[SNAPSHOT],
};
const STREAMS = { [EVENTS]: CANOPY_STREAM_DEFINITIONS[EVENTS] };
const LEASES = [
  'core.client.lease.acquire',
  'core.client.lease.renew',
  'core.client.lease.release',
  'core.client.capabilities.register',
];

/** Server-side faults applied to an error terminal frame. */
export type W4RefusalFault =
  | 'suppress'
  | 'reclassify-code'
  | 'reclassify-kind'
  | 'corrupt-directive';

function faultedError(
  error: CanopyErrorPayload,
  fault: Exclude<W4RefusalFault, 'suppress'>,
): CanopyErrorPayload {
  if (fault === 'reclassify-code')
    return { ...error, code: 'core.chat.unclassified' };
  if (fault === 'reclassify-kind') return { ...error, kind: 'internal' };
  return {
    ...error,
    retry: { kind: 'after_refresh', resource: 'core.chat.transcript.page.get' },
  };
}

export interface W4LocalTransportOptions {
  /** Faults and observations stay in the fixture host, never in the daemon. */
  checkpoint?: (stage: string) => Promise<void> | void;
  observe?: (event: string, value?: unknown) => void;
  /** Receives the fixture host so tests can count its live subscriptions. */
  onHost?: (host: W4DispatcherHost) => void;
  clock?: CanopyDaemonClock;
  ignoreMutation?: boolean;
  /** Facade input fault: chat streams open without the client's cursor. */
  stripCursor?: boolean;
  /** Frame-iterator fault on the stream's refusal terminal. */
  refusalFault?: W4RefusalFault;
  /** Client presents a secret the endpoint never issued. */
  presentForeignSecret?: boolean;
}

function faultRefusals<Item, End>(
  frames: AsyncIterable<CanopyStreamFrame<Item, End>>,
  fault: W4RefusalFault,
  observe: W4LocalTransportOptions['observe'],
): AsyncIterable<CanopyStreamFrame<Item, End>> {
  return (async function* (): AsyncIterable<CanopyStreamFrame<Item, End>> {
    for await (const frame of frames) {
      if (frame.kind !== 'end' || !frame.error) {
        yield frame;
        continue;
      }
      observe?.('refusal-fault', fault);
      if (fault === 'suppress') continue;
      yield { ...frame, error: faultedError(frame.error, fault) };
    }
  })();
}

function facade(
  host: W4DispatcherHost,
  session: W4ParitySessionOptions,
  options: W4LocalTransportOptions,
): CanopyDispatcher {
  const runtime = host.runtime;
  const refused = (): never => {
    throw new Error('Operation outside W4 fixture surface.');
  };
  return {
    profile: runtime.profile,
    definitions: QUERIES,
    get state(): CanopyRuntimeState {
      return runtime.state;
    },
    async query(name, params, call): Promise<unknown> {
      if (name === 'core.runtime.health.get')
        return runtime.query('core.runtime.health.get', {}, call);
      if (name === 'core.runtime.manifest.get') {
        await options.checkpoint?.('initialize');
        const { runtime: descriptor } = await runtime.query(
          'core.runtime.health.get',
          {},
          call,
        );
        return CoreRuntimeManifestGetResultSchema.parse({
          runtime: descriptor,
          generatedAt: new Date().toISOString(),
          operations: Object.entries({ ...QUERIES, ...STREAMS }).map(
            ([name, { version, placement, requiredGrants }]) => ({
              name,
              kind: name === EVENTS ? 'stream' : 'query',
              version,
              placement,
              requiredGrants,
              available: true,
            }),
          ),
        });
      }
      if (name !== ROOTS && name !== DIRECTORY && name !== SNAPSHOT)
        return refused();
      const result = await (name === ROOTS
        ? runtime.query(ROOTS, QUERIES[ROOTS].params.parse(params), call)
        : name === DIRECTORY
          ? runtime.query(
              DIRECTORY,
              QUERIES[DIRECTORY].params.parse(params),
              call,
            )
          : runtime.query(
              SNAPSHOT,
              QUERIES[SNAPSHOT].params.parse(params),
              call,
            ));
      options.observe?.('query', name);
      if (!session.mutateResult) return result;
      if (!options.ignoreMutation) return session.mutateResult(name, result);
      options.observe?.('mutation-ignored', name);
      return result;
    },
    instruction: () =>
      Promise.reject(new Error('Operation outside W4 fixture surface.')),
    async openStream(
      name,
      params,
      call,
    ): ReturnType<CanopyDispatcher['openStream']> {
      if (name !== EVENTS) return refused();
      const parsed = STREAMS[EVENTS].params.parse(params);
      const strip = options.stripCursor === true && parsed.cursor != null;
      if (strip) options.observe?.('cursor-stripped', parsed.cursor);
      const handle = await runtime.openStream(
        EVENTS,
        strip ? { ...parsed, cursor: null } : parsed,
        call,
      );
      const fault = options.refusalFault;
      return fault
        ? {
            ...handle,
            frames: faultRefusals(handle.frames, fault, options.observe),
          }
        : handle;
    },
    drainInstructions: () => undefined,
    shutdown: () => Promise.resolve(),
  };
}

/** Independent same-process fixture state behind real authenticated local IO.
 * This is NOT persisted-scope packaged-daemon or process/disk durability proof.
 */
export function createW4LocalTransportBinding(
  options: W4LocalTransportOptions = {},
): W4ParityBinding {
  return {
    name: 'fixture local-transport (not persisted-scope production)',
    async start(): Promise<W4ParityBackend> {
      if (process.platform !== 'darwin' && process.platform !== 'linux')
        throw new Error('W4 fixture socket host requires Darwin or Linux.');
      const resources = new Resources();
      const sessions = new Set<Resources>();
      let restarting = false;
      let hostRestart: Promise<void> | undefined;
      try {
        const directory = await resources.own(
          await mkdtemp(join(tmpdir(), 'w4-')),
          (path) => rm(path, { recursive: true, force: true }),
        );
        const socketDirectory = await realpath(directory);
        const auth = {
          secret: randomBytes(32).toString('hex'),
          dataRootHash: randomBytes(32).toString('hex'),
        };
        const fixtures = createW4FilesystemFixtureServices();
        const host = await resources.own(
          await startW4DispatcherHost('w4-local-hold', fixtures.services),
          async (value) => {
            // A replacement runtime finishing after shutdown must not survive.
            await hostRestart?.catch(() => undefined);
            await value.shutdown();
            options.observe?.('host-closed', value.subscribers());
          },
        );
        options.onHost?.(host);
        await options.checkpoint?.('host');
        const closeSessions = async (): Promise<void> => {
          const results = await Promise.allSettled(
            Array.from(sessions, (session) => {
              sessions.delete(session);
              return session.cancel();
            }),
          );
          const errors: unknown[] = [];
          for (const result of results)
            if (result.status === 'rejected') errors.push(result.reason);
          if (errors.length)
            throw new AggregateError(errors, 'W4 sessions cleanup failed');
        };
        await resources.own(closeSessions, (close) => close());
        let shutdown: Promise<void> | undefined;
        return {
          expected: {
            operations: [...Object.keys(QUERIES), ...LEASES],
            streams: Object.keys(STREAMS),
          },
          filesystem: fixtures.driver,
          chat: {
            commit: (): Promise<void> =>
              new Promise((resolve) => {
                resources.controller.signal.throwIfAborted();
                host.commit();
                options.observe?.('commit', host.revision());
                resolve();
              }),
            // A daemon restart drops every connection before the new epoch.
            async restart(): Promise<void> {
              const { signal } = resources.controller;
              signal.throwIfAborted();
              if (restarting) throw new Error('W4 host is already restarting.');
              restarting = true;
              try {
                await closeSessions();
                await resources.acquire(
                  Promise.resolve(options.checkpoint?.('restart')),
                  () => undefined,
                );
                signal.throwIfAborted();
                hostRestart = host.restart();
                await hostRestart;
                // Shutdown waited for the replacement and then stopped it.
                signal.throwIfAborted();
                options.observe?.('restarted');
              } catch (error) {
                // A partial restart leaves no usable host: stop everything.
                return resources.fail(error, 'W4 restart and cleanup failed');
              } finally {
                restarting = false;
                hostRestart = undefined;
              }
            },
          },
          async connect(session, signal): Promise<W4ParityEndpoint> {
            resources.controller.signal.throwIfAborted();
            if (restarting) throw new Error('W4 host is restarting.');
            const owned = new Resources();
            sessions.add(owned);
            let published = false;
            const cancel = (): void => {
              const closing = owned.cancel(signal?.reason);
              // A published endpoint's close() reports this to its caller; an
              // unpublished one only rejects a connect nobody awaits anymore.
              if (published) void closing.catch(() => undefined);
              else trackW4LateCleanup(closing, signal?.reason);
            };
            signal?.addEventListener('abort', cancel, { once: true });
            await owned.own(undefined, () =>
              signal?.removeEventListener('abort', cancel),
            );
            if (signal?.aborted) cancel();
            const checkpoint = async (stage: string): Promise<void> => {
              owned.controller.signal.throwIfAborted();
              await owned.acquire(
                Promise.resolve(options.checkpoint?.(stage)),
                () => undefined,
              );
            };
            try {
              const endpoints = createPlatformEndpointServices(
                process.platform === 'darwin' ? 'darwin' : 'linux',
              );
              if (endpoints.semantics !== 'filesystem-socket')
                throw new Error(
                  'W4 fixture requires filesystem socket; native differences belong to PlatformServices.',
                );
              owned.controller.signal.throwIfAborted();
              const bound = await owned.acquire(
                endpoints.bind({
                  kind: 'unix-socket',
                  path: join(
                    socketDirectory,
                    `${randomUUID().slice(0, 8)}.sock`,
                  ),
                }),
                async (value) => {
                  if (value.kind === 'bound') {
                    await value.listener.close();
                    options.observe?.('listener-closed');
                  }
                },
              );
              if (bound.kind !== 'bound')
                throw new Error('W4 endpoint already bound.');
              const { listener } = bound;
              options.observe?.('listener', listener.address.path);
              await checkpoint('listener');
              const observed: PlatformEndpointListener<unknown> = {
                ...listener,
                connections:
                  async function* (): AsyncIterable<PlatformByteStream> {
                    for await (const stream of listener.connections()) {
                      options.observe?.('accepted', stream);
                      let closing: Promise<void> | undefined;
                      let authenticating: Promise<void> | undefined;
                      yield {
                        ...stream,
                        // Gates the server handshake's first read.
                        read: async (
                          readOptions,
                        ): Promise<Uint8Array | null> => {
                          await (authenticating ??= checkpoint('authenticate'));
                          return stream.read(readOptions);
                        },
                        close: (): Promise<void> => {
                          return (closing ??= stream.close().then(() => {
                            options.observe?.('stream-closed', stream);
                          }));
                        },
                      };
                    }
                  },
              };
              const plane = await owned.own(
                serveCanopyDaemonControlPlane({
                  binding: { listener: observed, auth },
                  dispatcher: facade(host, session, options),
                  operations: [
                    ...Object.keys(QUERIES).map((name) => ({
                      name,
                      kind: 'query' as const,
                      declaresMeta: false,
                    })),
                    { name: EVENTS, kind: 'stream', declaresMeta: false },
                  ],
                  callerFor: ({ connectionId, lease }) => ({
                    principalId: 'w4-fixture',
                    clientInstanceId: lease?.clientInstanceId ?? connectionId,
                    authorityId: 'local-desktop',
                    interfaceKind: 'test',
                    grants: [
                      'core.runtime.read',
                      'core.client.manage',
                      'core.chat.read',
                      'worker.filesystem.read',
                    ],
                  }),
                  buildVersion: '0.0.0-w4-local-fixture',
                  onIdle: () => undefined,
                  clock: options.clock,
                }),
                (value) => value.close(),
              );
              options.observe?.('plane', plane);
              await checkpoint('plane');
              const connection = await owned.own(
                await connectCanopyFramedConnection({
                  endpoint: {
                    kind: 'socket',
                    path: listener.address.path,
                    auth: options.presentForeignSecret
                      ? { ...auth, secret: randomBytes(32).toString('hex') }
                      : auth,
                  },
                  signal: owned.controller.signal,
                  timeoutMs: 2_000,
                }),
                (value) => value.close(),
              );
              options.observe?.('authenticated', connection);
              published = true;
              return {
                connection,
                async activate(
                  client: W4ParityClient,
                ): Promise<{ close(): Promise<void> }> {
                  options.observe?.('initialized');
                  await checkpoint('activate');
                  await client.instruction('core.client.lease.acquire', {
                    clientInstanceId: randomUUID(),
                    interfaceKind: 'test',
                    label: 'W4 fixture',
                    interactive: false,
                    foreground: true,
                    renewalIntervalMs: 15_000,
                    _meta: { idempotencyKey: randomUUID() },
                  });
                  options.observe?.('activated');
                  return {
                    close: async (): Promise<void> => {
                      if (!client.signal.aborted)
                        await client.instruction('core.client.lease.release', {
                          reason: 'normal_shutdown',
                        });
                    },
                  };
                },
                close: () =>
                  owned.close().finally(() => sessions.delete(owned)),
              };
            } catch (error) {
              return owned
                .fail(error, 'W4 connect and cleanup failed')
                .finally(() => sessions.delete(owned));
            }
          },
          shutdown: () => (shutdown ??= resources.cancel()),
        };
      } catch (error) {
        return resources.fail(error, 'W4 start and cleanup failed');
      }
    },
  };
}
