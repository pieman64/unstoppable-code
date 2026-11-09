import { z } from 'zod';
import {
  HostedDelegationSchema,
  type HostedDelegation,
} from '@canopy/protocol/remote-control';
import {
  bytesEqual,
  concatBytes,
  decodeBase64Url,
  encodeBase64Url,
  readUint32BE,
  uint32BE,
  utf8,
  type Bytes,
} from './bytes';
import { PEER_REFUSAL_MESSAGES } from './errors';
import {
  deriveDeviceId,
  signWithIdentity,
  verifyEd25519,
  type DeviceIdentity,
} from './identity';
import { hkdfSha256, randomBytes, sha256, subtleCrypto } from './web-crypto';

/**
 * Mutually authenticated key exchange between two devices over the untrusted
 * relay; a byte-for-byte port of the desktop handshake
 * (`apps/desktop-app/src/main/remote-control/crypto/handshake.ts`).
 *
 *   1. I → R  hello1  { purpose, initiatorKey, commitment = H("commit"||eI||nI), delegation? }
 *   2. R → I  hello2  { responderKey, eR, nR }
 *   3. I → R  hello3  { eI, nI, sig_I("initiator" || transcript) }
 *   4. R → I  hello4  { sig_R("responder" || transcript) }
 *
 * The transcript hash is SHA-256 over the u32-length-prefixed protocol label,
 * purpose, session ID, both identity keys, commitment, both ephemeral keys
 * and both nonces, in that order. Traffic keys are HKDF-SHA256 over
 * X25519(eI, eR) salted with the transcript: 32 bytes initiator→responder,
 * then 32 bytes responder→initiator. The six-digit short authentication
 * string is the big-endian u32 of a 4-byte HKDF output modulo 1,000,000.
 *
 * An optional hosted delegation rides in hello1. It is not transcript input:
 * its session key must equal `initiatorKey`, which the transcript binds.
 */
export const HANDSHAKE_PROTOCOL = 'canopy-remote-control/1';

export type HandshakePurpose = 'control' | 'pair';

const RAW_X25519_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const SESSION_ID_BYTES = 16;

const base64UrlField = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const Hello1Schema = z.object({
  protocol: z.literal(HANDSHAKE_PROTOCOL),
  purpose: z.enum(['control', 'pair']),
  initiatorKey: base64UrlField,
  commitment: base64UrlField,
  delegation: HostedDelegationSchema.optional(),
});
export type Hello1 = z.infer<typeof Hello1Schema>;

export const Hello2Schema = z.object({
  responderKey: base64UrlField,
  ephemeral: base64UrlField,
  nonce: base64UrlField,
});
export type Hello2 = z.infer<typeof Hello2Schema>;

export const Hello3Schema = z.object({
  ephemeral: base64UrlField,
  nonce: base64UrlField,
  signature: base64UrlField,
});
export type Hello3 = z.infer<typeof Hello3Schema>;

export const Hello4Schema = z.object({ signature: base64UrlField });
export type Hello4 = z.infer<typeof Hello4Schema>;

export interface HandshakeResult {
  purpose: HandshakePurpose;
  peerDeviceId: string;
  peerPublicKey: string;
  sendKey: Bytes;
  receiveKey: Bytes;
  /** Transcript hash; pairing proofs MAC it. */
  transcriptHash: Bytes;
  /** Six-digit short authentication string for first-time pairing. */
  shortAuthenticationString: string;
  /** The delegation hello1 carried (sent by an initiator, received by a responder). */
  delegation: HostedDelegation | null;
}

export type HandshakeErrorCode =
  | 'protocol'
  | 'unexpected_message'
  | 'unauthorized_peer'
  | 'peer_key_mismatch'
  | 'bad_commitment'
  | 'bad_signature'
  | 'weak_key';

export class HandshakeError extends Error {
  constructor(
    readonly code: HandshakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

interface Ephemeral {
  privateKey: CryptoKey;
  publicKey: string;
  nonce: string;
}

async function createEphemeral(): Promise<Ephemeral> {
  const subtle = subtleCrypto();
  const pair = await subtle.generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ]);
  if (!('privateKey' in pair)) {
    throw new HandshakeError('protocol', 'X25519 key generation failed.');
  }
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey: encodeBase64Url(raw),
    nonce: encodeBase64Url(randomBytes(NONCE_BYTES)),
  };
}

function decodeField(value: string, name: string): Bytes {
  try {
    return decodeBase64Url(value);
  } catch {
    throw new HandshakeError('protocol', `Malformed ${name}.`);
  }
}

