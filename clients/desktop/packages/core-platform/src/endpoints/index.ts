import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import path from 'node:path';
import type {
  PlatformByteStream,
  PlatformEndpointAddressRequest as AddressRequest,
  PlatformEndpointBindResult as BindResult,
  PlatformEndpointIdentityCheck as IdentityCheck,
  PlatformEndpointListener,
  PlatformEndpointPathIdentity as PathIdentity,
  PlatformEndpointServices,
  PlatformNamedPipeAddress as PipeAddress,
  PlatformOperatingSystem,
  PlatformSocketBindResult as SocketBindResult,
  PlatformSocketProbeResult as SocketProbe,
  PlatformSocketEndpointServices as SocketServices,
  PlatformPipeEndpointServices as PipeServices,
  PlatformStartupClaim as StartupClaim,
  PlatformUnixSocketAddress as SocketAddress,
} from '@canopy/core-runtime';
import { createPlatformPathServices } from '../paths';
import { MAX_BYTES, byteStream } from './stream';
import {
  openSecurePipe,
  type SecurePipeServer,
  type WindowsPipeSecurity,
} from './windows-pipe';

export {
  evaluatePipeDescriptor,
  loadWindowsPipeSecurity,
  WINDOWS_PIPE_SECURITY_FILE,
  type WindowsPipeSecurity,
} from './windows-pipe';

export interface PlatformEndpointServiceOptions {
  /** Trusted host authority: must prove this claim is currently held, not merely well-shaped. */
  readonly validateStartupClaim?: (claim: StartupClaim) => Promise<boolean>;
  /**
   * Native pipe creation with an owner-only descriptor. Node's default pipe
   * DACL grants Everyone read, so Windows binds refuse without it.
   */
  readonly namedPipeSecurity?: WindowsPipeSecurity;
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function identity(
  address: SocketAddress,
): Promise<PathIdentity | 'absent' | 'changed'> {
  try {
    const stat = await lstat(address.path, { bigint: true });
    return stat.isSocket() ? { device: stat.dev, inode: stat.ino } : 'changed';
  } catch (error) {
    return code(error) === 'ENOENT' ? 'absent' : 'changed';
  }
}

async function verifyIdentity(
  address: SocketAddress,
  expected: PathIdentity,
): Promise<IdentityCheck> {
  const current = await identity(address);
  if (typeof current === 'string') return current;
  return current.device === expected.device && current.inode === expected.inode
    ? 'match'
    : 'changed';
}

function connectProbe(target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(target);
    const timer = setTimeout(() => finish('timeout'), 1000);
    function finish(result: string): void {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }
    socket.once('connect', () => finish('live'));
    socket.once('error', (error) => finish(code(error) ?? 'unknown'));
  });
}

async function probe(address: SocketAddress): Promise<SocketProbe> {
  const before = await identity(address);
  if (before === 'absent') return { state: 'absent' };
  if (before === 'changed')
    return { state: 'ambiguous', reason: 'Not a verified socket.' };
  const result = await connectProbe(address.path);
  if (result === 'live') return { state: 'live' };
  if (
    result === 'ECONNREFUSED' &&
    (await verifyIdentity(address, before)) === 'match'
  ) {
    return { state: 'refused', identity: before };
  }
  return { state: 'ambiguous', reason: result };
}

