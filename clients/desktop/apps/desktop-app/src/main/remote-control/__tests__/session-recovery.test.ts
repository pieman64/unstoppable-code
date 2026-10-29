import { randomBytes } from 'node:crypto';
import {
  DEVICE_RELAY_DATA_FRAME_OVERHEAD_BYTES,
  DEVICE_RELAY_MAX_FRAME_BYTES,
  type DeviceRelayDeviceInfo,
} from '@canopy/protocol/device-relay';
import {
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from '../crypto/device-key';
import { decodeEnvelope, encodeEnvelope } from '../transport/envelope';
import { RpcPeer, RpcRemoteError } from '../transport/rpc-peer';
import {
  RemoteSessionManager,
  UNKNOWN_SESSION_MESSAGE,
  type SecureSession,
  type SessionCloseReason,
} from '../transport/session-manager';
import {
  flushRelay,
  InMemoryRelayEndpoint,
  InMemoryRelayHub,
} from './in-memory-relay';

interface Device {
  identity: DeviceKeyPair;
  endpoint: InMemoryRelayEndpoint;
  manager: RemoteSessionManager;
  incoming: SecureSession[];
}

function info(identity: DeviceKeyPair, name: string): DeviceRelayDeviceInfo {
  return {
    deviceId: identity.deviceId,
    name,
    platform: 'linux',
    appVersion: '1.0.0',
    publicKey: identity.publicKey,
    acceptsRemoteControl: true,
  };
}

function createManager(
  endpoint: InMemoryRelayEndpoint,
  identity: DeviceKeyPair,
  incoming: SecureSession[],
  authorize: () => boolean = () => true,
): RemoteSessionManager {
  return new RemoteSessionManager({
    transport: endpoint,
    identity: () => identity,
    authorize,
    onIncomingSession: (session) => incoming.push(session),
  });
}

function createDevice(
  hub: InMemoryRelayHub,
  name: string,
  authorize: () => boolean = () => true,
): Device {
  const identity = generateDeviceKeyPair();
  const endpoint = new InMemoryRelayEndpoint(
    hub,
    () => info(identity, name),
    () => undefined,
  );
  endpoint.start();
  const incoming: SecureSession[] = [];
  return {
    identity,
    endpoint,
    manager: createManager(endpoint, identity, incoming, authorize),
    incoming,
  };
}

async function connect(
  from: Device,
  to: Device,
): Promise<{ initiator: SecureSession; responder: SecureSession }> {
  const before = to.incoming.length;
  const pending = from.manager.connect({
    peerDeviceId: to.identity.deviceId,
    purpose: 'control',
    pinnedPeerPublicKey: to.identity.publicKey,
  });
  await flushRelay();
  const initiator = await pending;
  const responder = to.incoming[before];
  if (!responder) throw new Error('No incoming session.');
  return { initiator, responder };
}

function closeReason(session: SecureSession): {
  reason: SessionCloseReason | null;
} {
  const state: { reason: SessionCloseReason | null } = { reason: null };
  session.onClose((reason) => {
    state.reason = reason;
  });
  return state;
}

function received(session: SecureSession): unknown[] {
  const values: unknown[] = [];
  session.onMessage((value) => values.push(value));
  return values;
}

/** Aborts `from` sent to `to`, as their decoded reasons. */
function abortsBetween(
  frames: Array<{ from: string; to: string; payload: Buffer }>,
  from: Device,
  to: Device,
): string[] {
  return frames
    .filter(
      (frame) =>
        frame.from === from.identity.deviceId &&
        frame.to === to.identity.deviceId,
    )
    .map((frame) => decodeEnvelope(frame.payload))
    .filter((envelope) => envelope?.type === 'abort')
    .map((envelope) => {
      const body: unknown = JSON.parse(envelope?.body.toString('utf8') ?? '{}');
      return typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string'
        ? body.message
        : '';
    });
}

/** Records every frame the hub routes. */
function recordFrames(
  hub: InMemoryRelayHub,
): Array<{ from: string; to: string; payload: Buffer }> {
  const frames: Array<{ from: string; to: string; payload: Buffer }> = [];
  hub.tap = (from, to, payload): Buffer => {
    frames.push({ from, to, payload: Buffer.from(payload) });
    return payload;
  };
  return frames;
}

describe('remote session recovery', () => {
  it('does not let a peer revoked mid-handshake finish it', async () => {
    const hub = new InMemoryRelayHub();
    let authorized = true;
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop', () => authorized);
    // Hold the controller's third handshake message in flight.
    const held: Buffer[] = [];
    hub.tap = (from, _to, payload): Buffer | null => {
      if (
        from === laptop.identity.deviceId &&
        decodeEnvelope(payload)?.type === 'hello3'
      ) {
        held.push(payload);
        return null;
      }
      return payload;
    };
    const attempt = laptop.manager.connect({
      peerDeviceId: desktop.identity.deviceId,
      purpose: 'control',
      pinnedPeerPublicKey: desktop.identity.publicKey,
    });
    const settled = attempt.then(
      () => 'connected',
      () => 'refused',
    );
    await flushRelay();
    expect(held).toHaveLength(1);

    // The desktop revokes the controller, then the held message arrives.
    authorized = false;
    desktop.manager.closePeer(laptop.identity.deviceId, 'revoked');
    hub.tap = null;
    const message = held[0];
    if (message === undefined) throw new Error('No held message.');
    laptop.endpoint.sendFrame(desktop.identity.deviceId, message);
    await flushRelay();

    expect(desktop.incoming).toEqual([]);
    expect(await settled).toBe('refused');
  });

  it('ends a session at its next message when the other computer restarted', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const { initiator } = await connect(laptop, desktop);
    const state = closeReason(initiator);

    // The desktop's process dies without a word: nothing it would have sent
    // on the way down reaches the laptop.
    hub.tap = (from, _to, payload): Buffer | null =>
      from === desktop.identity.deviceId ? null : payload;
    desktop.manager.dispose();
    hub.tap = null;
    // It starts again with the same identity and no sessions.
    desktop.manager = createManager(
      desktop.endpoint,
      desktop.identity,
      desktop.incoming,
    );

    expect(initiator.sendMessage({ hello: 'again' })).toBe(true);
    await flushRelay();
    expect(state.reason).toBe('peer_closed');

    // A new session works at once.
    const { initiator: next, responder } = await connect(laptop, desktop);
    const values = received(responder);
    next.sendMessage({ after: 'restart' });
    await flushRelay();
    expect(values).toEqual([{ after: 'restart' }]);
  });

  it('ends both sides of a session whose frame was corrupted, then reconnects', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const { initiator, responder } = await connect(laptop, desktop);
    const initiatorState = closeReason(initiator);
    const responderState = closeReason(responder);

    hub.tap = (_from, _to, payload): Buffer => {
      const corrupted = Buffer.from(payload);
      const last = corrupted.byteLength - 1;
      corrupted[last] = (corrupted[last] ?? 0) ^ 0xff;
      return corrupted;
    };
    initiator.sendMessage({ value: 1 });
    await flushRelay();
    hub.tap = null;
    await flushRelay();

    expect(responderState.reason).toBe('protocol_error');
    expect(initiatorState.reason).toBe('peer_closed');
    const { initiator: next, responder: nextResponder } = await connect(
      laptop,
      desktop,
    );
    const values = received(nextResponder);
    next.sendMessage({ value: 2 });
    await flushRelay();
    expect(values).toEqual([{ value: 2 }]);
  });

  it('never skips a lost frame: the next one ends the session', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const { initiator, responder } = await connect(laptop, desktop);
    const responderState = closeReason(responder);
    const values = received(responder);

    let dropped = false;
    hub.tap = (_from, _to, payload): Buffer | null => {
      if (dropped) return payload;
      dropped = true;
      return null;
    };
    initiator.sendMessage({ value: 'lost' });
    initiator.sendMessage({ value: 'after the gap' });
    await flushRelay();
    expect(values).toEqual([]);
    expect(responderState.reason).toBe('protocol_error');
  });

  it('fails a handshake at once when the relay cannot reach the peer', async () => {
    const hub = new InMemoryRelayHub();
    hub.reportUndeliverable = true;
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    desktop.endpoint.stop();
    const startedAt = Date.now();
    const attempt = laptop.manager.connect({
      peerDeviceId: desktop.identity.deviceId,
      purpose: 'control',
      pinnedPeerPublicKey: desktop.identity.publicKey,
    });
    const failed = expect(attempt).rejects.toThrow('offline');
    await flushRelay();
    await failed;
    // Not the 15 s handshake timeout.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('frees the host for a peer whose handshakes were aborted', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    // Five attempts the controller gives up on after hello2 (more than the
    // four pending handshakes a host allows per peer).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let sessionId: Buffer | null = null;
      hub.tap = (from, _to, payload): Buffer | null => {
        const envelope = decodeEnvelope(payload);
        if (envelope?.type === 'hello1') sessionId = envelope.sessionId;
        return envelope?.type === 'hello3' ? null : payload;
      };
      // A controller that gives up drops its own handshake too, so each
      // attempt runs in its own manager.
      const attemptManager = createManager(
        laptop.endpoint,
        laptop.identity,
        [],
      );
      void attemptManager
        .connect({
          peerDeviceId: desktop.identity.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: desktop.identity.publicKey,
        })
        .catch(() => undefined);
      await flushRelay();
      if (sessionId === null) throw new Error('No hello1.');
      hub.tap = null;
      laptop.endpoint.sendFrame(
        desktop.identity.deviceId,
        encodeEnvelope(
          'abort',
          sessionId,
          Buffer.from(JSON.stringify({ message: 'gave up' })),
        ),
      );
      await flushRelay();
      attemptManager.dispose();
    }
    // A fresh attempt is not refused for too many connections.
    const { responder } = await connect(laptop, desktop);
    expect(responder.isClosed).toBe(false);
    laptop.manager.dispose();
  });

  it('counts handshakes in flight against the per-peer session cap', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    for (let index = 0; index < 7; index += 1) await connect(laptop, desktop);
    const attempts = Array.from({ length: 4 }, () =>
      laptop.manager
        .connect({
          peerDeviceId: desktop.identity.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: desktop.identity.publicKey,
        })
        .then(
          () => 'connected',
          () => 'refused',
        ),
    );
    await flushRelay(40);
    const results = await Promise.all(attempts);
    expect(results.filter((result) => result === 'connected')).toHaveLength(1);
    expect(
      desktop.incoming.filter((session) => !session.isClosed),
    ).toHaveLength(8);
    laptop.manager.dispose();
  });

  it('keeps the session cap when both computers connect at once', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    for (let index = 0; index < 7; index += 1) await connect(laptop, desktop);
    const settle = (attempt: Promise<SecureSession>): Promise<string> =>
      attempt.then(
        () => 'connected',
        () => 'refused',
      );
    const attempts = [
      settle(
        laptop.manager.connect({
          peerDeviceId: desktop.identity.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: desktop.identity.publicKey,
        }),
      ),
      settle(
        desktop.manager.connect({
          peerDeviceId: laptop.identity.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: laptop.identity.publicKey,
        }),
      ),
    ];
    await flushRelay(40);
    const results = await Promise.all(attempts);
    expect(
      results.filter((result) => result === 'connected').length,
    ).toBeLessThanOrEqual(1);
    const open = (device: Device): number =>
      device.incoming.filter((session) => !session.isClosed).length;
    // Each side's incoming sessions are the ones the other side started.
    expect(open(desktop) + open(laptop)).toBeLessThanOrEqual(8);
    laptop.manager.dispose();
    desktop.manager.dispose();
  });

  it('refuses a fifth outgoing handshake to one computer', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    // Hold every frame to the desktop, so the handshakes stay pending.
    hub.tap = (_from, to, payload): Buffer | null =>
      to === desktop.identity.deviceId ? null : payload;
    const attempts = Array.from({ length: 5 }, () =>
      laptop.manager
        .connect({
          peerDeviceId: desktop.identity.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: desktop.identity.publicKey,
        })
        .then(
          () => 'connected',
          (error: unknown) =>
            error instanceof Error ? error.message : 'refused',
        ),
    );
    const fifth = await Promise.race([
      attempts[4],
      flushRelay(5).then(() => 'pending'),
    ]);
    expect(fifth).toMatch(/too many/i);
    laptop.manager.dispose();
  });

  it('answers traffic to an unknown session with one abort per window', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const frames = recordFrames(hub);
    const sessionId = randomBytes(16);
    for (let index = 0; index < 50; index += 1) {
      laptop.endpoint.sendFrame(
        desktop.identity.deviceId,
        encodeEnvelope('data', sessionId, randomBytes(40)),
      );
    }
    // An abort for an unknown session is never answered, so two sides
    // cannot bounce aborts.
    laptop.endpoint.sendFrame(
      desktop.identity.deviceId,
      encodeEnvelope(
        'abort',
        randomBytes(16),
        Buffer.from(JSON.stringify({ message: 'injected' })),
      ),
    );
    await flushRelay();
    expect(abortsBetween(frames, desktop, laptop)).toEqual([
      UNKNOWN_SESSION_MESSAGE,
    ]);
    expect(abortsBetween(frames, laptop, desktop)).toEqual(['injected']);
  });

  it('splits large messages into frames that fill the relay limit exactly', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const { initiator, responder } = await connect(laptop, desktop);
    const values = received(responder);
    const frames = recordFrames(hub);

    // Random bytes do not deflate, so the message is split as is.
    const payload = randomBytes(300 * 1024);
    expect(initiator.sendMessage({ payload })).toBe(true);
    await flushRelay(60);

    const sizes = frames.map((frame) => frame.payload.byteLength);
    const limit =
      DEVICE_RELAY_MAX_FRAME_BYTES - DEVICE_RELAY_DATA_FRAME_OVERHEAD_BYTES;
    expect(Math.max(...sizes)).toBe(limit);
    expect(sizes.length).toBeGreaterThan(4);
    expect(values).toEqual([{ payload }]);
  });
});

