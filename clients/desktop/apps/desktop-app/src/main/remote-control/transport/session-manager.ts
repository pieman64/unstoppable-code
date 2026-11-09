import { randomBytes } from 'node:crypto';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import type { HostedDelegation } from '@canopy/protocol/remote-control';
import type { DeviceKeyPair } from '../crypto/device-key';
import {
  assertHello1Sender,
  HandshakeError,
  HandshakeInitiator,
  HandshakeResponder,
  Hello1Schema,
  Hello2Schema,
  Hello3Schema,
  Hello4Schema,
  type Hello1,
  type Hello4,
  type HandshakePurpose,
  type HandshakeResult,
} from '../crypto/handshake';
import { SecureChannel } from '../crypto/secure-channel';
import {
  decodeEnvelope,
  encodeEnvelope,
  envelopeHeader,
  SESSION_ID_BYTES,
} from './envelope';
import {
  encodeMessage,
  MessageAssembler,
  type MessageCodecOptions,
} from './message-codec';

/** Minimal view of the relay connection the session layer needs. */
export interface RelayTransport {
  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean;
  onFrame(
    listener: (peerDeviceId: string, payload: Buffer) => void,
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

const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_PENDING_HANDSHAKES_PER_PEER = 4;
const MAX_SESSIONS_PER_PEER = 8;
/** One abort per unknown session per this window, at most this many tracked. */
const UNKNOWN_SESSION_ABORT_WINDOW_MS = 5_000;
const MAX_TRACKED_UNKNOWN_SESSIONS = 256;

/** Abort reason for traffic to a session this side does not have. */
export const UNKNOWN_SESSION_MESSAGE = 'unknown_session';

/**
 * What the responder authorized an incoming session as. Decided at hello1
 * and decided again after hello3; the two decisions must agree.
 */
export interface SessionGrant {
  /** The controller profile the session is held to. */
  readonly kind: DeviceKind;
  /** Whether `kind` came from relay-authenticated presence. */
  readonly kindAuthenticated: boolean;
  /**
   * The pinned hosted root a delegated session is attributed to, or null
   * when the initiator's own key is the pinned identity.
   */
  readonly rootDeviceId: string | null;
  /** Milliseconds since the epoch the grant lapses at, or null. */
  readonly expiresAt: number | null;
}

/** One responder authorization question, asked before hello2 and after hello3. */
export interface HandshakeAdmission {
  stage: 'hello1' | 'hello3';
  purpose: HandshakePurpose;
  initiatorKey: string;
  /** Source device the relay reported. */
  peerDeviceId: string;
  delegation: HostedDelegation | null;
}

function sameGrant(left: SessionGrant, right: SessionGrant): boolean {
  return (
    left.kind === right.kind &&
    left.kindAuthenticated === right.kindAuthenticated &&
    left.rootDeviceId === right.rootDeviceId
  );
}

/** An established, end-to-end encrypted session with one peer device. */
export class SecureSession {
  private readonly channel: SecureChannel;
  private readonly assembler = new MessageAssembler();
  private readonly dataHeader: Buffer;
  private readonly messageListeners = new Set<(value: unknown) => void>();
  private readonly closeListeners = new Set<
    (reason: SessionCloseReason) => void
  >();
  private closedReason: SessionCloseReason | null = null;
  private lastReceivedAtValue = Date.now();

  constructor(
    readonly sessionId: Buffer,
    readonly handshake: HandshakeResult,
    private readonly transport: RelayTransport,
    /** The responder's authorization; null on the initiating side. */
    readonly grant: SessionGrant | null = null,
  ) {
    this.channel = new SecureChannel(handshake.sendKey, handshake.receiveKey);
    this.dataHeader = envelopeHeader('data', sessionId);
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

  /** Sends one message; returns false when the session or relay is down. */
  sendMessage(
    value: unknown,
    options: Pick<MessageCodecOptions, 'onSerialized'> = {},
  ): boolean {
    if (this.closedReason !== null) return false;
    // An unserializable value throws here and fails only this message.
    const fragments = encodeMessage(value, options);
    try {
      for (const fragment of fragments) {
        const sealed = this.channel.seal(fragment, this.dataHeader);
        const delivered = this.transport.sendFrame(
          this.peerDeviceId,
          Buffer.concat([this.dataHeader, sealed]),
        );
        if (!delivered) {
          this.close('transport_error');
          return false;
        }
      }
    } catch {
      // Encryption or socket failures must never escape into timers or event
      // handlers in main; end the session instead.
      this.close('transport_error');
      return false;
    }
    return true;
  }

  /** Feeds one data envelope body; protocol violations end the session. */
  receive(body: Buffer): void {
    if (this.closedReason !== null) return;
    let decoded: { complete: true; value: unknown } | null;
    try {
      const fragment = this.channel.open(body, this.dataHeader);
      this.lastReceivedAtValue = Date.now();
      decoded = this.assembler.push(fragment);
    } catch {
      this.close('protocol_error');
      return;
    }
    if (decoded === null) return;
    for (const listener of Array.from(this.messageListeners))
      listener(decoded.value);
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

export interface SessionManagerOptions {
  transport: RelayTransport;
  identity: () => DeviceKeyPair;
  /**
   * Responder-side authorization for an incoming handshake, asked before
   * hello2 and again after hello3. Null (or a throw) refuses it. It may
   * persist first, for example to narrow a pairing's kind before access.
   */
  authorize: (
    request: HandshakeAdmission,
  ) => SessionGrant | null | Promise<SessionGrant | null>;
  onIncomingSession: (session: SecureSession) => void;
  handshakeTimeoutMs?: number;
}

export interface ConnectOptions {
  peerDeviceId: string;
  purpose: HandshakePurpose;
  pinnedPeerPublicKey: string | null;
  /** A hosted root's grant for this device's key, sent in hello1. */
  delegation?: HostedDelegation;
}

interface PendingInitiator {
  handshake: HandshakeInitiator;
  resolve: (session: SecureSession) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingResponder {
  /** Null while hello1 is being authorized. */
  handshake: HandshakeResponder | null;
  grant: SessionGrant | null;
  /** Hello3 arrived and its recheck is running. */
  finishing: boolean;
  sessionId: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

function sessionKey(peerDeviceId: string, sessionId: Buffer): string {
  return `${peerDeviceId}:${sessionId.toString('hex')}`;
}

function parseJson(body: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return value;
  } catch {
    return null;
  }
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/**
 * Runs handshakes and routes encrypted envelopes for every session over one
 * relay connection. The controller initiates; the controlled device responds.
 */
export class RemoteSessionManager {
  private readonly sessions = new Map<string, SecureSession>();
  private readonly initiators = new Map<string, PendingInitiator>();
  private readonly responders = new Map<string, PendingResponder>();
  /** Unknown sessions recently answered with an abort, and when. */
  private readonly abortedUnknown = new Map<string, number>();
  private readonly unsubscribers: Array<() => void>;
  private disposed = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.unsubscribers = [
      options.transport.onFrame((peer, payload) =>
        this.handleFrame(peer, payload),
      ),
      options.transport.onPeerOffline((peer) => this.handlePeerOffline(peer)),
      // A frame to a peer the relay does not have: it is offline, whatever
      // presence said. Fail its handshakes now instead of at their timeout,
      // so a retry can start as soon as it is back.
      options.transport.onUndeliverable((peer) => this.handlePeerOffline(peer)),
    ];
  }

  private get handshakeTimeoutMs(): number {
    return this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  connect(options: ConnectOptions): Promise<SecureSession> {
    if (this.disposed) {
      return Promise.reject(new Error('Remote sessions are shut down.'));
    }
    const refusal = this.admissionRefusal(options.peerDeviceId);
    if (refusal !== null) return Promise.reject(new Error(refusal));
    const sessionId = randomBytes(SESSION_ID_BYTES);
    const key = sessionKey(options.peerDeviceId, sessionId);
    const handshake = new HandshakeInitiator({
      sessionId,
      purpose: options.purpose,
      identity: this.options.identity(),
      peerDeviceId: options.peerDeviceId,
      pinnedPeerPublicKey: options.pinnedPeerPublicKey,
      ...(options.delegation ? { delegation: options.delegation } : {}),
    });
    return new Promise<SecureSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initiators.delete(key);
        reject(new Error('The other computer did not answer the connection.'));
      }, this.handshakeTimeoutMs);
      this.initiators.set(key, { handshake, resolve, reject, timer });
      const sent = this.options.transport.sendFrame(
        options.peerDeviceId,
        encodeEnvelope('hello1', sessionId, jsonBody(handshake.start())),
      );
      if (!sent) {
        clearTimeout(timer);
        this.initiators.delete(key);
        reject(new Error('Not connected to the relay.'));
      }
    });
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
    for (const pending of Array.from(this.initiators.values())) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Remote sessions are shut down.'));
    }
    this.initiators.clear();
    for (const pending of Array.from(this.responders.values()))
      clearTimeout(pending.timer);
    this.responders.clear();
    for (const session of Array.from(this.sessions.values())) {
      session.close('shutdown');
    }
  }

  private trackSession(key: string, session: SecureSession): void {
    this.sessions.set(key, session);
    session.onClose((reason) => {
      this.sessions.delete(key);
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
   * or null. Both directions count, so two computers connecting to each
   * other at once cannot pass the limits together.
   */
  private admissionRefusal(peer: string): string | null {
    const pending =
      this.countForPeer(this.initiators, peer) +
      this.countForPeer(this.responders, peer);
    if (
      pending >= MAX_PENDING_HANDSHAKES_PER_PEER ||
      pending + this.countForPeer(this.sessions, peer) >= MAX_SESSIONS_PER_PEER
    ) {
      return 'Too many connections with this device.';
    }
    return null;
  }

  private countForPeer(map: Map<string, unknown>, peer: string): number {
    let count = 0;
    for (const key of Array.from(map.keys())) {
      if (key.startsWith(`${peer}:`)) count += 1;
    }
    return count;
  }

  private abort(peer: string, sessionId: Buffer, message: string): void {
    this.options.transport.sendFrame(
      peer,
      encodeEnvelope('abort', sessionId, jsonBody({ message })),
    );
  }

  private handleFrame(peer: string, payload: Buffer): void {
    if (this.disposed) return;
    const envelope = decodeEnvelope(payload);
    if (envelope === null) return;
    const key = sessionKey(peer, envelope.sessionId);
    try {
      switch (envelope.type) {
        case 'data': {
          const session = this.sessions.get(key);
          if (session) session.receive(envelope.body);
          else this.answerUnknownSession(peer, envelope.sessionId, key);
          return;
        }
        case 'hello1':
          this.handleHello1(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'hello2':
          this.handleHello2(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'hello3':
          this.handleHello3(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'hello4':
          this.handleHello4(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'abort':
          this.handleAbort(key, envelope.body);
          return;
      }
    } catch (error) {
      this.failHandshake(peer, envelope.sessionId, key, error);
    }
  }

  private failHandshake(
    peer: string,
    sessionId: Buffer,
    key: string,
    error: unknown,
  ): void {
    const message =
      error instanceof Error ? error.message : 'Connection refused.';
    const initiator = this.initiators.get(key);
    if (initiator) {
      clearTimeout(initiator.timer);
      this.initiators.delete(key);
      initiator.reject(
        error instanceof Error ? error : new Error('Connection refused.'),
      );
      return;
    }
    const responder = this.responders.get(key);
    if (responder) {
      clearTimeout(responder.timer);
      this.responders.delete(key);
    }
    this.abort(peer, sessionId, message);
  }

  private handleHello1(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    if (this.responders.has(key) || this.sessions.has(key)) return;
    const refusal = this.admissionRefusal(peer);
    if (refusal !== null) {
      this.abort(peer, sessionId, refusal);
      return;
    }
    const hello1 = Hello1Schema.parse(parseJson(body));
    assertHello1Sender(hello1, peer);
    // The slot counts against the peer's limits while it is authorized.
    const pending: PendingResponder = {
      handshake: null,
      grant: null,
      finishing: false,
      sessionId,
      timer: setTimeout(() => {
        if (this.responders.get(key) === pending) this.responders.delete(key);
      }, this.handshakeTimeoutMs),
    };
    this.responders.set(key, pending);
    void this.admitHello1(peer, sessionId, key, hello1, pending);
  }

  private async authorizeSafely(
    request: HandshakeAdmission,
  ): Promise<SessionGrant | null> {
    try {
      return await this.options.authorize(request);
    } catch {
      return null;
    }
  }

  private async admitHello1(
    peer: string,
    sessionId: Buffer,
    key: string,
    hello1: Hello1,
    pending: PendingResponder,
  ): Promise<void> {
    const grant = await this.authorizeSafely({
      stage: 'hello1',
      purpose: hello1.purpose,
      initiatorKey: hello1.initiatorKey,
      peerDeviceId: peer,
      delegation: hello1.delegation ?? null,
    });
    // Abandoned meanwhile: timed out, aborted, peer offline or shut down.
    if (this.disposed || this.responders.get(key) !== pending) return;
    try {
      if (grant === null) {
        throw new HandshakeError(
          'unauthorized_peer',
          'This computer has not allowed that device.',
        );
      }
      const handshake = new HandshakeResponder({
        sessionId,
        identity: this.options.identity(),
        peerDeviceId: peer,
        authorize: (): boolean => true,
      });
      const hello2 = handshake.receiveHello1(hello1);
      pending.handshake = handshake;
      pending.grant = grant;
      this.options.transport.sendFrame(
        peer,
        encodeEnvelope('hello2', sessionId, jsonBody(hello2)),
      );
    } catch (error) {
      this.failHandshake(peer, sessionId, key, error);
    }
  }

  /**
   * Tells a peer that a session it is using does not exist here, for example
   * because this computer restarted, so the peer ends it at once instead of
   * waiting for its keepalive to time out. Throttled per session; never sent
   * in reply to an abort, so two sides cannot bounce aborts.
   */
  private answerUnknownSession(
    peer: string,
    sessionId: Buffer,
    key: string,
  ): void {
    const now = Date.now();
    const last = this.abortedUnknown.get(key);
    if (last !== undefined && now - last < UNKNOWN_SESSION_ABORT_WINDOW_MS) {
      return;
    }
    if (this.abortedUnknown.size >= MAX_TRACKED_UNKNOWN_SESSIONS) {
      for (const [tracked, at] of Array.from(this.abortedUnknown)) {
        if (now - at >= UNKNOWN_SESSION_ABORT_WINDOW_MS) {
          this.abortedUnknown.delete(tracked);
        }
      }
      if (this.abortedUnknown.size >= MAX_TRACKED_UNKNOWN_SESSIONS) return;
    }
    this.abortedUnknown.set(key, now);
    this.abort(peer, sessionId, UNKNOWN_SESSION_MESSAGE);
  }

  private handleHello2(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const pending = this.initiators.get(key);
    if (!pending) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const hello3 = pending.handshake.receiveHello2(
      Hello2Schema.parse(parseJson(body)),
    );
    this.options.transport.sendFrame(
      peer,
      encodeEnvelope('hello3', sessionId, jsonBody(hello3)),
    );
  }

  private handleHello3(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const pending = this.responders.get(key);
    if (!pending) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    if (pending.finishing) return;
    const handshake = pending.handshake;
    const grant = pending.grant;
    if (handshake === null || grant === null) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello3.');
    }
    const finished = handshake.receiveHello3(
      Hello3Schema.parse(parseJson(body)),
    );
    pending.finishing = true;
    void this.finishResponder(peer, sessionId, key, pending, grant, finished);
  }

  private async finishResponder(
    peer: string,
    sessionId: Buffer,
    key: string,
    pending: PendingResponder,
    first: SessionGrant,
    finished: { hello4: Hello4; result: HandshakeResult },
  ): Promise<void> {
    const { hello4, result } = finished;
    // Authorized at hello1; check again now, since the peer may have been
    // revoked, or its delegation lapsed, while the handshake was in flight.
    const grant = await this.authorizeSafely({
      stage: 'hello3',
      purpose: result.purpose,
      initiatorKey: result.peerPublicKey,
      peerDeviceId: peer,
      delegation: result.delegation,
    });
    if (this.disposed || this.responders.get(key) !== pending) return;
    clearTimeout(pending.timer);
    this.responders.delete(key);
    if (grant === null || !sameGrant(first, grant)) {
      this.abort(peer, sessionId, 'This computer is not allowed to connect.');
      return;
    }
    const session = new SecureSession(
      sessionId,
      result,
      this.options.transport,
      grant,
    );
    this.trackSession(key, session);
    const sent = this.options.transport.sendFrame(
      peer,
      encodeEnvelope('hello4', sessionId, jsonBody(hello4)),
    );
    if (!sent) {
      // The initiator never learns the handshake finished, so it would never
      // use this session: end it rather than serve one side of it.
      session.close('transport_error');
      return;
    }
    this.options.onIncomingSession(session);
  }

  private handleHello4(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const pending = this.initiators.get(key);
    if (!pending) {
      // The initiator gave up (timed out); the responder's new session must
      // not wait for a keepalive timeout to end.
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const result = pending.handshake.receiveHello4(
      Hello4Schema.parse(parseJson(body)),
    );
    clearTimeout(pending.timer);
    this.initiators.delete(key);
    const session = new SecureSession(
      sessionId,
      result,
      this.options.transport,
    );
    this.trackSession(key, session);
    pending.resolve(session);
  }

  private handleAbort(key: string, body: Buffer): void {
    const session = this.sessions.get(key);
    if (session) {
      session.close('peer_closed');
      return;
    }
    const responder = this.responders.get(key);
    if (responder) {
      // The initiator gave up; free its slot now, not at the timeout.
      clearTimeout(responder.timer);
      this.responders.delete(key);
      return;
    }
    const pending = this.initiators.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.initiators.delete(key);
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
      clearTimeout(pending.timer);
      this.initiators.delete(key);
      pending.reject(new Error(message));
    }
    for (const [key, pending] of Array.from(this.responders)) {
      if (!key.startsWith(`${peer}:`)) continue;
      clearTimeout(pending.timer);
      this.responders.delete(key);
      if (reason !== 'peer_offline') {
        this.abort(peer, pending.sessionId, message);
      }
    }
  }

  private handlePeerOffline(peer: string): void {
    this.closePeer(peer, 'peer_offline');
  }
}
