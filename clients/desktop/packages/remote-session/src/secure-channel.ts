import {
  concatBytes,
  copyBytes,
  readUint64BE,
  uint64BE,
  type Bytes,
} from './bytes';
import { subtleCrypto } from './web-crypto';

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
/** Bytes a sealed frame adds to its plaintext: counter and tag. */
export const SECURE_CHANNEL_OVERHEAD_BYTES = COUNTER_BYTES + TAG_BYTES;
/** The last counter a frame may use; a channel refuses to wrap. */
export const SECURE_CHANNEL_MAX_COUNTER = (BigInt(1) << BigInt(64)) - BigInt(1);

export type SecureChannelErrorCode =
  | 'malformed'
  | 'replayed'
  | 'authentication'
  /** The counter would overflow; the session must end. */
  | 'exhausted'
  /** Frames were opened concurrently; callers must serialize them. */
  | 'concurrent';

export class SecureChannelError extends Error {
  constructor(
    readonly code: SecureChannelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecureChannelError';
  }
}

function nonceFor(counter: bigint): Bytes {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(uint64BE(counter), NONCE_BYTES - COUNTER_BYTES);
  return nonce;
}

export interface SecureChannelCounters {
  send: bigint;
  receive: bigint;
}

/**
 * AES-256-GCM framing for one established session, wire-identical to the
 * desktop's `SecureChannel`. Frame: `[counter u64 BE][ciphertext][tag 16]`;
 * nonce is four zero bytes then the counter; associated data is the
 * envelope header (`0x20` then the session ID). A frame whose counter is not
 * exactly the next one is a replay, drop or reorder and is refused.
 *
 * WebCrypto is asynchronous: `seal` claims its counter synchronously, so the
 * caller must transmit sealed frames in call order, and `open` refuses to
 * run while another `open` is in flight.
 */
export class SecureChannel {
  private sendCounter: bigint;
  private receiveCounter: bigint;
  private opening = false;

  private constructor(
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
    counters: SecureChannelCounters,
  ) {
    this.sendCounter = counters.send;
    this.receiveCounter = counters.receive;
  }

  /**
   * `startCounters` exists only so tests can exercise counter exhaustion; a
   * real session always starts both directions at zero.
   */
  static async create(
    sendKey: Uint8Array,
    receiveKey: Uint8Array,
    startCounters: SecureChannelCounters = {
      send: BigInt(0),
      receive: BigInt(0),
    },
  ): Promise<SecureChannel> {
    if (sendKey.byteLength !== 32 || receiveKey.byteLength !== 32) {
      throw new Error('Secure channel keys are 32 bytes.');
    }
    const subtle = subtleCrypto();
    const [send, receive] = await Promise.all([
      subtle.importKey('raw', copyBytes(sendKey), 'AES-GCM', false, [
        'encrypt',
      ]),
      subtle.importKey('raw', copyBytes(receiveKey), 'AES-GCM', false, [
        'decrypt',
      ]),
    ]);
    return new SecureChannel(send, receive, startCounters);
  }

  async seal(
    plaintext: Uint8Array,
    associatedData: Uint8Array,
  ): Promise<Bytes> {
    const counter = this.sendCounter;
    if (counter > SECURE_CHANNEL_MAX_COUNTER) {
      throw new SecureChannelError(
        'exhausted',
        'Encrypted session is exhausted.',
      );
    }
    this.sendCounter = counter + BigInt(1);
    const sealed = new Uint8Array(
      await subtleCrypto().encrypt(
        {
          name: 'AES-GCM',
          iv: nonceFor(counter),
          additionalData: copyBytes(associatedData),
          tagLength: TAG_BYTES * 8,
        },
        this.sendKey,
        copyBytes(plaintext),
      ),
    );
    return concatBytes([uint64BE(counter), sealed]);
  }

  async open(frame: Uint8Array, associatedData: Uint8Array): Promise<Bytes> {
    if (frame.byteLength < COUNTER_BYTES + TAG_BYTES) {
      throw new SecureChannelError('malformed', 'Encrypted frame too short.');
    }
    if (this.opening) {
      throw new SecureChannelError(
        'concurrent',
        'Encrypted frames must be opened in order.',
      );
    }
    const counter = readUint64BE(frame, 0);
    if (counter !== this.receiveCounter) {
      throw new SecureChannelError(
        'replayed',
        'Encrypted frame is out of sequence.',
      );
    }
    if (counter > SECURE_CHANNEL_MAX_COUNTER) {
      throw new SecureChannelError(
        'exhausted',
        'Encrypted session is exhausted.',
      );
    }
    this.opening = true;
    try {
      const plaintext = await subtleCrypto().decrypt(
        {
          name: 'AES-GCM',
          iv: nonceFor(counter),
          additionalData: copyBytes(associatedData),
          tagLength: TAG_BYTES * 8,
        },
        this.receiveKey,
        copyBytes(frame.subarray(COUNTER_BYTES)),
      );
      this.receiveCounter = counter + BigInt(1);
      return new Uint8Array(plaintext);
    } catch {
      throw new SecureChannelError(
        'authentication',
        'Encrypted frame failed authentication.',
      );
    } finally {
      this.opening = false;
    }
  }
}