async function importX25519PublicKey(value: string): Promise<CryptoKey> {
  const raw = decodeField(value, 'ephemeral key');
  if (raw.byteLength !== RAW_X25519_KEY_BYTES) {
    throw new HandshakeError('protocol', 'Malformed ephemeral key.');
  }
  try {
    return await subtleCrypto().importKey(
      'raw',
      raw,
      { name: 'X25519' },
      true,
      [],
    );
  } catch {
    throw new HandshakeError('weak_key', 'Peer ephemeral key is invalid.');
  }
}

async function commitmentFor(
  ephemeral: string,
  nonce: string,
): Promise<string> {
  return encodeBase64Url(
    await sha256([
      utf8('commit'),
      decodeField(ephemeral, 'ephemeral key'),
      decodeField(nonce, 'nonce'),
    ]),
  );
}

interface TranscriptFields {
  purpose: HandshakePurpose;
  sessionId: Uint8Array;
  initiatorKey: string;
  responderKey: string;
  commitment: string;
  initiatorEphemeral: string;
  initiatorNonce: string;
  responderEphemeral: string;
  responderNonce: string;
}

async function transcriptHash(fields: TranscriptFields): Promise<Bytes> {
  const parts: Uint8Array[] = [];
  for (const part of [
    utf8(HANDSHAKE_PROTOCOL),
    utf8(fields.purpose),
    fields.sessionId,
    decodeField(fields.initiatorKey, 'initiator key'),
    decodeField(fields.responderKey, 'responder key'),
    decodeField(fields.commitment, 'commitment'),
    decodeField(fields.initiatorEphemeral, 'ephemeral key'),
    decodeField(fields.initiatorNonce, 'nonce'),
    decodeField(fields.responderEphemeral, 'ephemeral key'),
    decodeField(fields.responderNonce, 'nonce'),
  ]) {
    parts.push(uint32BE(part.byteLength), part);
  }
  return sha256(parts);
}

function roleMessage(
  role: 'initiator' | 'responder',
  transcript: Bytes,
): Bytes {
  return concatBytes([utf8(role), transcript]);
}

async function signTranscript(
  identity: DeviceIdentity,
  role: 'initiator' | 'responder',
  transcript: Bytes,
): Promise<string> {
  return encodeBase64Url(
    await signWithIdentity(identity, roleMessage(role, transcript)),
  );
}

