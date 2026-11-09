import { concatBytes, copyBytes, utf8, type Bytes } from './bytes';
import { RemoteSessionError } from './errors';

/** WebCrypto, from `globalThis.crypto` in browsers, workers and Node 22+. */
export function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new RemoteSessionError(
      'runtime_unsupported',
      'This environment has no WebCrypto.',
    );
  }
  return subtle;
}

export function randomBytes(length: number): Bytes {
  const output = new Uint8Array(length);
  globalThis.crypto.getRandomValues(output);
  return output;
}

export async function sha256(parts: ReadonlyArray<Uint8Array>): Promise<Bytes> {
  return new Uint8Array(
    await subtleCrypto().digest('SHA-256', concatBytes(parts)),
  );
}

export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Bytes> {
  const subtle = subtleCrypto();
  const hmacKey = await subtle.importKey(
    'raw',
    copyBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle.sign('HMAC', hmacKey, copyBytes(data)));
}

/** RFC 5869 HKDF-SHA256, identical to Node's `hkdfSync('sha256', …)`. */
export async function hkdfSha256(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Promise<Bytes> {
  const subtle = subtleCrypto();
  const key = await subtle.importKey(
    'raw',
    copyBytes(inputKeyMaterial),
    'HKDF',
    false,
    ['deriveBits'],
  );
  return new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: copyBytes(salt),
        info: utf8(info),
      },
      key,
      length * 8,
    ),
  );
}
