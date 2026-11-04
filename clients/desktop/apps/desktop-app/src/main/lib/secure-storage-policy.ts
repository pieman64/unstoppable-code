import type { CommandLine } from 'electron';
import type {
  SecureStorageBackendState,
  SecureStorageFailure,
  SecureStorageFailureCode,
} from '@canopy/desktop-shared/types/secure-storage';
import {
  disableSafeStoragePlainTextEncryption,
  getReadableSafeStorage,
  getSafeStorageStatus,
  getWritableSafeStorage,
  SafeStorageWriteError,
  type ReadableSafeStorage,
  type SafeStorageStatus,
  type SafeStorageReadOptions,
} from './safe-storage';
import { isRecord } from './type-guards';

interface LinuxSecureStorageOptions {
  readonly platform: NodeJS.Platform | null;
  readonly isTestHarness: boolean;
  readonly passwordStoreOverride?: string;
}

/** Configure Chromium before app readiness; production always uses libsecret. */
export function configureLinuxSecureStorage(
  commandLine: Pick<CommandLine, 'appendSwitch'>,
  options: LinuxSecureStorageOptions,
): void {
  if (options.platform !== 'linux') return;
  const passwordStore = options.isTestHarness
    ? (options.passwordStoreOverride ?? 'gnome-libsecret')
    : 'gnome-libsecret';
  if (passwordStore !== 'gnome-libsecret') {
    throw new Error('CANOPY_LINUX_PASSWORD_STORE must be gnome-libsecret');
  }
  commandLine.appendSwitch('password-store', passwordStore);
  disableSafeStoragePlainTextEncryption();
}