async function verifyTranscript(
  peerPublicKey: string,
  role: 'initiator' | 'responder',
  transcript: Bytes,
  signature: string,
): Promise<void> {
  let valid = false;
  try {
    valid = await verifyEd25519(
      peerPublicKey,
      roleMessage(role, transcript),
      decodeField(signature, 'signature'),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new HandshakeError('bad_signature', 'Peer signature is invalid.');
  }
}

async function peerDeviceIdFor(publicKey: string): Promise<string> {
  try {
    return await deriveDeviceId(publicKey);
  } catch {
    throw new HandshakeError('protocol', 'Malformed identity key.');
  }
}

async function deriveResult(
  role: 'initiator' | 'responder',
  purpose: HandshakePurpose,
  ownEphemeral: Ephemeral,
  peerEphemeral: string,
  peerPublicKey: string,
  transcript: Bytes,
  delegation: HostedDelegation | null,
): Promise<HandshakeResult> {
  const peerKey = await importX25519PublicKey(peerEphemeral);
  let shared: Bytes;
  try {
    shared = new Uint8Array(
      await subtleCrypto().deriveBits(
        { name: 'X25519', public: peerKey },
        ownEphemeral.privateKey,
        256,
      ),
    );
  } catch {
    // WebCrypto refuses small-order points (an all-zero shared secret).
    throw new HandshakeError('weak_key', 'Peer ephemeral key is degenerate.');
  }
  if (shared.every((byte) => byte === 0)) {
    throw new HandshakeError('weak_key', 'Peer ephemeral key is degenerate.');
  }
  const traffic = await hkdfSha256(
    shared,
    transcript,
    `${HANDSHAKE_PROTOCOL} traffic`,
    64,
  );
  const initiatorToResponder = traffic.slice(0, 32);
  const responderToInitiator = traffic.slice(32, 64);
  const sas = readUint32BE(
    await hkdfSha256(shared, transcript, `${HANDSHAKE_PROTOCOL} sas`, 4),
    0,
  );
  return {
    purpose,
    peerDeviceId: await peerDeviceIdFor(peerPublicKey),
    peerPublicKey,
    sendKey: role === 'initiator' ? initiatorToResponder : responderToInitiator,
    receiveKey:
      role === 'initiator' ? responderToInitiator : initiatorToResponder,
    transcriptHash: transcript,
    shortAuthenticationString: String(sas % 1_000_000).padStart(6, '0'),
    delegation,
  };
}

function assertSessionId(sessionId: Uint8Array): void {
  if (sessionId.byteLength !== SESSION_ID_BYTES) {
    throw new Error('Session IDs are 16 bytes.');
  }
}

export interface HandshakeInitiatorOptions {
  sessionId: Uint8Array;
  purpose: HandshakePurpose;
  identity: DeviceIdentity;
  /** Device the initiator addressed through the relay. */
  peerDeviceId: string;
  /**
   * Pinned public key for `control` sessions. Pairing has no pin yet; the
   * peer key must still hash to `peerDeviceId`.
   */
  pinnedPeerPublicKey: string | null;
  /** Hosted delegation for this session's identity, sent in hello1. */
  delegation?: HostedDelegation | null;
}

/**
 * The controller's side. Every step is asynchronous (WebCrypto); a step
 * claims its stage before awaiting, so a re-entrant or out-of-order message
 * fails instead of racing.
 */
export class HandshakeInitiator {
  private stage:
    | 'new'
    | 'sent_hello1'
    | 'reading_hello2'
    | 'sent_hello3'
    | 'reading_hello4'
    | 'done' = 'new';
  private transcript: Bytes | null = null;
  private peerPublicKey: string | null = null;
  private peerEphemeral: string | null = null;
  private commitment: string | null = null;

  private constructor(
    private readonly options: HandshakeInitiatorOptions,
    private readonly ephemeral: Ephemeral,
  ) {}

  static async create(
    options: HandshakeInitiatorOptions,
  ): Promise<HandshakeInitiator> {
    assertSessionId(options.sessionId);
    return new HandshakeInitiator(options, await createEphemeral());
  }

  private get delegation(): HostedDelegation | null {
    return this.options.delegation ?? null;
  }

  async start(): Promise<Hello1> {
    if (this.stage !== 'new') {
      throw new HandshakeError('unexpected_message', 'Handshake started.');
    }
    this.stage = 'sent_hello1';
    this.commitment = await commitmentFor(
      this.ephemeral.publicKey,
      this.ephemeral.nonce,
    );
    const hello1: Hello1 = {
      protocol: HANDSHAKE_PROTOCOL,
      purpose: this.options.purpose,
      initiatorKey: this.options.identity.publicKey,
      commitment: this.commitment,
    };
    const delegation = this.delegation;
    if (delegation !== null) hello1.delegation = delegation;
    return hello1;
  }

  async receiveHello2(hello2: Hello2): Promise<Hello3> {
    const commitment = this.commitment;
    if (this.stage !== 'sent_hello1' || commitment === null) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello2.');
    }
    this.stage = 'reading_hello2';
    const { pinnedPeerPublicKey, peerDeviceId } = this.options;
    if (
      pinnedPeerPublicKey !== null &&
      hello2.responderKey !== pinnedPeerPublicKey
    ) {
      throw new HandshakeError(
        'peer_key_mismatch',
        'The other computer presented a different key than the one paired.',
      );
    }
    if ((await peerDeviceIdFor(hello2.responderKey)) !== peerDeviceId) {
      throw new HandshakeError(
        'peer_key_mismatch',
        'The other computer key does not match its device ID.',
      );
    }
    const transcript = await transcriptHash({
      purpose: this.options.purpose,
      sessionId: this.options.sessionId,
      initiatorKey: this.options.identity.publicKey,
      responderKey: hello2.responderKey,
      commitment,
      initiatorEphemeral: this.ephemeral.publicKey,
      initiatorNonce: this.ephemeral.nonce,
      responderEphemeral: hello2.ephemeral,
      responderNonce: hello2.nonce,
    });
    const signature = await signTranscript(
      this.options.identity,
      'initiator',
      transcript,
    );
    this.transcript = transcript;
    this.peerPublicKey = hello2.responderKey;
    this.peerEphemeral = hello2.ephemeral;
    this.stage = 'sent_hello3';
    return {
      ephemeral: this.ephemeral.publicKey,
      nonce: this.ephemeral.nonce,
      signature,
    };
  }

  async receiveHello4(hello4: Hello4): Promise<HandshakeResult> {
    const { transcript, peerPublicKey, peerEphemeral } = this;
    if (
      this.stage !== 'sent_hello3' ||
      transcript === null ||
      peerPublicKey === null ||
      peerEphemeral === null
    ) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello4.');
    }
    this.stage = 'reading_hello4';
    await verifyTranscript(
      peerPublicKey,
      'responder',
      transcript,
      hello4.signature,
    );
    const result = await deriveResult(
      'initiator',
      this.options.purpose,
      this.ephemeral,
      peerEphemeral,
      peerPublicKey,
      transcript,
      this.delegation,
    );
    this.stage = 'done';
    return result;
  }
}

