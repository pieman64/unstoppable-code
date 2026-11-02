import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { FileSaveConflictError } from '@canopy/protocol/file-save-conflict';
import {
  RemoteHostConnection,
  type HostConnectionOptions,
} from '../client/host-connection';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_METHODS,
  REMOTE_PROTOCOL_MISMATCH_CODE,
  isUnknownRemoteMethodError,
  type AppAdvisorWindowStateParams,
  type AccountProxySignInCallbackParams,
  type AccountProxySignInOpenParams,
  type DialogOpenResult,
  type HelloResult,
  type RemoteVersion,
} from '../remote-protocol';
import { RpcClosedError, RpcPeer } from '../transport/rpc-peer';
import type { SecureSession } from '../transport/session-manager';
import { FakeBridge, FakeMainWindow, TEST_VERSION } from './host-fakes';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import {
  createTestDevice,
  openControlSession,
  type TestDevice,
} from './session-pair';

const TUNNEL_CHANNEL = IPC_CHANNELS.chatSendMessage;
const dirs: string[] = [];

interface Setup {
  laptop: TestDevice;
  desktop: TestDevice;
  hostSessions: RemoteHostSession[];
  bridges: FakeBridge[];
  connection: RemoteHostConnection;
  reconnected: { count: number };
}

/** A laptop whose connection reaches a desktop running real host sessions. */
function setup(
  connect?: (open: () => Promise<SecureSession>) => Promise<SecureSession>,
  versions: { host?: RemoteVersion; laptop?: RemoteVersion } = {},
  extra: {
    connection?: Partial<HostConnectionOptions>;
    /** The host release's dispositions; defaults to this release's. */
    hostDisposition?: typeof getRemoteChannelDisposition;
    completeAccountProxySignIn?: (
      controllerDeviceId: string,
      callback: AccountProxySignInCallbackParams,
    ) => Promise<void>;
  } = {},
): Setup {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'laptop');
  const desktop = createTestDevice(hub, 'desktop');
  const uploadsDir = mkdtempSync(join(tmpdir(), 'host-connection-'));
  dirs.push(uploadsDir);
  const hostSessions: RemoteHostSession[] = [];
  const bridges: FakeBridge[] = [];
  const open = async (): Promise<SecureSession> => {
    const { initiator, responder } = await openControlSession(laptop, desktop);
    hostSessions.push(
      new RemoteHostSession({
        session: responder,
        createBridge: (): Promise<FakeBridge> => {
          const bridge = new FakeBridge();
          bridges.push(bridge);
          return Promise.resolve(bridge);
        },
        mainWindowPushes: new FakeMainWindow(),
        uploads: new RemoteUploadStore(uploadsDir),
        readFile: (): Promise<never> => Promise.reject(new Error('unused')),
        disposition: extra.hostDisposition ?? getRemoteChannelDisposition,
        isAuthorized: (): boolean => true,
        version: versions.host ?? TEST_VERSION,
        hello: (): Pick<HelloResult, 'name' | 'platform'> => ({
          name: 'desktop',
          platform: 'linux',
        }),
        onClose: (): void => undefined,
        ...(extra.completeAccountProxySignIn
          ? { completeAccountProxySignIn: extra.completeAccountProxySignIn }
          : {}),
      }),
    );
    return initiator;
  };
  const reconnected = { count: 0 };
  const connection = new RemoteHostConnection({
    version: versions.laptop ?? TEST_VERSION,
    connect: (): Promise<SecureSession> => (connect ? connect(open) : open()),
    onPush: (): void => undefined,
    onDialogOpen: (): Promise<DialogOpenResult> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    onAppAdvisorWindow: (): Promise<AppAdvisorWindowStateParams> =>
      Promise.reject(new Error('unused')),
    onStatusChange: (): void => undefined,
    onReconnected: (): void => {
      reconnected.count += 1;
    },
    minRetryDelayMs: 5,
    maxRetryDelayMs: 10,
    ...extra.connection,
  });
  return { laptop, desktop, hostSessions, bridges, connection, reconnected };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition not reached.');
    await flushRelay(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('RemoteHostConnection', () => {
  it('preserves typed image-save name conflicts across the remote bridge', async () => {
    const { connection, bridges } = setup();
    try {
      await connection.ensure();
      bridges[0].handler = (): Promise<never> =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'file:save-content': FileNameConflictError: exists",
          ),
        );
      await expect(
        connection.invoke(IPC_CHANNELS.fileSaveContent, [{}]),
      ).rejects.toMatchObject({
        name: 'FileNameConflictError',
        code: 'name_conflict',
        message: 'exists',
      });
    } finally {
      connection.release();
    }
  });

  it('restores a named save conflict after the host bridge and RPC serialization', async () => {
    const { connection, bridges } = setup();
    try {
      await connection.ensure();
      bridges[0].handler = (): Promise<never> =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'file:save-content': FileSaveConflictError: changed",
          ),
        );
      await expect(
        connection.invoke(IPC_CHANNELS.fileSaveContent, [{}]),
      ).rejects.toBeInstanceOf(FileSaveConflictError);
      await expect(
        connection.invoke(IPC_CHANNELS.fileSaveContent, [{}]),
      ).rejects.toMatchObject({ message: 'changed' });
      bridges[0].handler = (): Promise<never> =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'file:save-content': Error: permission denied",
          ),
        );
      await expect(
        connection.invoke(IPC_CHANNELS.fileSaveContent, [{}]),
      ).rejects.toMatchObject({ name: 'RpcRemoteError' });
    } finally {
      connection.release();
    }
  });

  it('reads a host release without the removal pre-check as unchecked, and only that', async () => {
    const olderHost: typeof getRemoteChannelDisposition = (channel) =>
      channel === IPC_CHANNELS.worktreeCheckRemovalAdmission ||
      channel === TUNNEL_CHANNEL
        ? 'local'
        : getRemoteChannelDisposition(channel);
    const { connection } = setup(undefined, {}, { hostDisposition: olderHost });
    try {
      await expect(
        connection.invoke(IPC_CHANNELS.worktreeCheckRemovalAdmission, [{}]),
      ).resolves.toEqual({ status: 'unchecked' });
      await expect(
        connection.invoke(TUNNEL_CHANNEL, [1]),
      ).rejects.toMatchObject({ code: 'remote_channel_unavailable' });
    } finally {
      connection.release();
    }
  });

  it('tunnels the removal pre-check to a current host and keeps its failures', async () => {
    const { connection, bridges } = setup();
    try {
      await expect(
        connection.invoke(IPC_CHANNELS.worktreeCheckRemovalAdmission, [1]),
      ).resolves.toEqual({
        echoed: IPC_CHANNELS.worktreeCheckRemovalAdmission,
        args: [1],
      });
      bridges[0].handler = (): Promise<never> =>
        Promise.reject(new Error('check failed'));
      await expect(
        connection.invoke(IPC_CHANNELS.worktreeCheckRemovalAdmission, [1]),
      ).rejects.toMatchObject({ name: 'RpcRemoteError' });
    } finally {
      connection.release();
    }
  });

  it('connects, learns about the host and tunnels calls', async () => {
    const { connection } = setup();
    connection.keepConnected();
    await expect(connection.invoke(TUNNEL_CHANNEL, [1])).resolves.toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [1],
    });
    expect(connection.status).toBe('connected');
    expect(connection.hostInfo?.name).toBe('desktop');
    connection.release();
  });

  it('uploads a file and returns its path on the host', async () => {
    const { connection } = setup();
    connection.keepConnected();
    const path = await connection.upload(
      'notes.md',
      new TextEncoder().encode('x'),
    );
    expect(path.endsWith('notes.md')).toBe(true);
    connection.release();
  });

  it('holds a pinned transfer to its session, never reconnecting for it', async () => {
    const { connection, hostSessions } = setup();
    connection.keepConnected();
    const pinned = await connection.pinSession();
    expect(pinned.active).toBe(true);
    await expect(pinned.invoke(TUNNEL_CHANNEL, [1])).resolves.toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [1],
    });

    hostSessions[0]?.close('closed');
    // The connection reconnects on its own; the pinned transfer stays behind.
    await waitFor(
      () => hostSessions.length === 2 && connection.status === 'connected',
    );
    expect(pinned.active).toBe(false);
    await expect(pinned.invoke(TUNNEL_CHANNEL, [2])).rejects.toBeInstanceOf(
      RpcClosedError,
    );

    const current = await connection.pinSession();
    connection.release();
    expect(current.active).toBe(false);
    await expect(
      current.readFile({
        absolutePath: '/Users/host/report.pdf',
        offset: 0,
        length: 1,
      }),
    ).rejects.toBeInstanceOf(RpcClosedError);
    await flushRelay(4);
    expect(hostSessions).toHaveLength(2);
  });

  it('closes a session that finishes connecting after it was released', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connection, hostSessions } = setup(async (open) => {
      const session = await open();
      await gate;
      return session;
    });
    connection.keepConnected();
    await waitFor(() => hostSessions.length === 1);
    connection.release();
    release();
    await waitFor(() => hostSessions[0]?.rpc.isClosed === true);
    expect(connection.status).toBe('idle');
  });

  it('recovers when the session closes just as hello completes', async () => {
    let attempts = 0;
    const { connection, hostSessions } = setup(async (open) => {
      const session = await open();
      attempts += 1;
      if (attempts === 1) {
        // Registered before the connection's own listener: it closes the
        // session right after the hello answer is handled, before the
        // connection resumes from awaiting it.
        const stop = session.onMessage(() => {
          stop();
          queueMicrotask(() => session.close('transport_error'));
        });
      }
      return session;
    });
    connection.keepConnected();
    // It retries on its own, without a call asking for the connection.
    await waitFor(() => hostSessions.length === 2);
    await waitFor(() => connection.status === 'connected');
    await expect(connection.invoke(TUNNEL_CHANNEL, [4])).resolves.toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [4],
    });
    connection.release();
  });

  it('closes the session when the host never says hello', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createTestDevice(hub, 'laptop');
    const desktop = createTestDevice(hub, 'desktop');
    const silentHosts: RpcPeer[] = [];
    const connection = new RemoteHostConnection({
      version: TEST_VERSION,
      connect: async (): Promise<SecureSession> => {
        const { initiator, responder } = await openControlSession(
          laptop,
          desktop,
        );
        silentHosts.push(
          new RpcPeer(responder, {
            onRequest: (): Promise<unknown> =>
              Promise.reject(new Error('Not now.')),
            onEvent: (): void => undefined,
          }),
        );
        return initiator;
      },
      onPush: (): void => undefined,
      onDialogOpen: (): Promise<DialogOpenResult> =>
        Promise.resolve({ canceled: true, filePaths: [] }),
      onAppAdvisorWindow: (): Promise<AppAdvisorWindowStateParams> =>
        Promise.reject(new Error('unused')),
      onStatusChange: (): void => undefined,
      onReconnected: (): void => undefined,
      minRetryDelayMs: 60_000,
      maxRetryDelayMs: 60_000,
    });
    await expect(connection.ensure()).rejects.toThrow('Not now.');
    await waitFor(() => silentHosts[0]?.isClosed === true);
    expect(connection.status).toBe('error');
    // A failed attempt is retried, so the session has not ended.
    expect(connection.ended).toBe(false);
    connection.release();
  });

  it('closes the session at once when released while waiting for hello', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createTestDevice(hub, 'laptop');
    const desktop = createTestDevice(hub, 'desktop');
    const silentHosts: RpcPeer[] = [];
    const connection = new RemoteHostConnection({
      version: TEST_VERSION,
      connect: async (): Promise<SecureSession> => {
        const { initiator, responder } = await openControlSession(
          laptop,
          desktop,
        );
        silentHosts.push(
          new RpcPeer(responder, {
            // Never answers: hello stays pending until its timeout.
            onRequest: (): Promise<unknown> => new Promise(() => undefined),
            onEvent: (): void => undefined,
          }),
        );
        return initiator;
      },
      onPush: (): void => undefined,
      onDialogOpen: (): Promise<DialogOpenResult> =>
        Promise.resolve({ canceled: true, filePaths: [] }),
      onAppAdvisorWindow: (): Promise<AppAdvisorWindowStateParams> =>
        Promise.reject(new Error('unused')),
      onStatusChange: (): void => undefined,
      onReconnected: (): void => undefined,
    });
    connection.keepConnected();
    await waitFor(() => silentHosts.length === 1);
    connection.release();
    // Well before the 15 s hello timeout.
    await waitFor(() => silentHosts[0]?.isClosed === true, 500);
    expect(connection.status).toBe('idle');
  });

  it('reconnects after a dropped session and reports it', async () => {
    const { connection, hostSessions, reconnected } = setup();
    connection.keepConnected();
    await connection.invoke(TUNNEL_CHANNEL, []);
    hostSessions[0]?.close('transport_error');
    await waitFor(() => reconnected.count === 1);
    // A dropped session is not an ended one: it came back on its own.
    expect(connection.ended).toBe(false);
    await expect(connection.invoke(TUNNEL_CHANNEL, [2])).resolves.toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [2],
    });
    connection.release();
  });

  it('stays disconnected after the host ends the session, until opened again', async () => {
    const { connection, hostSessions } = setup();
    connection.keepConnected();
    await connection.invoke(TUNNEL_CHANNEL, []);
    hostSessions[0]?.end('disconnected');
    await waitFor(() => connection.status === 'error');
    expect(connection.error).toBe('The other computer ended this session.');
    expect(connection.ended).toBe(true);

    connection.retryNow();
    await flushRelay();
    expect(hostSessions).toHaveLength(1);
    await expect(connection.invoke(TUNNEL_CHANNEL, [])).rejects.toThrow(
      'ended this session',
    );

    connection.keepConnected();
    await expect(connection.invoke(TUNNEL_CHANNEL, [3])).resolves.toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [3],
    });
    expect(connection.ended).toBe(false);
    expect(hostSessions).toHaveLength(2);
    connection.release();
  });

  it('refuses a host on a newer protocol and stays refused until opened again', async () => {
    const { connection, hostSessions, bridges } = setup(undefined, {
      host: {
        protocolVersion: TEST_VERSION.protocolVersion + 1,
        appVersion: '1.1.0',
      },
    });
    connection.keepConnected();
    await expect(connection.invoke(TUNNEL_CHANNEL, [])).rejects.toThrow(
      "desktop runs version 1.1.0, which this computer (version 1.0.0) can't control. Update this computer to connect.",
    );
    expect(connection.status).toBe('error');
    expect(connection.ended).toBe(true);
    // The host served nothing, not even a warmed bridge.
    expect(bridges).toHaveLength(0);
    await waitFor(() => hostSessions[0]?.rpc.isClosed === true);

    connection.retryNow();
    await flushRelay();
    expect(hostSessions).toHaveLength(1);

    connection.keepConnected();
    await waitFor(() => hostSessions.length === 2);
    await waitFor(() => connection.status === 'error');
    expect(connection.ended).toBe(true);
    connection.release();
  });

  it('names the host when its protocol is older', async () => {
    const { connection, bridges } = setup(undefined, {
      laptop: {
        protocolVersion: TEST_VERSION.protocolVersion + 1,
        appVersion: '1.1.0',
      },
    });
    await expect(connection.ensure()).rejects.toThrow(
      "desktop runs version 1.0.0, which this computer (version 1.1.0) can't control. Update desktop to connect.",
    );
    expect(connection.ended).toBe(true);
    expect(bridges).toHaveLength(0);
    connection.release();
  });

  it('connects across app versions that share a protocol', async () => {
    const { connection } = setup(undefined, {
      host: { ...TEST_VERSION, appVersion: '1.4.2' },
    });
    connection.keepConnected();
    await expect(connection.invoke(TUNNEL_CHANNEL, [5])).resolves.toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [5],
    });
    expect(connection.hostInfo?.version).toEqual({
      ...TEST_VERSION,
      appVersion: '1.4.2',
    });
    connection.release();
  });

  it('refuses a host that predates the version check', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createTestDevice(hub, 'laptop');
    const desktop = createTestDevice(hub, 'desktop');
    const legacyHosts: RpcPeer[] = [];
    const served: string[] = [];
    const connection = new RemoteHostConnection({
      version: TEST_VERSION,
      connect: async (): Promise<SecureSession> => {
        const { initiator, responder } = await openControlSession(
          laptop,
          desktop,
        );
        legacyHosts.push(
          new RpcPeer(responder, {
            onRequest: (method: string): Promise<unknown> => {
              served.push(method);
              return Promise.resolve({
                name: 'desktop',
                platform: 'linux',
                appVersion: '0.9.0',
              });
            },
            onEvent: (): void => undefined,
          }),
        );
        return initiator;
      },
      onPush: (): void => undefined,
      onDialogOpen: (): Promise<DialogOpenResult> =>
        Promise.resolve({ canceled: true, filePaths: [] }),
      onAppAdvisorWindow: (): Promise<AppAdvisorWindowStateParams> =>
        Promise.reject(new Error('unused')),
      onStatusChange: (): void => undefined,
      onReconnected: (): void => undefined,
      minRetryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connection.keepConnected();
    await expect(connection.invoke(TUNNEL_CHANNEL, [])).rejects.toThrow(
      "desktop runs version 0.9.0, which this computer (version 1.0.0) can't control. Update desktop to connect.",
    );
    expect(connection.ended).toBe(true);
    await waitFor(() => legacyHosts[0]?.isClosed === true);
    // Only hello reached it, and nothing retried.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(served).toEqual(['session.hello']);
    expect(legacyHosts).toHaveLength(1);
    connection.release();
  });

  it("shows a host's version refusal as is and does not retry", async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createTestDevice(hub, 'laptop');
    const desktop = createTestDevice(hub, 'desktop');
    const hosts: RpcPeer[] = [];
    const connection = new RemoteHostConnection({
      version: TEST_VERSION,
      connect: async (): Promise<SecureSession> => {
        const { initiator, responder } = await openControlSession(
          laptop,
          desktop,
        );
        hosts.push(
          new RpcPeer(responder, {
            onRequest: (): Promise<unknown> =>
              Promise.reject(
                Object.assign(new Error('desktop runs version 2.0.0.'), {
                  code: REMOTE_PROTOCOL_MISMATCH_CODE,
                }),
              ),
            onEvent: (): void => undefined,
          }),
        );
        return initiator;
      },
      onPush: (): void => undefined,
      onDialogOpen: (): Promise<DialogOpenResult> =>
        Promise.resolve({ canceled: true, filePaths: [] }),
      onAppAdvisorWindow: (): Promise<AppAdvisorWindowStateParams> =>
        Promise.reject(new Error('unused')),
      onStatusChange: (): void => undefined,
      onReconnected: (): void => undefined,
      minRetryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connection.keepConnected();
    await waitFor(() => connection.status === 'error');
    expect(connection.error).toBe('desktop runs version 2.0.0.');
    expect(connection.ended).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hosts).toHaveLength(1);
    connection.release();
  });

  describe('account proxy sign-in', () => {
    const STATE = 'state0123456789abcdef';
    const PAGE: AccountProxySignInOpenParams = {
      provider: 'claude',
      url: `https://claude.ai/oauth/authorize?state=${STATE}`,
      state: STATE,
    };

    it('opens what the host asks for, and stops when it says so', async () => {
      const opened: AccountProxySignInOpenParams[] = [];
      const ended: string[] = [];
      const { connection, hostSessions } = setup(
        undefined,
        {},
        {
          connection: {
            onAccountProxySignInOpen: (params): Promise<void> => {
              opened.push(params);
              return Promise.resolve();
            },
            onAccountProxySignInEnded: (state): void => {
              ended.push(state);
            },
          },
        },
      );
      connection.keepConnected();
      await connection.invoke(TUNNEL_CHANNEL, []);
      await hostSessions[0]?.openAccountProxySignIn(PAGE);
      expect(opened).toEqual([PAGE]);
      hostSessions[0]?.endAccountProxySignIn(STATE);
      await waitFor(() => ended.length === 1);
      expect(ended).toEqual([STATE]);
      connection.release();
    });

    it('answers like an older computer when it cannot open sign-ins', async () => {
      const { connection, hostSessions } = setup();
      connection.keepConnected();
      await connection.invoke(TUNNEL_CHANNEL, []);
      const failure = await hostSessions[0]?.openAccountProxySignIn(PAGE).then(
        () => null,
        (error: unknown) => error,
      );
      expect(
        isUnknownRemoteMethodError(
          failure,
          REMOTE_METHODS.accountProxySignInOpen,
        ),
      ).toBe(true);
      connection.release();
    });

    it('sends the caught redirect to the host on the open session', async () => {
      const received: Array<{ device: string; state: string }> = [];
      const { connection, laptop } = setup(
        undefined,
        {},
        {
          completeAccountProxySignIn: (device, callback): Promise<void> => {
            received.push({ device, state: callback.state });
            return Promise.resolve();
          },
        },
      );
      await expect(
        connection.sendAccountProxySignInCallback({
          state: STATE,
          code: 'c',
          error: null,
        }),
      ).rejects.toBeInstanceOf(RpcClosedError);
      connection.keepConnected();
      await connection.invoke(TUNNEL_CHANNEL, []);
      await connection.sendAccountProxySignInCallback({
        state: STATE,
        code: 'c',
        error: null,
      });
      expect(received).toEqual([
        { device: laptop.identity.deviceId, state: STATE },
      ]);
      connection.release();
    });

    it('stops listening when the session drops or the window closes', async () => {
      let endedSessions = 0;
      const { connection, hostSessions, reconnected } = setup(
        undefined,
        {},
        {
          connection: {
            onSessionEnded: (): void => {
              endedSessions += 1;
            },
          },
        },
      );
      connection.keepConnected();
      await connection.invoke(TUNNEL_CHANNEL, []);
      hostSessions[0]?.close('transport_error');
      await waitFor(() => reconnected.count === 1);
      expect(endedSessions).toBe(1);
      connection.release();
      expect(endedSessions).toBe(2);
    });
  });
});
