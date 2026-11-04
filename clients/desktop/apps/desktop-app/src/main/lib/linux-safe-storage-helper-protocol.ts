/** Private, one-request native adapter protocol; never persisted or logged. */
export const LINUX_SAFE_STORAGE_HELPER_MODE =
  'CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE';
export const LINUX_SAFE_STORAGE_HELPER_PROFILE =
  'CANOPY_LINUX_SAFE_STORAGE_HELPER_PROFILE';
export const LINUX_SAFE_STORAGE_PROFILE_PREFIX = 'canopy-safe-storage-';
export const LINUX_SAFE_STORAGE_MAX_BYTES = 4 * 1024 * 1024;

export type LinuxSafeStorageRequest =
  | { version: 1; operation: 'probe' }
  | { version: 1; operation: 'encrypt'; text: string }
  | { version: 1; operation: 'decrypt'; ciphertext: string };

export type LinuxSafeStorageResponse =
  | { version: 1; ok: false; reason: 'unavailable' }
  | { version: 1; ok: false; reason: 'decrypt-failed'; operation: 'decrypt' }
  | { version: 1; ok: true; operation: 'probe' }
  | { version: 1; ok: true; operation: 'encrypt'; ciphertext: string }
  | { version: 1; ok: true; operation: 'decrypt'; text: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Reject permissive Buffer base64 decoding, including nonzero padding bits. */
export function isCanonicalBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LINUX_SAFE_STORAGE_MAX_BYTES &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function decode(wire: Buffer): unknown {
  if (wire.length === 0 || wire.length > LINUX_SAFE_STORAGE_MAX_BYTES)
    return null;
  const text = wire.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(wire)) return null;
  try {
    const value: unknown = JSON.parse(text);
    // Both endpoints use our serializer. Canonical JSON also rejects duplicate
    // keys, trailing messages and alternate encodings instead of last-key-wins.
    return JSON.stringify(value) === text ? value : null;
  } catch {
    return null;
  }
}

export function encodeLinuxSafeStorageMessage(
  message: LinuxSafeStorageRequest | LinuxSafeStorageResponse,
): string {
  const wire = JSON.stringify(message);
  if (Buffer.byteLength(wire, 'utf8') > LINUX_SAFE_STORAGE_MAX_BYTES) {
    throw new Error('Secure storage recovery unavailable.');
  }
  return wire;
}

export function parseLinuxSafeStorageRequest(
  wire: Buffer,
): LinuxSafeStorageRequest | null {
  const value = decode(wire);
  if (!record(value) || value.version !== 1) return null;
  if (value.operation === 'probe' && keys(value, ['version', 'operation'])) {
    return { version: 1, operation: 'probe' };
  }
  if (
    value.operation === 'encrypt' &&
    typeof value.text === 'string' &&
    keys(value, ['version', 'operation', 'text'])
  ) {
    return { version: 1, operation: 'encrypt', text: value.text };
  }
  if (
    value.operation === 'decrypt' &&
    isCanonicalBase64(value.ciphertext) &&
    keys(value, ['version', 'operation', 'ciphertext'])
  ) {
    return { version: 1, operation: 'decrypt', ciphertext: value.ciphertext };
  }
  return null;
}

export function parseLinuxSafeStorageResponse(
  wire: Buffer,
): LinuxSafeStorageResponse | null {
  const value = decode(wire);
  if (!record(value) || value.version !== 1) return null;
  if (value.ok === false) {
    if (
      value.reason === 'unavailable' &&
      keys(value, ['version', 'ok', 'reason'])
    )
      return { version: 1, ok: false, reason: 'unavailable' };
    if (
      value.reason === 'decrypt-failed' &&
      value.operation === 'decrypt' &&
      keys(value, ['version', 'ok', 'reason', 'operation'])
    )
      return {
        version: 1,
        ok: false,
        reason: 'decrypt-failed',
        operation: 'decrypt',
      };
    return null;
  }
  if (value.ok !== true) return null;
  if (
    value.operation === 'probe' &&
    keys(value, ['version', 'ok', 'operation'])
  ) {
    return { version: 1, ok: true, operation: 'probe' };
  }
  if (
    value.operation === 'encrypt' &&
    isCanonicalBase64(value.ciphertext) &&
    keys(value, ['version', 'ok', 'operation', 'ciphertext'])
  ) {
    return {
      version: 1,
      ok: true,
      operation: 'encrypt',
      ciphertext: value.ciphertext,
    };
  }
  if (
    value.operation === 'decrypt' &&
    typeof value.text === 'string' &&
    keys(value, ['version', 'ok', 'operation', 'text'])
  ) {
    return { version: 1, ok: true, operation: 'decrypt', text: value.text };
  }
  return null;
}
