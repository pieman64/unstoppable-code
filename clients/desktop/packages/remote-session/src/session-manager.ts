import type { HostedDelegation } from '@canopy/protocol/remote-control';
import { MAX_MESSAGE_BYTES } from '@canopy/protocol/remote-control';
import { hexOf, utf8, type Bytes } from './bytes';
import { PEER_REFUSAL_MESSAGES, RemoteSessionError } from './errors';
import {
  HandshakeError,
  HandshakeInitiator,
  HandshakeResponder,
  Hello1Schema,
  Hello2Schema,
  Hello3Schema,
  Hello4Schema,
  type HandshakePurpose,
  type HandshakeResult,
} from './handshake';
import type { DeviceIdentity } from './identity';
import {
  fragmentMessage,
  MessageAssembler,
  serializeMessage,
} from './message-codec';
import { defaultScheduler, type SchedulerPort } from './scheduler';
import { SecureChannel } from './secure-channel';
import {
  decodeEnvelope,
  encodeEnvelope,
  envelopeHeader,
  SESSION_ID_BYTES,
  type EnvelopeType,
} from './envelope';
import { randomBytes } from './web-crypto';

/** Minimal view of the relay connection the session layer needs. */
export interface RelayTransport {
  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean;
  onFrame(
    listener: (peerDeviceId: string, payload: Uint8Array) => void,
  ): () => void;
  onPeerOffline(listener: (peerDeviceId: string) => void): () => void;
  /** The relay could not deliver a frame because the peer is not connected. */
  onUndeliverable(listener: (peerDeviceId: string) => void): () => void;
}

export type SessionCloseReason =
  | 'closed'
  | 'peer_closed'
  | 'peer_offline'
  | 'protocol_error'
  | 'transport_error'
  | 'timeout'
  | 'revoked'
  | 'shutdown';

export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_PENDING_HANDSHAKES_PER_PEER = 4;
export const MAX_SESSIONS_PER_PEER = 8;
/** One abort per unknown session per this window, at most this many tracked. */
export const UNKNOWN_SESSION_ABORT_WINDOW_MS = 5_000;
export const MAX_TRACKED_UNKNOWN_SESSIONS = 256;
/** Serialized bytes a session may hold waiting to be sealed and sent. */
export const MAX_SESSION_QUEUED_SEND_BYTES = 2 * MAX_MESSAGE_BYTES;
export const MAX_SESSION_QUEUED_SENDS = 1_024;
/** Sealed bytes a session may hold waiting to be opened. */
export const MAX_SESSION_QUEUED_RECEIVE_BYTES = 2 * MAX_MESSAGE_BYTES;
/** Frames one handshake may queue while an earlier step is still running. */
const MAX_QUEUED_HANDSHAKE_FRAMES = 32;

/** Abort reason for traffic to a session this side does not have. */
export const UNKNOWN_SESSION_MESSAGE = 'unknown_session';

/**
 * Whether a failed `connect` means the peer refused this device itself (not
 * paired there, removed, kind refused, or incoming control turned off), as
 * opposed to admission limits, timeouts or protocol failures. A controller
 * whose pinned host refuses it must pair again; retrying cannot help.
 */
export function isPeerRefusal(error: unknown): boolean {
  return (
    error instanceof HandshakeError &&
    error.code === 'unauthorized_peer' &&
    (error.message === PEER_REFUSAL_MESSAGES.hello1 ||
      error.message === PEER_REFUSAL_MESSAGES.hello3)
  );
}

/**
 * An established, end-to-end encrypted session with one peer device.
 *
 * Sending and receiving each run on one serialized chain: messages are
 * sealed and transmitted in call order, and frames are opened and reassembled
 * in arrival order. Any failure on either chain closes the session, which
 * fails everything still queued; nothing is retried.
 */
export class SecureSession {
  private readonly assembler = new MessageAssembler();
  private readonly dataHeader: Bytes;
  private readonly messageListeners = new Set<(value: unknown) => void>();
  private readonly closeListeners = new Set<
    (reason: SessionCloseReason) => void
  >();
  private closedReason: SessionCloseReason | null = null;
  private lastReceivedAtValue: number;
  private sendChain: Promise<void> = Promise.resolve();
  private receiveChain: Promise<void> = Promise.resolve();
  private queuedSendBytes = 0;
  private queuedSends = 0;
  private queuedReceiveBytes = 0;

