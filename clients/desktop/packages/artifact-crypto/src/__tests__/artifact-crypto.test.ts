import { createCipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES,
  ARTIFACT_CRYPTO_SCHEME,
  ciphertextLengthFor,
  createArtifactDecryptStream,
  createArtifactEncryptStream,
} from '../index';

const HEADER_BYTES = 33;
const TAG_BYTES = 16;

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function encrypt(
  plaintext: Buffer,
  dek = Buffer.alloc(32, 7),
  aad = 'artifact-aad',
): Promise<Buffer> {
  const transform = createArtifactEncryptStream(dek, aad, plaintext.byteLength);
  const output = collect(transform);
  const [, ciphertext] = await Promise.all([
    pipeline(Readable.from([plaintext]), transform),
    output,
  ]);
  return ciphertext;
}

async function decrypt(
  ciphertext: Buffer,
  dek = Buffer.alloc(32, 7),
  aad = 'artifact-aad',
): Promise<Buffer> {
  const transform = createArtifactDecryptStream(dek, aad);
  const output = collect(transform);
  const [, plaintext] = await Promise.all([
    pipeline(Readable.from([ciphertext]), transform),
    output,
  ]);
  return plaintext;
}

describe('AES_256_GCM_CHUNKED_V1 artifact codec', () => {
  it('pins the scheme and fixed v1 chunk size', () => {
    expect(ARTIFACT_CRYPTO_SCHEME).toBe('AES_256_GCM_CHUNKED_V1');
    expect(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES).toBe(1024 * 1024);
  });

  it.each([
    0,
    1,
    ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES - 1,
    ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES,
    ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES + 1,
    25 * 1024 * 1024,
  ])(
    'returns the exact ciphertext length for %i plaintext bytes',
    async (size) => {
      const plaintext = randomBytes(size);
      const ciphertext = await encrypt(plaintext);
      expect(ciphertextLengthFor(size)).toBe(ciphertext.byteLength);
      expect(ciphertextLengthFor(BigInt(size))).toBe(
        BigInt(ciphertext.byteLength),
      );
      expect(await decrypt(ciphertext)).toEqual(plaintext);
    },
  );

  it('round trips independently of input stream boundaries', async () => {
    const plaintext = randomBytes(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES + 37);
    const encryptStream = createArtifactEncryptStream(
      Buffer.alloc(32, 7),
      'artifact-aad',
      plaintext.byteLength,
    );
    const encrypted = collect(encryptStream);
    await pipeline(
      Readable.from([
        plaintext.subarray(0, 3),
        plaintext.subarray(3, ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES - 2),
        plaintext.subarray(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES - 2),
      ]),
      encryptStream,
    );
    const ciphertext = await encrypted;
    const decryptStream = createArtifactDecryptStream(
      Buffer.alloc(32, 7),
      'artifact-aad',
    );
    const decrypted = collect(decryptStream);
    await pipeline(
      Readable.from([
        ciphertext.subarray(0, 2),
        ciphertext.subarray(2, HEADER_BYTES + 11),
        ciphertext.subarray(HEADER_BYTES + 11),
      ]),
      decryptStream,
    );
    expect(await decrypted).toEqual(plaintext);
  });

  it('pins the header layout and nonce/AAD derivation', async () => {
    const dek = Buffer.alloc(32, 0x11);
    const aad = 'known-answer';
    const plaintext = Buffer.from('known plaintext');
    const ciphertext = await encrypt(plaintext, dek, aad);
    const header = ciphertext.subarray(0, HEADER_BYTES);

    expect(header.subarray(0, 8).toString('ascii')).toBe('CANART01');
    expect(header.readUInt8(8)).toBe(1);
    expect(header.readUInt32BE(9)).toBe(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES);
    expect(header.readBigUInt64BE(21)).toBe(BigInt(plaintext.byteLength));
    expect(header.readUInt32BE(29)).toBe(1);

    const nonce = Buffer.alloc(12);
    header.copy(nonce, 0, 13, 21);
    nonce.writeUInt32BE(0, 8);
    const chunkAad = Buffer.concat([
      Buffer.from(aad),
      header,
      Buffer.from([0, 0, 0, 0, 1]),
    ]);
    const cipher = createCipheriv('aes-256-gcm', dek, nonce);
    cipher.setAAD(chunkAad);
    const expected = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(ciphertext.subarray(HEADER_BYTES)).toEqual(expected);
  });

  it('authenticates the key, AAD, and header for a zero-byte artifact', async () => {
    const ciphertext = await encrypt(Buffer.alloc(0));

    expect(ciphertext).toHaveLength(HEADER_BYTES + TAG_BYTES);
    expect(ciphertext.readUInt32BE(29)).toBe(1);
    await expect(decrypt(ciphertext, Buffer.alloc(32, 8))).rejects.toThrow();
    await expect(
      decrypt(ciphertext, Buffer.alloc(32, 7), 'wrong-artifact-aad'),
    ).rejects.toThrow();

    const tamperedHeader = Buffer.from(ciphertext);
    tamperedHeader[13] ^= 1;
    await expect(decrypt(tamperedHeader)).rejects.toThrow();
  });

  it.each([
    [
      'header',
      (value: Buffer): void => {
        value[9] ^= 1;
      },
    ],
    [
      'ciphertext',
      (value: Buffer): void => {
        value[HEADER_BYTES] ^= 1;
      },
    ],
    [
      'tag',
      (value: Buffer): void => {
        value[value.length - 1] ^= 1;
      },
    ],
  ])('fails closed when the %s is tampered', async (_name, mutate) => {
    const ciphertext = await encrypt(Buffer.from('sensitive'));
    mutate(ciphertext);
    await expect(decrypt(ciphertext)).rejects.toThrow();
  });

  it.each(['truncated', 'extended', 'missing', 'duplicate', 'reordered'])(
    'fails closed for a %s chunk sequence',
    async (tamperMode) => {
      const plaintext = randomBytes(ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES * 2 + 5);
      const ciphertext = await encrypt(plaintext);
      const fullChunkLength = ARTIFACT_CRYPTO_CHUNK_SIZE_BYTES + TAG_BYTES;
      const header = ciphertext.subarray(0, HEADER_BYTES);
      const first = ciphertext.subarray(
        HEADER_BYTES,
        HEADER_BYTES + fullChunkLength,
      );
      const second = ciphertext.subarray(
        HEADER_BYTES + fullChunkLength,
        HEADER_BYTES + fullChunkLength * 2,
      );
      const third = ciphertext.subarray(HEADER_BYTES + fullChunkLength * 2);
      const variants: Record<string, Buffer> = {
        truncated: ciphertext.subarray(0, ciphertext.byteLength - 1),
        extended: Buffer.concat([ciphertext, Buffer.from([0])]),
        missing: Buffer.concat([header, first, third]),
        duplicate: Buffer.concat([header, first, second, second, third]),
        reordered: Buffer.concat([header, second, first, third]),
      };
      const variant = variants[tamperMode];
      if (!variant) throw new Error(`Unknown tamper mode: ${tamperMode}`);

      await expect(decrypt(variant)).rejects.toThrow();
    },
  );

  it('rejects a plaintext stream whose size differs from its declaration', async () => {
    const short = createArtifactEncryptStream(Buffer.alloc(32), 'aad', 2);
    await expect(
      pipeline(Readable.from([Buffer.from('a')]), short),
    ).rejects.toThrow('Plaintext size does not match');
    const long = createArtifactEncryptStream(Buffer.alloc(32), 'aad', 1);
    await expect(
      pipeline(Readable.from([Buffer.from('ab')]), long),
    ).rejects.toThrow('Plaintext exceeds declared size');
  });
});