export interface SecretStoragePolicy {
  getStatus(): SafeStorageStatus;
  isWriteAvailable(): boolean;
  nativeEncryptionAvailable(): boolean;
  assertCanRead(): void;
  assertCanWrite(): void;
  encrypt(text: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export interface EnvironmentValueWritePolicy {
  readonly encryptionAvailable: boolean;
  encode(
    text: string,
  ):
    | { kind: 'encrypted'; value: Buffer }
    | { kind: 'plain-text'; value: string };
}

const failureMessages: Record<SecureStorageFailureCode, string> = {
  SECURE_STORAGE_WRITE_REFUSED: 'Secure storage unavailable',
  SECURE_STORAGE_READ_UNAVAILABLE: 'Secure storage unavailable',
  SECURE_STORAGE_PROBE_FAILED: 'Secure storage unavailable',
  SECURE_STORAGE_ENCRYPT_FAILED: 'Secure storage encryption failed',
  SECURE_STORAGE_DECRYPT_FAILED: 'Secure storage decryption failed',
};

/** An operation failure with only safe, portable diagnostic metadata. */
export class SecureStorageOperationError extends Error {
  readonly secureStorageFailure: SecureStorageFailure;
  readonly code: SecureStorageFailureCode;
  readonly operation: SecureStorageFailure['operation'];
  readonly state: SecureStorageBackendState;
  readonly backend: string | null;

  constructor(failure: SecureStorageFailure) {
    super(failureMessages[failure.code]);
    this.name = 'SecureStorageOperationError';
    // Explicit projection prevents extra domain/native fields from escaping.
    this.secureStorageFailure = Object.freeze({
      version: 1,
      code: failure.code,
      operation: failure.operation,
      state: failure.state,
      backend: failure.backend,
      retryable: failure.retryable,
    });
    this.code = failure.code;
    this.operation = failure.operation;
    this.state = failure.state;
    this.backend = failure.backend;
  }
}

function failureDescriptor(
  code: SecureStorageFailureCode,
  operation: SecureStorageFailure['operation'],
  status: SafeStorageStatus,
): SecureStorageFailure {
  return Object.freeze({
    version: 1,
    code,
    operation,
    state: status.state,
    backend: status.backend,
    retryable:
      code !== 'SECURE_STORAGE_DECRYPT_FAILED' ||
      status.state === 'unavailable' ||
      status.state === 'locked',
  });
}

function isFailureCode(value: unknown): value is SecureStorageFailureCode {
  return (
    value === 'SECURE_STORAGE_WRITE_REFUSED' ||
    value === 'SECURE_STORAGE_READ_UNAVAILABLE' ||
    value === 'SECURE_STORAGE_PROBE_FAILED' ||
    value === 'SECURE_STORAGE_ENCRYPT_FAILED' ||
    value === 'SECURE_STORAGE_DECRYPT_FAILED'
  );
}

function isBackendState(value: unknown): value is SecureStorageBackendState {
  return (
    value === 'secure' ||
    value === 'unknown' ||
    value === 'unavailable' ||
    value === 'locked'
  );
}

/** Validate attached domain metadata and return only the contract fields. */
export function getSecureStorageFailure(
  error: unknown,
): SecureStorageFailure | null {
  if (error instanceof SafeStorageWriteError) {
    return failureDescriptor('SECURE_STORAGE_WRITE_REFUSED', 'write', error);
  }
  if (!isRecord(error)) return null;
  const failure: unknown = error.secureStorageFailure;
  if (
    !isRecord(failure) ||
    failure.version !== 1 ||
    !isFailureCode(failure.code) ||
    (failure.operation !== 'read' &&
      failure.operation !== 'write' &&
      failure.operation !== 'probe') ||
    !isBackendState(failure.state) ||
    (failure.backend !== null && typeof failure.backend !== 'string') ||
    typeof failure.retryable !== 'boolean'
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    code: failure.code,
    operation: failure.operation,
    state: failure.state,
    backend: failure.backend,
    retryable: failure.retryable,
  });
}

function operationError(
  code: SecureStorageFailureCode,
  operation: SecureStorageFailure['operation'],
  options: SafeStorageReadOptions = {},
): SecureStorageOperationError {
  // Default diagnostics are live; background spawn failures share their bounded observation.
  return new SecureStorageOperationError(
    failureDescriptor(code, operation, getSafeStorageStatus(options)),
  );
}

function nativeAvailability(
  storage: ReadableSafeStorage | null,
  options: SafeStorageReadOptions = {},
): boolean {
  if (!storage) return false;
  try {
    const available: unknown = storage.isEncryptionAvailable();
    if (typeof available === 'boolean') return available;
  } catch (error) {
    if (error instanceof SafeStorageWriteError) throw error;
    // Native diagnostics must not become a cause or serialized descriptor.
  }
  throw operationError('SECURE_STORAGE_PROBE_FAILED', 'probe', options);
}

function assertReadable(
  storage: ReadableSafeStorage | null,
  options: SafeStorageReadOptions = {},
): void {
  if (!nativeAvailability(storage, options)) {
    throw operationError('SECURE_STORAGE_READ_UNAVAILABLE', 'read', options);
  }
}

function assertCanWrite(): void {
  const status = getSafeStorageStatus();
  if (status.state !== 'secure') {
    throw new SafeStorageWriteError({
      state: status.state,
      backend: status.backend,
    });
  }
}

function encrypt(text: string): Buffer {
  const storage = getWritableSafeStorage();
  if (!storage) {
    throw new SafeStorageWriteError({ state: 'unavailable', backend: null });
  }
  try {
    // The lower facade classifies again using the very instance it encrypts.
    return storage.encryptString(text);
  } catch (error) {
    if (error instanceof SafeStorageWriteError) throw error;
    const failure = getSecureStorageFailure(error);
    if (failure) throw new SecureStorageOperationError(failure);
    throw operationError('SECURE_STORAGE_ENCRYPT_FAILED', 'write');
  }
}

function decrypt(ciphertext: Buffer, options: SafeStorageReadOptions): string {
  const storage = getReadableSafeStorage(options);
  assertReadable(storage, options);
  if (!storage) {
    throw operationError('SECURE_STORAGE_READ_UNAVAILABLE', 'read', options);
  }
  try {
    return storage.decryptString(ciphertext);
  } catch (error) {
    // Preserve the operation's validated classification before any fresh probe:
    // a subsequently healthy helper cannot turn a timeout into corrupt data.
    const failure = getSecureStorageFailure(error);
    if (failure) throw new SecureStorageOperationError(failure);
    throw operationError('SECURE_STORAGE_DECRYPT_FAILED', 'read', options);
  }
}

/** Default operations stay live. Only spawn reads opt into bounded observation reuse. */
export function getSecretStoragePolicy(
  options: SafeStorageReadOptions = {},
): SecretStoragePolicy {
  return Object.freeze({
    getStatus: (): SafeStorageStatus => getSafeStorageStatus(options),
    isWriteAvailable: (): boolean => getSafeStorageStatus().state === 'secure',
    nativeEncryptionAvailable: (): boolean =>
      nativeAvailability(getReadableSafeStorage(options), options),
    assertCanRead: (): void =>
      assertReadable(getReadableSafeStorage(options), options),
    assertCanWrite,
    encrypt,
    decrypt: (ciphertext: Buffer): string => decrypt(ciphertext, options),
  });
}

/** Historical plaintext exception for environment values only, never tokens. */
export function getEnvironmentValueWritePolicy(): EnvironmentValueWritePolicy {
  const availability = (): boolean =>
    nativeAvailability(getReadableSafeStorage({ requireSecureProvider: true }));
  let encryptionAvailable = false;
  let availabilityFailure: Error | undefined;
  try {
    encryptionAvailable = availability();
  } catch (error) {
    // Display availability must not throw or turn a failed write attempt into plaintext.
    availabilityFailure =
      error instanceof Error
        ? error
        : new SafeStorageWriteError({ state: 'unavailable', backend: null });
  }
  return Object.freeze({
    encryptionAvailable,
    encode: (
      text: string,
    ): ReturnType<EnvironmentValueWritePolicy['encode']> => {
      if (availabilityFailure !== undefined) throw availabilityFailure;
      // Encrypt revalidates independently; only plaintext needs a fresh availability check.
      // Never downgrade an encrypted decision, even if native availability changes.
      return encryptionAvailable || availability()
        ? { kind: 'encrypted', value: encrypt(text) }
        : { kind: 'plain-text', value: text };
    },
  });
}