/** Shared accept queue: 32 live and 32 queued streams; close destroys every client. */
function streamQueue<T>(
  address: T,
  closeSource: () => Promise<void>,
  removePublishedPath: () => Promise<void> = () => Promise.resolve(),
): {
  readonly listener: PlatformEndpointListener<T>;
  admit(socket: Socket): void;
  open(): void;
} {
  const clients = new Map<Socket, Promise<void>>();
  const queued: PlatformByteStream[] = [];
  let wake: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let consumed = false;
  let accepting = false;
  function close(): Promise<void> {
    if (!closing) {
      // net.Server.close() settles only once its clients are gone; a pipe
      // instance holds the name until its socket has closed (D3).
      const closed = closeSource();
      const gone = Array.from(clients.values());
      clients.forEach((_closed, socket) => socket.destroy());
      queued.length = 0;
      closing = Promise.all([closed, ...gone]).then(removePublishedPath);
      wake?.();
    }
    return closing;
  }
  return {
    admit: (socket): void => {
      if (!accepting || closing || clients.size >= 32 || queued.length >= 32) {
        socket.destroy();
        return;
      }
      clients.set(
        socket,
        new Promise((resolve) => socket.once('close', () => resolve())),
      );
      socket.once('close', () => clients.delete(socket));
      queued.push(byteStream(socket));
      wake?.();
    },
    open: (): void => {
      accepting = true;
    },
    listener: {
      address,
      connections: async function* (): AsyncIterable<PlatformByteStream> {
        if (consumed) throw new Error('Connections already consumed.');
        consumed = true;
        while (!closing) {
          const next = queued.shift();
          if (next) yield next;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      },
      close,
    },
  };
}

async function bind<R>(
  address: SocketAddress,
  verifyAccess: () => Promise<R>,
  removePublishedPath: () => Promise<void>,
): Promise<
  | {
      readonly kind: 'bound';
      readonly listener: PlatformEndpointListener<SocketAddress>;
      readonly receipt: R;
    }
  | { readonly kind: 'in-use' }
> {
  const server = createServer({
    pauseOnConnect: true,
    highWaterMark: MAX_BYTES,
  });
  const queue = streamQueue(
    address,
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    removePublishedPath,
  );
  server.on('connection', (socket) => queue.admit(socket));
  const error = await new Promise<Error | null>((resolve) => {
    server.once('error', resolve);
    server.listen({ path: address.path, backlog: 32 }, () => {
      server.off('error', resolve);
      resolve(null);
    });
  });
  if (error) {
    if (code(error) === 'EADDRINUSE') return { kind: 'in-use' };
    throw error;
  }
  server.on('error', () => {
    void queue.listener.close().catch(() => undefined);
  });
  let receipt: R;
  try {
    receipt = await verifyAccess();
    queue.open();
  } catch (error) {
    await queue.listener.close();
    throw error;
  }
  return { kind: 'bound', listener: queue.listener, receipt };
}

/** Host selection only; no ambient OS, environment, home directory, or discovery policy. */
export function createPlatformEndpointServices(
  os: PlatformOperatingSystem,
  options: PlatformEndpointServiceOptions = {},
): PlatformEndpointServices {
  const host = os === 'win32' ? path.win32 : path.posix;
  const paths = createPlatformPathServices(os);
  const runtime = (request: { readonly dataRoot: string }): string =>
    paths.runtimeDirectory(request);
  function openPipe(target: PipeAddress): BindResult<PipeAddress> {
    const native = options.namedPipeSecurity;
    if (!native) throw new Error('Named pipe security required.');
    const secure: { current?: SecurePipeServer } = {};
    const queue = streamQueue(target, () => {
      secure.current?.close();
      return Promise.resolve();
    });
    const opened = openSecurePipe(native, target.path, (socket) =>
      queue.admit(socket),
    );
    if (opened === 'in-use') return { kind: 'in-use' };
    secure.current = opened;
    queue.open();
    return { kind: 'bound', listener: queue.listener };
  }
  const bindPipe = (target: PipeAddress): Promise<BindResult<PipeAddress>> =>
    new Promise((resolve) => resolve(openPipe(target)));
  async function bindSocket(target: SocketAddress): Promise<SocketBindResult> {
    // Node unlinks its bind path on close; keep that path separate from discovery.
    const temporary = {
      ...target,
      path: host.join(
        host.dirname(target.path),
        `.${randomBytes(6).toString('hex')}`,
      ),
    };
    let publishedIdentity: PathIdentity | undefined;
    try {
      const result = await bind(
        temporary,
        async (): Promise<PathIdentity> => {
          const current = await identity(temporary);
          if (typeof current === 'string') throw new Error('Socket replaced.');
          await chmod(temporary.path, 0o600);
          await link(temporary.path, target.path);
          publishedIdentity = current;
          await unlink(temporary.path);
          return current;
        },
        async (): Promise<void> => {
          if (
            publishedIdentity &&
            (await verifyIdentity(target, publishedIdentity)) === 'match'
          )
            await unlink(target.path);
        },
      );
      return result.kind === 'bound'
        ? {
            kind: 'bound',
            listener: { ...result.listener, address: target },
            identity: result.receipt,
          }
        : result;
    } catch (error) {
      if (code(error) === 'EEXIST') return { kind: 'in-use' };
      throw error;
    }
  }
  function address({ dataRoot, endpointName }: AddressRequest): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(endpointName))
      throw new Error('Invalid endpoint name.');
    const directory = runtime({ dataRoot });
    if (os === 'win32') {
      // Keyed by data root alone, like the POSIX socket inside it: one daemon per
      // data root whatever the brand. A per-user name would stay predictable, so
      // the owner-only pipe DACL and the handshake reject other users.
      const hash = createHash('sha256')
        .update(host.resolve(dataRoot))
        .digest('hex');
      return `\\\\.\\pipe\\canopy-${hash}-${endpointName}`;
    }
    const target = host.join(directory, `${endpointName}.sock`);
    if (
      Math.max(
        Buffer.byteLength(target),
        Buffer.byteLength(host.join(directory, '.000000000000')),
      ) > (os === 'darwin' ? 103 : 107)
    )
      throw new Error('Socket path too long.');
    return target;
  }
  if (os === 'win32') {
    const services: PipeServices = {
      semantics: 'first-instance-pipe',
      address: (request): PipeAddress => ({
        kind: 'named-pipe',
        path: address(request),
      }),
      bind: bindPipe,
      probe: async (target) => {
        const result = await connectProbe(target.path);
        if (result === 'live') return { state: 'live' };
        if (result === 'ENOENT') return { state: 'absent' };
        return { state: 'ambiguous', reason: result };
      },
    };
    return Object.freeze(services);
  }
  const services: SocketServices = {
    semantics: 'filesystem-socket',
    address: (request): SocketAddress => ({
      kind: 'unix-socket',
      path: address(request),
    }),
    bind: bindSocket,
    probe,
    verifyIdentity,
    unlinkStale: async ({ address: target, expected, claim }) => {
      if (
        !options.validateStartupClaim ||
        target.path !==
          host.join(
            runtime({ dataRoot: claim.dataRoot }),
            host.basename(target.path),
          ) ||
        !(await options.validateStartupClaim(claim))
      )
        return 'changed';
      const check = await verifyIdentity(target, expected);
      if (check !== 'match') return check;
      try {
        await unlink(target.path);
        return 'unlinked';
      } catch (error) {
        if (code(error) === 'ENOENT') return 'absent';
        throw error;
      }
    },
  };
  return Object.freeze(services);
}
