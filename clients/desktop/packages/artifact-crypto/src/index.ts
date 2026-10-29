import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import type { SharedContainerArtifactKey } from '@canopy/protocol/shared-containers';

export const ARTIFACT_CRYPTO_SCHEME =
  'AES_256_GCM_CHUNKED_V1' as const satisfies SharedContainerArtifactKey['scheme'];
export const ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES = 1024 * 1024;

const MAGIC = Buffer.from('CANART01', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_BYTES = 33;
const NONCE_PREFIX_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  const error = new Error('Artifact crypto operation failed');
  Object.defineProperty(error, 'cause', { value });
  return error;
}

function assertDek(dek: Buffer): void {
  if (dek.byteLength !== DEK_BYTES) {
    throw new Error(`Artifact data key must be ${DEK_BYTES} bytes`);
  }
}

function normalizePlaintextSize(value: number | bigint): bigint {
  const size = typeof value === 'bigint' ? value : BigInt(value);
  if (
    size < BigInt(0) ||
    size > BigInt('18446744073709551615') ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  ) {
    throw new Error('Invalid artifact plaintext size');
  }
  return size;
}

function normalizeChunkSize(value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new Error('Invalid artifact chunk size');
  }
  return BigInt(value);
}

function chunkCountFor(plaintextSize: bigint, chunkSize: bigint): bigint {
  return plaintextSize === BigInt(0)
    ? BigInt(1)
    : (plaintextSize + chunkSize - BigInt(1)) / chunkSize;
}

export function ciphertextLengthFor(
  plaintextSizeBytes: number,
  chunkSizeBytes?: number,
): number;
export function ciphertextLengthFor(
  plaintextSizeBytes: bigint,
  chunkSizeBytes?: number,
): bigint;
export function ciphertextLengthFor(
  plaintextSizeBytes: number | bigint,
  chunkSizeBytes = ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES,
): number | bigint {
  const plaintextSize = normalizePlaintextSize(plaintextSizeBytes);
  const chunkSize = normalizeChunkSize(chunkSizeBytes);
  const length =
    BigInt(HEADER_BYTES) +
    plaintextSize +
    chunkCountFor(plaintextSize, chunkSize) * BigInt(TAG_BYTES);
  if (typeof plaintextSizeBytes === 'bigint') return length;
  const numericLength = Number(length);
  if (!Number.isSafeInteger(numericLength)) {
    throw new Error('Artifact ciphertext length exceeds safe integer range');
  }
  return numericLength;
}

function buildHeader(
  plaintextSize: bigint,
  noncePrefix: Buffer,
): { header: Buffer; chunkCount: number } {
  const count = chunkCountFor(
    plaintextSize,
    BigInt(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES),
  );
  if (count > BigInt(0xffffffff)) {
    throw new Error('Artifact has too many chunks');
  }
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 8);
  header.writeUInt32BE(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES, 9);
  noncePrefix.copy(header, 13);
  header.writeBigUInt64BE(plaintextSize, 21);
  header.writeUInt32BE(Number(count), 29);
  return { header, chunkCount: Number(count) };
}

function chunkNonce(noncePrefix: Buffer, chunkIndex: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(chunkIndex, NONCE_PREFIX_BYTES);
  return nonce;
}

function chunkAad(
  identityAad: Buffer,
  header: Buffer,
  chunkIndex: number,
  finalChunk: boolean,
): Buffer {
  const suffix = Buffer.alloc(5);
  suffix.writeUInt32BE(chunkIndex, 0);
  suffix.writeUInt8(finalChunk ? 1 : 0, 4);
  return Buffer.concat([identityAad, header, suffix]);
}

class ArtifactEncryptTransform extends Transform {
  private readonly plaintextSize: bigint;
  private readonly header: Buffer;
  private readonly noncePrefix: Buffer;
  private readonly identityAad: Buffer;
  private readonly chunkCount: number;
  private pending = Buffer.alloc(0);
  private received = BigInt(0);
  private chunkIndex = 0;
  private headerWritten = false;

  constructor(dek: Buffer, aad: string, plaintextSizeBytes: number | bigint) {
    super();
    assertDek(dek);
    this.plaintextSize = normalizePlaintextSize(plaintextSizeBytes);
    this.noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
    const built = buildHeader(this.plaintextSize, this.noncePrefix);
    this.header = built.header;
    this.chunkCount = built.chunkCount;
    this.identityAad = Buffer.from(aad, 'utf8');
    this.dek = Buffer.from(dek);
  }

  private readonly dek: Buffer;

  private writeHeader(): void {
    if (!this.headerWritten) {
      this.push(this.header);
      this.headerWritten = true;
    }
  }