describe('remote session handshake delivery', () => {
  it('does not publish a session whose last handshake message could not be sent', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const send = desktop.endpoint.sendFrame.bind(desktop.endpoint);
    jest
      .spyOn(desktop.endpoint, 'sendFrame')
      .mockImplementation((peer: string, payload: Uint8Array): boolean =>
        decodeEnvelope(payload)?.type === 'hello4'
          ? false
          : send(peer, payload),
      );
    const attempt = laptop.manager
      .connect({
        peerDeviceId: desktop.identity.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: desktop.identity.publicKey,
      })
      .then(
        () => 'connected',
        () => 'failed',
      );
    await flushRelay();
    expect(desktop.incoming).toEqual([]);
    laptop.manager.dispose();
    expect(await attempt).toBe('failed');
  });
});

describe('rpc peer', () => {
  async function rpcPair(
    options: ConstructorParameters<typeof RpcPeer>[1] = {
      onRequest: (method: string, params: unknown): Promise<unknown> =>
        method === 'echo'
          ? Promise.resolve(params)
          : Promise.reject(
              Object.assign(new Error('Nope.'), { code: 'not_found' }),
            ),
      onEvent: (): void => undefined,
    },
  ): Promise<{ hub: InMemoryRelayHub; client: RpcPeer; server: RpcPeer }> {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const { initiator, responder } = await connect(laptop, desktop);
    const server = new RpcPeer(responder, options);
    const client = new RpcPeer(initiator, {
      onRequest: (): Promise<unknown> => Promise.reject(new Error('unused')),
      onEvent: (): void => undefined,
      keepaliveIntervalMs: options.keepaliveIntervalMs,
      idleTimeoutMs: options.idleTimeoutMs,
    });
    return { hub, client, server };
  }

  it('answers requests and carries remote error codes back', async () => {
    const { client } = await rpcPair();
    const echoed = client.request('echo', { at: new Date(0), n: 1 });
    await flushRelay();
    await expect(echoed).resolves.toEqual({ at: new Date(0), n: 1 });
    const failing = client.request('missing', null);
    const caught = failing.catch((error: unknown) => error);
    await flushRelay();
    const error = await caught;
    expect(error).toBeInstanceOf(RpcRemoteError);
    expect(error).toMatchObject({ message: 'Nope.', code: 'not_found' });
    expect(client.pendingRequests).toBe(0);
  });

  it('starts no keepalive for a session that is already closed', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createDevice(hub, 'laptop');
    const desktop = createDevice(hub, 'desktop');
    const { initiator } = await connect(laptop, desktop);
    initiator.close('closed');
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    try {
      const peer = new RpcPeer(initiator, {
        onRequest: (): Promise<unknown> => Promise.resolve(null),
        onEvent: (): void => undefined,
      });
      expect(peer.isClosed).toBe(true);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('cleans up a request whose parameters cannot be sent', async () => {
    const { client } = await rpcPair();
    await expect(client.request('echo', { fn: () => 1 })).rejects.toThrow();
    expect(client.pendingRequests).toBe(0);
  });

  it('keeps a session alive while a large message is still arriving', async () => {
    // Advance only the clock: the in-memory relay still delivers real frames.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const hub = new InMemoryRelayHub();
      const laptop = createDevice(hub, 'laptop');
      const desktop = createDevice(hub, 'desktop');
      try {
        const { initiator, responder } = await connect(laptop, desktop);
        new RpcPeer(responder, {
          onRequest: (_method: string, params: unknown): Promise<unknown> =>
            Promise.resolve(params),
          onEvent: (): void => undefined,
          keepaliveIntervalMs: 60_000,
        });
        const client = new RpcPeer(initiator, {
          onRequest: (): Promise<unknown> =>
            Promise.reject(new Error('unused')),
          onEvent: (): void => undefined,
          keepaliveIntervalMs: 10,
          idleTimeoutMs: 500,
        });
        const queue: Array<{ from: string; payload: Buffer }> = [];
        hub.tap = (from, to, payload): Buffer | null => {
          if (to !== laptop.identity.deviceId) return payload;
          queue.push({ from, payload: Buffer.from(payload) });
          return null;
        };
        const payload = randomBytes(60 * 60 * 1024);
        const answer = client
          .request('echo', payload, { timeoutMs: null })
          .catch((error: unknown) => error);
        await flushRelay();
        // The reply must span more than two idle windows, with no whole
        // message (or server keepalive) refreshing the client in between.
        const startedAt = Date.now();
        expect(queue.length * 20).toBeGreaterThan(2 * 500);
        let completedMessages = 0;
        initiator.onMessage(() => completedMessages++);
        for (const frame of queue) {
          await jest.advanceTimersByTimeAsync(20);
          expect(client.isClosed).toBe(false);
          expect(completedMessages).toBe(0);
          laptop.endpoint.deliver(frame.from, frame.payload);
        }
        expect(Date.now() - startedAt).toBeGreaterThan(2 * 500);
        await expect(answer).resolves.toEqual(payload);
        expect(completedMessages).toBe(1);
        expect(client.isClosed).toBe(false);

        await jest.advanceTimersByTimeAsync(510);
        expect(client.isClosed).toBe(true);
      } finally {
        laptop.manager.dispose();
        desktop.manager.dispose();
      }
    } finally {
      jest.useRealTimers();
    }
  }, 20_000);

  it('ends a session the other side has stopped answering', async () => {
    const { hub, client } = await rpcPair({
      onRequest: (): Promise<unknown> => Promise.resolve(null),
      onEvent: (): void => undefined,
      keepaliveIntervalMs: 10,
      idleTimeoutMs: 40,
    });
    const reasons: string[] = [];
    client.onClose((reason) => reasons.push(reason));
    // Everything toward the client is lost from here on.
    hub.tap = (): Buffer | null => null;
    const pending = client.request('echo', 1, { timeoutMs: null });
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    for (let index = 0; index < 50 && reasons.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reasons).toEqual(['timeout']);
    expect(await settled).toBe('rejected');
    expect(client.pendingRequests).toBe(0);
  });
});