/** What a responder is asked before answering hello1. */
export interface HandshakeAuthorizationRequest {
  purpose: HandshakePurpose;
  initiatorKey: string;
  delegation: HostedDelegation | null;
}

export interface HandshakeResponderOptions {
  sessionId: Uint8Array;
  identity: DeviceIdentity;
  /** Source device reported by the relay for hello1. */
  peerDeviceId: string;
  /**
   * Decides whether a peer may open a session of this purpose, before hello2
   * is sent. The session manager asks again after hello3.
   */
  authorize: (
    request: HandshakeAuthorizationRequest,
  ) => boolean | Promise<boolean>;
}

export class HandshakeResponder {
  private stage:
    | 'new'
    | 'reading_hello1'
    | 'sent_hello2'
    | 'reading_hello3'
    | 'done' = 'new';
  private hello1: Hello1 | null = null;

  private constructor(
    private readonly options: HandshakeResponderOptions,
    private readonly ephemeral: Ephemeral,
  ) {}

  static async create(
    options: HandshakeResponderOptions,
  ): Promise<HandshakeResponder> {
    assertSessionId(options.sessionId);
    return new HandshakeResponder(options, await createEphemeral());
  }

  get purpose(): HandshakePurpose | null {
    return this.hello1?.purpose ?? null;
  }

  async receiveHello1(hello1: Hello1): Promise<Hello2> {
    if (this.stage !== 'new') {
      throw new HandshakeError('unexpected_message', 'Unexpected hello1.');
    }
    this.stage = 'reading_hello1';
    if (
      (await peerDeviceIdFor(hello1.initiatorKey)) !== this.options.peerDeviceId
    ) {
      throw new HandshakeError(
        'peer_key_mismatch',
        'Initiator key does not match its device ID.',
      );
    }
    const allowed = await this.options.authorize({
      purpose: hello1.purpose,
      initiatorKey: hello1.initiatorKey,
      delegation: hello1.delegation ?? null,
    });
    if (!allowed) {
      throw new HandshakeError(
        'unauthorized_peer',
        PEER_REFUSAL_MESSAGES.hello1,
      );
    }
    this.hello1 = hello1;
    this.stage = 'sent_hello2';
    return {
      responderKey: this.options.identity.publicKey,
      ephemeral: this.ephemeral.publicKey,
      nonce: this.ephemeral.nonce,
    };
  }

  async receiveHello3(
    hello3: Hello3,
  ): Promise<{ hello4: Hello4; result: HandshakeResult }> {
    const hello1 = this.hello1;
    if (this.stage !== 'sent_hello2' || hello1 === null) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello3.');
    }
    this.stage = 'reading_hello3';
    const expected = decodeField(
      await commitmentFor(hello3.ephemeral, hello3.nonce),
      'commitment',
    );
    const received = decodeField(hello1.commitment, 'commitment');
    if (!bytesEqual(expected, received)) {
      throw new HandshakeError(
        'bad_commitment',
        'Initiator ephemeral key does not match its commitment.',
      );
    }
    const transcript = await transcriptHash({
      purpose: hello1.purpose,
      sessionId: this.options.sessionId,
      initiatorKey: hello1.initiatorKey,
      responderKey: this.options.identity.publicKey,
      commitment: hello1.commitment,
      initiatorEphemeral: hello3.ephemeral,
      initiatorNonce: hello3.nonce,
      responderEphemeral: this.ephemeral.publicKey,
      responderNonce: this.ephemeral.nonce,
    });
    await verifyTranscript(
      hello1.initiatorKey,
      'initiator',
      transcript,
      hello3.signature,
    );
    const result = await deriveResult(
      'responder',
      hello1.purpose,
      this.ephemeral,
      hello3.ephemeral,
      hello1.initiatorKey,
      transcript,
      hello1.delegation ?? null,
    );
    const signature = await signTranscript(
      this.options.identity,
      'responder',
      transcript,
    );
    this.stage = 'done';
    return { hello4: { signature }, result };
  }
}