  private encryptChunk(plaintext: Buffer): void {
    const finalChunk = this.chunkIndex === this.chunkCount - 1;
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.dek,
      chunkNonce(this.noncePrefix, this.chunkIndex),
    );
    cipher.setAAD(
      chunkAad(this.identityAad, this.header, this.chunkIndex, finalChunk),
    );
    this.push(
      Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    );
    this.chunkIndex += 1;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.received += BigInt(input.byteLength);
      if (this.received > this.plaintextSize) {
        throw new Error('Plaintext exceeds declared size');
      }
      this.writeHeader();
      let offset = 0;
      if (this.pending.byteLength > 0) {
        const needed =
          ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES - this.pending.byteLength;
        const taken = Math.min(needed, input.byteLength);
        this.pending = Buffer.concat([this.pending, input.subarray(0, taken)]);
        offset = taken;
        if (this.pending.byteLength === ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES) {
          this.encryptChunk(this.pending);
          this.pending = Buffer.alloc(0);
        }
      }
      while (input.byteLength - offset >= ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES) {
        this.encryptChunk(
          input.subarray(offset, offset + ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES),
        );
        offset += ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES;
      }
      if (offset < input.byteLength) {
        this.pending = Buffer.from(input.subarray(offset));
      }
      callback();
    } catch (error) {
      callback(toError(error));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.writeHeader();
      if (this.received !== this.plaintextSize) {
        throw new Error('Plaintext size does not match declaration');
      }
      if (this.pending.byteLength > 0 || this.plaintextSize === BigInt(0)) {
        this.encryptChunk(this.pending);
      }
      if (this.chunkIndex !== this.chunkCount) {
        throw new Error('Plaintext chunk count does not match declaration');
      }
      callback();
    } catch (error) {
      callback(toError(error));
    }
  }
}

class ArtifactDecryptTransform extends Transform {
  private readonly dek: Buffer;
  private readonly identityAad: Buffer;
  private pending = Buffer.alloc(0);
  private header: Buffer | undefined;
  private noncePrefix: Buffer | undefined;
  private plaintextSize = BigInt(0);
  private chunkCount = 0;
  private chunkIndex = 0;
  private emitted = BigInt(0);

  constructor(dek: Buffer, aad: string) {
    super();
    assertDek(dek);
    this.dek = Buffer.from(dek);
    this.identityAad = Buffer.from(aad, 'utf8');
  }

  private parseHeader(): boolean {
    if (this.header) return true;
    if (this.pending.byteLength < HEADER_BYTES) return false;
    const header = Buffer.from(this.pending.subarray(0, HEADER_BYTES));
    this.pending = Buffer.from(this.pending.subarray(HEADER_BYTES));
    if (!header.subarray(0, 8).equals(MAGIC)) {
      throw new Error('Invalid artifact ciphertext magic');
    }
    if (header.readUInt8(8) !== FORMAT_VERSION) {
      throw new Error('Unsupported artifact ciphertext version');
    }
    if (header.readUInt32BE(9) !== ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES) {
      throw new Error('Unsupported artifact ciphertext chunk size');
    }
    this.plaintextSize = header.readBigUInt64BE(21);
    this.chunkCount = header.readUInt32BE(29);
    const expectedCount = chunkCountFor(
      this.plaintextSize,
      BigInt(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES),
    );
    if (expectedCount !== BigInt(this.chunkCount)) {
      throw new Error('Invalid artifact ciphertext chunk count');
    }
    this.header = header;
    this.noncePrefix = Buffer.from(header.subarray(13, 21));
    return true;
  }

  private nextPlaintextChunkLength(): number {
    if (this.chunkIndex < this.chunkCount - 1) {
      return ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES;
    }
    return Number(
      this.plaintextSize -
        BigInt(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES) *
          BigInt(Math.max(0, this.chunkCount - 1)),
    );
  }

  private drainChunks(): void {
    if (!this.header || !this.noncePrefix) return;
    while (this.chunkIndex < this.chunkCount) {
      const plaintextLength = this.nextPlaintextChunkLength();
      const ciphertextLength = plaintextLength + TAG_BYTES;
      if (this.pending.byteLength < ciphertextLength) return;
      const encrypted = this.pending.subarray(0, plaintextLength);
      const tag = this.pending.subarray(plaintextLength, ciphertextLength);
      this.pending = Buffer.from(this.pending.subarray(ciphertextLength));
      const finalChunk = this.chunkIndex === this.chunkCount - 1;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.dek,
        chunkNonce(this.noncePrefix, this.chunkIndex),
      );
      decipher.setAAD(
        chunkAad(this.identityAad, this.header, this.chunkIndex, finalChunk),
      );
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      this.push(plaintext);
      this.emitted += BigInt(plaintext.byteLength);
      this.chunkIndex += 1;
    }
    if (this.chunkIndex === this.chunkCount && this.pending.byteLength > 0) {
      throw new Error('Artifact ciphertext has trailing bytes');
    }
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
      if (this.parseHeader()) this.drainChunks();
      callback();
    } catch (error) {
      callback(toError(error));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.parseHeader()) {
        throw new Error('Truncated artifact ciphertext header');
      }
      this.drainChunks();
      if (
        this.pending.byteLength !== 0 ||
        this.chunkIndex !== this.chunkCount ||
        this.emitted !== this.plaintextSize
      ) {
        throw new Error('Truncated artifact ciphertext');
      }
      callback();
    } catch (error) {
      callback(toError(error));
    }
  }
}

/**
 * The plaintext size is explicit because v1 authenticates it in the header;
 * requiring it up front lets the transform emit immediately without buffering
 * the whole artifact.
 */
export function createArtifactEncryptStream(
  dek: Buffer,
  aad: string,
  plaintextSizeBytes: number | bigint,
): Transform {
  return new ArtifactEncryptTransform(dek, aad, plaintextSizeBytes);
}

export function createArtifactDecryptStream(
  dek: Buffer,
  aad: string,
): Transform {
  return new ArtifactDecryptTransform(dek, aad);
}