  private constructor(
    readonly sessionId: Bytes,
    readonly handshake: HandshakeResult,
    private readonly channel: SecureChannel,
    private readonly transport: RelayTransport,
    private readonly scheduler: SchedulerPort,
  ) {
    this.dataHeader = envelopeHeader('data', sessionId);
    this.lastReceivedAtValue = scheduler.now();
  }

  static async create(
    sessionId: Bytes,
    handshake: HandshakeResult,
    transport: RelayTransport,
    scheduler: SchedulerPort = defaultScheduler,
  ): Promise<SecureSession> {
    const channel = await SecureChannel.create(
      handshake.sendKey,
      handshake.receiveKey,
    );
    return new SecureSession(
      sessionId,
      handshake,
      channel,
      transport,
      scheduler,
    );
  }

  get peerDeviceId(): string {
    return this.handshake.peerDeviceId;
  }

  get purpose(): HandshakePurpose {
    return this.handshake.purpose;
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  get closeReason(): SessionCloseReason | null {
    return this.closedReason;
  }

  /**
   * When an authenticated frame last arrived, whole message or fragment, so
   * a large message still arriving counts as activity.
   */
  get lastReceivedAt(): number {
    return this.lastReceivedAtValue;
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: SessionCloseReason) => void): () => void {
    if (this.closedReason !== null) {
      listener(this.closedReason);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Sends one message. The value is serialized now; an unserializable or
   * oversized value rejects with `MessageCodecError` and leaves the session
   * open. A full queue rejects with `queue_full` and sends nothing. Resolves
   * once every fragment was handed to the relay.
   */
  send(value: unknown): Promise<void> {
    const queued = this.enqueue(value);
    return queued.accepted ? queued.sent : Promise.reject(queued.error);
  }

  /**
   * `send`, reporting synchronously whether the message was queued: refused
   * when the session is closed, the value cannot be serialized, or the queue
   * is full.
   */
  enqueue(
    value: unknown,
  ):
    | { accepted: true; sent: Promise<void> }
    | { accepted: false; error: Error } {
    if (this.closedReason !== null) {
      return {
        accepted: false,
        error: new RemoteSessionError(
          'not_connected',
          'The session is closed.',
        ),
      };
    }
    let serialized: Bytes;
    try {
      serialized = serializeMessage(value);
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    if (
      this.queuedSends >= MAX_SESSION_QUEUED_SENDS ||
      this.queuedSendBytes + serialized.byteLength >
        MAX_SESSION_QUEUED_SEND_BYTES
    ) {
      return {
        accepted: false,
        error: new RemoteSessionError(
          'queue_full',
          'Too many messages are waiting to be sent.',
        ),
      };
    }
    this.queuedSends += 1;
    this.queuedSendBytes += serialized.byteLength;
    const step = this.sendChain.then(async () => {
      try {
        await this.transmit(serialized);
      } finally {
        this.queuedSends -= 1;
        this.queuedSendBytes -= serialized.byteLength;
      }
    });
    this.sendChain = step.catch(() => undefined);
    return { accepted: true, sent: step };
  }

  private async transmit(serialized: Bytes): Promise<void> {
    if (this.closedReason !== null) {
      throw new RemoteSessionError('not_connected', 'The session is closed.');
    }
    try {
      const fragments = await fragmentMessage(serialized);
      for (const fragment of fragments) {
        if (this.closedReason !== null) {
          throw new RemoteSessionError(
            'not_connected',
            'The session is closed.',
          );
        }
        const sealed = await this.channel.seal(fragment, this.dataHeader);
        if (this.closedReason !== null) {
          throw new RemoteSessionError(
            'not_connected',
            'The session is closed.',
          );
        }
        const frame = new Uint8Array(
          this.dataHeader.byteLength + sealed.byteLength,
        );
        frame.set(this.dataHeader);
        frame.set(sealed, this.dataHeader.byteLength);
        if (!this.transport.sendFrame(this.peerDeviceId, frame)) {
          throw new RemoteSessionError(
            'not_connected',
            'Not connected to the relay.',
          );
        }
      }
    } catch (error) {
      // A sealed counter was used or a frame may be missing: the peer would
      // see a gap, so the session cannot continue.
      this.close('transport_error');
      throw error;
    }
  }

  /** Feeds one data envelope body; protocol violations end the session. */
  receive(body: Uint8Array): void {
    if (this.closedReason !== null) return;
    this.queuedReceiveBytes += body.byteLength;
    if (this.queuedReceiveBytes > MAX_SESSION_QUEUED_RECEIVE_BYTES) {
      this.close('protocol_error');
      return;
    }
    this.receiveChain = this.receiveChain
      .then(async () => {
        this.queuedReceiveBytes -= body.byteLength;
        if (this.closedReason !== null) return;
        const fragment = await this.channel.open(body, this.dataHeader);
        if (this.closedReason !== null) return;
        this.lastReceivedAtValue = this.scheduler.now();
        const decoded = await this.assembler.push(fragment);
        if (decoded === null || this.closedReason !== null) return;
        for (const listener of Array.from(this.messageListeners)) {
          listener(decoded.value);
        }
      })
      .catch(() => {
        this.close('protocol_error');
      });
  }

  /**
   * Closes once every frame that arrived before now has been delivered. A
   * peer's abort follows its last data frames on the wire, and opening a
   * frame here is asynchronous, so closing at once would drop them (the
   * answer to a `pair.revoke` among them).
   */
  closeAfterReceived(reason: SessionCloseReason): void {
    if (this.closedReason !== null) return;
    this.receiveChain = this.receiveChain.then(() => this.close(reason));
  }

  close(reason: SessionCloseReason): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.messageListeners.clear();
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    for (const listener of listeners) listener(reason);
  }
}

/** What a responder is asked before hello2 and again after hello3. */
export interface IncomingSessionAuthorization {
  stage: 'hello1' | 'hello3';
  purpose: HandshakePurpose;
  initiatorKey: string;
  peerDeviceId: string;
  delegation: HostedDelegation | null;
  /** Present after hello3 only. */
  transcriptHash: Bytes | null;
}

export interface SessionManagerOptions {
  transport: RelayTransport;
  identity: () => DeviceIdentity;
  /**
   * Responder-side authorization, asked before hello2 and again after hello3
   * so a revocation or delegation expiry in between refuses the session.
   * Without it, every incoming handshake is refused (controllers only
   * initiate).
   */
  authorize?: (
    request: IncomingSessionAuthorization,
  ) => boolean | Promise<boolean>;
  onIncomingSession?: (session: SecureSession) => void;
  handshakeTimeoutMs?: number;
  scheduler?: SchedulerPort;
}

export interface ConnectOptions {
  peerDeviceId: string;
  purpose: HandshakePurpose;
  pinnedPeerPublicKey: string | null;
  /** Hosted delegation for this manager's identity, carried in hello1. */
  delegation?: HostedDelegation | null;
}

interface PendingInitiator {
  handshake: HandshakeInitiator | null;
  resolve: (session: SecureSession) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

interface PendingResponder {
  handshake: HandshakeResponder | null;
  sessionId: Bytes;
  timer: unknown;
}

interface KeyChain {
  tail: Promise<void>;
  queued: number;
}

function sessionKey(peerDeviceId: string, sessionId: Uint8Array): string {
  return `${peerDeviceId}:${hexOf(sessionId)}`;
}

function parseJson(body: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value;
  } catch {
    return null;
  }
}

function jsonBody(value: unknown): Bytes {
  return utf8(JSON.stringify(value));
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/**
 * Runs handshakes and routes encrypted envelopes for every session over one
 * relay connection, with the desktop's limits: a 15 s handshake deadline, 4
 * pending handshakes and 8 sessions per peer (both directions counted), and
 * one unknown-session abort per session per 5 s (256 tracked).
 *
 * WebCrypto makes handshake steps asynchronous, so frames for a session whose
 * handshake step is still running wait behind it (bounded); established data
 * frames go straight to their session's receive chain.
 */
export class RemoteSessionManager {
  private readonly sessions = new Map<string, SecureSession>();
  private readonly initiators = new Map<string, PendingInitiator>();
  private readonly responders = new Map<string, PendingResponder>();
  private readonly chains = new Map<string, KeyChain>();
  /** Unknown sessions recently answered with an abort, and when. */
  private readonly abortedUnknown = new Map<string, number>();
  private readonly unsubscribers: Array<() => void>;
  private readonly scheduler: SchedulerPort;
  private disposed = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.unsubscribers = [
      options.transport.onFrame((peer, payload) =>
        this.handleFrame(peer, payload),
      ),
      options.transport.onPeerOffline((peer) => this.handlePeerOffline(peer)),
      // A frame to a peer the relay does not have: it is offline, whatever
      // presence said. Fail its handshakes now instead of at their timeout.
      options.transport.onUndeliverable((peer) => this.handlePeerOffline(peer)),
    ];
  }

  private get handshakeTimeoutMs(): number {
    return this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  /** Sessions and handshakes currently held, for diagnostics and tests. */
  get counts(): { sessions: number; initiators: number; responders: number } {
    return {
      sessions: this.sessions.size,
      initiators: this.initiators.size,
      responders: this.responders.size,
    };
  }

  connect(options: ConnectOptions): Promise<SecureSession> {
    if (this.disposed) {
      return Promise.reject(
        new RemoteSessionError('shut_down', 'Remote sessions are shut down.'),
      );
    }
    const refusal = this.admissionRefusal(options.peerDeviceId);
    if (refusal !== null) {
      return Promise.reject(
        new RemoteSessionError('admission_refused', refusal),
      );
    }
    const sessionId = randomBytes(SESSION_ID_BYTES);
    const key = sessionKey(options.peerDeviceId, sessionId);
    return new Promise<SecureSession>((resolve, reject) => {
      const entry: PendingInitiator = {
        handshake: null,
        resolve,
        reject,
        timer: this.scheduler.setTimeout(() => {
          if (this.initiators.get(key) !== entry) return;
          this.initiators.delete(key);
          reject(
            new RemoteSessionError(
              'handshake_timeout',
              'The other computer did not answer the connection.',
            ),
          );
        }, this.handshakeTimeoutMs),
      };
      // Registered before any await, so admission limits hold.
      this.initiators.set(key, entry);
      void this.startInitiator(options, sessionId, key, entry);
    });
  }

  private async startInitiator(
    options: ConnectOptions,
    sessionId: Bytes,
    key: string,
    entry: PendingInitiator,
  ): Promise<void> {
    try {
      const handshake = await HandshakeInitiator.create({
        sessionId,
        purpose: options.purpose,
        identity: this.options.identity(),
        peerDeviceId: options.peerDeviceId,
        pinnedPeerPublicKey: options.pinnedPeerPublicKey,
        delegation: options.delegation ?? null,
      });
      const hello1 = await handshake.start();
      if (this.initiators.get(key) !== entry) return;
      entry.handshake = handshake;
      const sent = this.options.transport.sendFrame(
        options.peerDeviceId,
        encodeEnvelope('hello1', sessionId, jsonBody(hello1)),
      );
      if (!sent) {
        this.dropInitiator(key, entry);
        entry.reject(
          new RemoteSessionError(
            'not_connected',
            'Not connected to the relay.',
          ),
        );
      }
    } catch (error) {
      if (this.initiators.get(key) !== entry) return;
      this.dropInitiator(key, entry);
      entry.reject(asError(error, 'Connection failed.'));
    }
  }

  private dropInitiator(key: string, entry: PendingInitiator): void {
    this.scheduler.clearTimeout(entry.timer);
    if (this.initiators.get(key) === entry) this.initiators.delete(key);
  }

  private dropResponder(key: string, entry: PendingResponder): void {
    this.scheduler.clearTimeout(entry.timer);
    if (this.responders.get(key) === entry) this.responders.delete(key);
  }

  /** Closes every session with one peer (for example after revocation). */
  closePeer(peerDeviceId: string, reason: SessionCloseReason): void {
    this.cancelHandshakes(peerDeviceId, reason);
    for (const session of Array.from(this.sessions.values())) {
      if (session.peerDeviceId === peerDeviceId) session.close(reason);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const [key, pending] of Array.from(this.initiators)) {
      this.dropInitiator(key, pending);
      pending.reject(
        new RemoteSessionError('shut_down', 'Remote sessions are shut down.'),
      );
    }
    for (const [key, pending] of Array.from(this.responders)) {
      this.dropResponder(key, pending);
    }
    for (const session of Array.from(this.sessions.values())) {
      session.close('shutdown');
    }
    this.chains.clear();
  }

  private trackSession(key: string, session: SecureSession): void {
    this.sessions.set(key, session);
    session.onClose((reason) => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      // Tell the peer at once instead of leaving it to its keepalive. The
      // abort is unauthenticated, so it can only end a session, which a
      // relay could already do by dropping frames.
      if (reason !== 'peer_closed' && reason !== 'peer_offline') {
        this.abort(session.peerDeviceId, session.sessionId, reason);
      }
    });
  }

  /**
   * Why another handshake with this peer, in either direction, is refused,
   * or null. Both directions count, so two devices connecting to each other
   * at once cannot pass the limits together.
   */
  private admissionRefusal(peer: string): string | null {
    const pending =
      countForPeer(this.initiators, peer) + countForPeer(this.responders, peer);
    if (
      pending >= MAX_PENDING_HANDSHAKES_PER_PEER ||
      pending + countForPeer(this.sessions, peer) >= MAX_SESSIONS_PER_PEER
    ) {
      return 'Too many connections with this device.';
    }
    return null;
  }

  private abort(peer: string, sessionId: Uint8Array, message: string): void {
    this.options.transport.sendFrame(
      peer,
      encodeEnvelope('abort', sessionId, jsonBody({ message })),
    );
  }

  private send(
    peer: string,
    type: EnvelopeType,
    sessionId: Uint8Array,
    body: unknown,
  ): boolean {
    return this.options.transport.sendFrame(
      peer,
      encodeEnvelope(type, sessionId, jsonBody(body)),
    );
  }

  private handleFrame(peer: string, payload: Uint8Array): void {
    if (this.disposed) return;
    const envelope = decodeEnvelope(payload);
    if (envelope === null) return;
    const key = sessionKey(peer, envelope.sessionId);
    const chain = this.chains.get(key);
    if (chain === undefined) {
      if (envelope.type === 'data') {
        const session = this.sessions.get(key);
        if (session) session.receive(envelope.body);
        else this.answerUnknownSession(peer, envelope.sessionId, key);
        return;
      }
      if (envelope.type === 'abort') {
        this.handleAbort(key, envelope.body);
        return;
      }
      if (
        envelope.type === 'hello1' &&
        !this.admitHello1(peer, envelope.sessionId, key)
      ) {
        return;
      }
      if (
        (envelope.type === 'hello2' || envelope.type === 'hello4') &&
        !this.initiators.has(key)
      ) {
        this.answerUnknownSession(peer, envelope.sessionId, key);
        return;
      }
      if (envelope.type === 'hello3' && !this.responders.has(key)) {
        this.answerUnknownSession(peer, envelope.sessionId, key);
        return;
      }
    }
    this.enqueue(key, () =>
      this.processFrame(
        peer,
        envelope.type,
        envelope.sessionId,
        key,
        envelope.body,
      ),
    );
  }

  /** Runs frame work for one session key strictly in arrival order. */
  private enqueue(key: string, work: () => Promise<void>): void {
    const chain = this.chains.get(key) ?? {
      tail: Promise.resolve(),
      queued: 0,
    };
    if (chain.queued >= MAX_QUEUED_HANDSHAKE_FRAMES) return;
    chain.queued += 1;
    chain.tail = chain.tail.then(async () => {
      try {
        if (!this.disposed) await work();
      } finally {
        chain.queued -= 1;
        if (chain.queued === 0 && this.chains.get(key) === chain)
          this.chains.delete(key);
      }
    });
    this.chains.set(key, chain);
  }

  private async processFrame(
    peer: string,
    type: EnvelopeType,
    sessionId: Bytes,
    key: string,
    body: Bytes,
  ): Promise<void> {
    try {
      switch (type) {
        case 'data': {
          const session = this.sessions.get(key);
          if (session) session.receive(body);
          else this.answerUnknownSession(peer, sessionId, key);
          return;
        }
        case 'abort':
          this.handleAbort(key, body);
          return;
        case 'hello1':
          await this.handleHello1(peer, sessionId, key, body);
          return;
        case 'hello2':
          await this.handleHello2(peer, sessionId, key, body);
          return;
        case 'hello3':
          await this.handleHello3(peer, sessionId, key, body);
          return;
        case 'hello4':
          await this.handleHello4(peer, sessionId, key, body);
          return;
      }
    } catch (error) {
      this.failHandshake(peer, sessionId, key, error);
    }
  }

  private failHandshake(
    peer: string,
    sessionId: Uint8Array,
    key: string,
    error: unknown,
  ): void {
    const message =
      error instanceof Error ? error.message : 'Connection refused.';
    const initiator = this.initiators.get(key);
    if (initiator) {
      this.dropInitiator(key, initiator);
      initiator.reject(asError(error, 'Connection refused.'));
      return;
    }
    const responder = this.responders.get(key);
    if (responder) this.dropResponder(key, responder);
    this.abort(peer, sessionId, message);
  }

  /** Synchronous admission for hello1, so limits hold before any await. */
  private admitHello1(peer: string, sessionId: Bytes, key: string): boolean {
    if (this.responders.has(key) || this.sessions.has(key)) return false;
    const refusal = this.admissionRefusal(peer);
    if (refusal !== null) {
      this.abort(peer, sessionId, refusal);
      return false;
    }
    const entry: PendingResponder = {
      handshake: null,
      sessionId,
      timer: this.scheduler.setTimeout(() => {
        if (this.responders.get(key) === entry) this.responders.delete(key);
      }, this.handshakeTimeoutMs),
    };
    this.responders.set(key, entry);
    return true;
  }

  private async handleHello1(
    peer: string,
    sessionId: Bytes,
    key: string,
    body: Bytes,
  ): Promise<void> {
    const entry = this.responders.get(key);
    if (!entry || entry.handshake !== null) return;
    const hello1 = Hello1Schema.parse(parseJson(body));
    const authorize = this.options.authorize;
    const handshake = await HandshakeResponder.create({
      sessionId,
      identity: this.options.identity(),
      peerDeviceId: peer,
      authorize: async (request) =>
        authorize !== undefined &&
        (await authorize({
          stage: 'hello1',
          purpose: request.purpose,
          initiatorKey: request.initiatorKey,
          peerDeviceId: peer,
          delegation: request.delegation,
          transcriptHash: null,
        })),
    });
    if (this.responders.get(key) !== entry) return;
    entry.handshake = handshake;
    const hello2 = await handshake.receiveHello1(hello1);
    if (this.responders.get(key) !== entry) return;
    this.send(peer, 'hello2', sessionId, hello2);
  }

  /**
   * Tells a peer that a session it is using does not exist here, so it ends
   * it at once instead of waiting for its keepalive. Throttled per session;
   * never sent in reply to an abort, so two sides cannot bounce aborts.
   */
  private answerUnknownSession(
    peer: string,
    sessionId: Uint8Array,
    key: string,
  ): void {
    const now = this.scheduler.now();
    const last = this.abortedUnknown.get(key);
    if (last !== undefined && now - last < UNKNOWN_SESSION_ABORT_WINDOW_MS)
      return;
    if (this.abortedUnknown.size >= MAX_TRACKED_UNKNOWN_SESSIONS) {
      for (const [tracked, at] of Array.from(this.abortedUnknown)) {
        if (now - at >= UNKNOWN_SESSION_ABORT_WINDOW_MS)
          this.abortedUnknown.delete(tracked);
      }
      if (this.abortedUnknown.size >= MAX_TRACKED_UNKNOWN_SESSIONS) return;
    }
    this.abortedUnknown.set(key, now);
    this.abort(peer, sessionId, UNKNOWN_SESSION_MESSAGE);
  }

  private async handleHello2(
    peer: string,
    sessionId: Bytes,
    key: string,
    body: Bytes,
  ): Promise<void> {
    const entry = this.initiators.get(key);
    if (!entry || entry.handshake === null) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const hello3 = await entry.handshake.receiveHello2(
      Hello2Schema.parse(parseJson(body)),
    );
    if (this.initiators.get(key) !== entry) return;
    this.send(peer, 'hello3', sessionId, hello3);
  }

  private async handleHello3(
    peer: string,
    sessionId: Bytes,
    key: string,
    body: Bytes,
  ): Promise<void> {
    const entry = this.responders.get(key);
    if (!entry || entry.handshake === null) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const { hello4, result } = await entry.handshake.receiveHello3(
      Hello3Schema.parse(parseJson(body)),
    );
    if (this.responders.get(key) !== entry) return;
    this.dropResponder(key, entry);
    // Authorized before hello2; ask again now, since the peer may have been
    // revoked, or its delegation expired, while the handshake was in flight.
    const authorize = this.options.authorize;
    const allowed =
      authorize !== undefined &&
      (await authorize({
        stage: 'hello3',
        purpose: result.purpose,
        initiatorKey: result.peerPublicKey,
        peerDeviceId: peer,
        delegation: result.delegation,
        transcriptHash: result.transcriptHash,
      }));
    if (!allowed || this.disposed) {
      this.abort(peer, sessionId, PEER_REFUSAL_MESSAGES.hello3);
      return;
    }
    const session = await SecureSession.create(
      sessionId,
      result,
      this.options.transport,
      this.scheduler,
    );
    if (this.disposed) {
      session.close('shutdown');
      return;
    }
    this.trackSession(key, session);
    if (!this.send(peer, 'hello4', sessionId, hello4)) {
      // The initiator never learns the handshake finished, so it would never
      // use this session: end it rather than serve one side of it.
      session.close('transport_error');
      return;
    }
    this.options.onIncomingSession?.(session);
  }

  private async handleHello4(
    peer: string,
    sessionId: Bytes,
    key: string,
    body: Bytes,
  ): Promise<void> {
    const entry = this.initiators.get(key);
    if (!entry || entry.handshake === null) {
      // The initiator gave up (timed out); the responder's new session must
      // not wait for a keepalive timeout to end.
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const result = await entry.handshake.receiveHello4(
      Hello4Schema.parse(parseJson(body)),
    );
    if (this.initiators.get(key) !== entry) return;
    const session = await SecureSession.create(
      sessionId,
      result,
      this.options.transport,
      this.scheduler,
    );
    if (this.initiators.get(key) !== entry) {
      session.close('closed');
      return;
    }
    this.dropInitiator(key, entry);
    this.trackSession(key, session);
    entry.resolve(session);
  }

  private handleAbort(key: string, body: Uint8Array): void {
    const session = this.sessions.get(key);
    if (session) {
      session.closeAfterReceived('peer_closed');
      return;
    }
    const responder = this.responders.get(key);
    if (responder) {
      // The initiator gave up; free its slot now, not at the timeout.
      this.dropResponder(key, responder);
      return;
    }
    const pending = this.initiators.get(key);
    if (!pending) return;
    this.dropInitiator(key, pending);
    const parsed = parseJson(body);
    const message =
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
        ? parsed.message
        : 'The other computer refused the connection.';
    pending.reject(new HandshakeError('unauthorized_peer', message));
  }

  /**
   * Abandons every handshake in flight with `peer`, so a handshake that was
   * authorized before a revocation cannot finish after it.
   */
  private cancelHandshakes(peer: string, reason: SessionCloseReason): void {
    const message =
      reason === 'peer_offline'
        ? 'The other computer went offline.'
        : 'The connection was closed.';
    for (const [key, pending] of Array.from(this.initiators)) {
      if (!key.startsWith(`${peer}:`)) continue;
      this.dropInitiator(key, pending);
      pending.reject(new RemoteSessionError('not_connected', message));
    }
    for (const [key, pending] of Array.from(this.responders)) {
      if (!key.startsWith(`${peer}:`)) continue;
      this.dropResponder(key, pending);
      if (reason !== 'peer_offline')
        this.abort(peer, pending.sessionId, message);
    }
  }

  private handlePeerOffline(peer: string): void {
    this.closePeer(peer, 'peer_offline');
  }
}

function countForPeer(map: ReadonlyMap<string, unknown>, peer: string): number {
  let count = 0;
  for (const key of Array.from(map.keys())) {
    if (key.startsWith(`${peer}:`)) count += 1;
  }
  return count;
}
