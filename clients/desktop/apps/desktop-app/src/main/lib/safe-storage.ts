import { createHash } from 'node:crypto';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { logMainProcessWarn } from './main-process-logging';
import { isRecord } from './type-guards';
import { getLinuxSecretServiceState } from './linux-secret-service';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import {
  probeLinuxSafeStorageRecovery,
  encryptWithLinuxSafeStorageRecovery,
  decryptWithLinuxSafeStorageRecovery,
} from './linux-safe-storage-recovery';

export interface ReadableSafeStorage {
  isEncryptionAvailable: () => boolean;
  decryptString: (encrypted: Buffer) => string;
}

export interface WritableSafeStorage extends ReadableSafeStorage {
  encryptString: (text: string) => Buffer;
}

/**
 * `secure` permits native encryption; `unavailable` covers failed readiness,
 * probes, or a missing supported backend. On Linux `locked` is the live
 * Secret Service default collection's Locked property.
 */
export type SafeStorageBackendState = 'secure' | 'unavailable' | 'locked';

export interface SafeStorageStatus {
  readonly state: SafeStorageBackendState;
  readonly backend: string | null;
}

type DeniedSafeStorageStatus = {
  readonly state: Exclude<SafeStorageBackendState, 'secure'>;
  readonly backend: string | null;
};

const refusalMessages: Record<DeniedSafeStorageStatus['state'], string> = {
  unavailable: 'Secure storage write refused: encryption unavailable.',
  locked:
    'Secure storage write refused: backend locked or temporarily unavailable.',
};

/**
 * Refuses encryption before passing plaintext to native storage. The policy is
 * evaluated lazily on each facade write, with backend probes only after app
 * readiness. Secret consumers use the typed secure-storage policy layer.
 */
export class SafeStorageWriteError extends Error {
  /** Stable discriminator for a policy refusal, rather than a native error. */
  readonly code = 'SECURE_STORAGE_WRITE_REFUSED';
  /** The non-secure classification that refused this write. */
  readonly state: DeniedSafeStorageStatus['state'];
  /** Observed Linux backend name, or null when absent or on macOS/Windows. */
  readonly backend: string | null;

  constructor(status: DeniedSafeStorageStatus) {
    super(refusalMessages[status.state]);
    this.name = 'SafeStorageWriteError';
    this.state = status.state;
    this.backend = status.backend;
  }
}

function isReadableSafeStorage(value: unknown): value is ReadableSafeStorage {
  return (
    isRecord(value) &&
    typeof value.isEncryptionAvailable === 'function' &&
    typeof value.decryptString === 'function'
  );
}

function isWritableSafeStorage(value: unknown): value is WritableSafeStorage {
  return (
    isReadableSafeStorage(value) &&
    isRecord(value) &&
    typeof value.encryptString === 'function'
  );
}

interface ElectronContext {
  readonly app: unknown;
  readonly safeStorage: unknown;
}

interface ReadyApp {
  isReady: () => unknown;
}

interface StorageBackendSelector {
  getSelectedStorageBackend: () => unknown;
}

function isReadyApp(value: unknown): value is ReadyApp {
  return isRecord(value) && typeof value.isReady === 'function';
}

function isStorageBackendSelector(
  value: unknown,
): value is StorageBackendSelector {
  return (
    isRecord(value) && typeof value.getSelectedStorageBackend === 'function'
  );
}

function isAppReady(value: unknown): boolean {
  if (!isReadyApp(value)) return false;
  try {
    return value.isReady() === true;
  } catch {
    return false;
  }
}

function getSelectedStorageBackend(storage: unknown): string | null {
  if (!isStorageBackendSelector(storage)) return null;
  try {
    const backend: unknown = storage.getSelectedStorageBackend();
    return typeof backend === 'string' ? backend : null;
  } catch {
    return null;
  }
}

function getElectronContext(): ElectronContext | null {
  try {
    // Electron can be absent or resolve to its Node launcher path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule: unknown = require('electron');
    if (!isRecord(electronModule)) return null;
    return { app: electronModule.app, safeStorage: electronModule.safeStorage };
  } catch {
    return null;
  }
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/** Startup-only native operation: never exposes a handle or enables fallback. */
export function disableSafeStoragePlainTextEncryption(): void {
  const storage = getElectronContext()?.safeStorage;
  if (!isRecord(storage) || !isCallable(storage.setUsePlainTextEncryption)) {
    throw new SafeStorageWriteError({ state: 'unavailable', backend: null });
  }
  storage.setUsePlainTextEncryption(false);
  if (hostOperatingSystem() === 'linux') {
    recordProviderState(storage, getLinuxSecretServiceState());
  }
}

/** Only background child-environment injection may reuse a recent observation. */
export interface SafeStorageReadOptions {
  readonly forSpawn?: boolean;
}

let spawnObservation: {
  storage: ReadableSafeStorage;
  state: SafeStorageBackendState;
  expiresAt: number;
  nativeReady: boolean;
} | null = null;

// Helper readiness is not proof that Chromium in this parent initialized.
const nativeConfirmed = new WeakSet<object>();
const recoveryRequired = new WeakSet<object>();

function recordProviderState(
  storage: object,
  state: SafeStorageBackendState,
): void {
  if (state !== 'secure' && !nativeConfirmed.has(storage)) {
    recoveryRequired.add(storage);
  }
}

function observeLinuxSecretService(
  storage: ReadableSafeStorage,
  options: SafeStorageReadOptions,
): SafeStorageBackendState {
  const now = performance.now();
  if (
    options.forSpawn &&
    spawnObservation?.storage === storage &&
    now < spawnObservation.expiresAt &&
    (spawnObservation.state !== 'secure' || spawnObservation.nativeReady)
  ) {
    return spawnObservation.state;
  }
  const state = getLinuxSecretServiceState();
  recordProviderState(storage, state);
  // Every live read/write/status supersedes the spawn observation. Never let
  // a cached positive authorize Chromium's first native initialization.
  spawnObservation = {
    storage,
    state,
    expiresAt: performance.now() + 1_000,
    nativeReady:
      spawnObservation?.storage === storage && spawnObservation.nativeReady,
  };
  return state;
}

function recordNativeAvailability(
  storage: ReadableSafeStorage,
  available: unknown,
): void {
  if (spawnObservation?.storage !== storage) return;
  if (available === true) spawnObservation.nativeReady = true;
}

// Readiness metadata only: every actual recovery cipher runs in a fresh helper.
const recoveryReady = new WeakSet<ReadableSafeStorage>();
const recoveryRetryAt = new WeakMap<ReadableSafeStorage, number>();

interface SpawnDecryption {
  readonly expiresAt: number;
  // null denotes a genuine, non-retryable ciphertext failure, not unavailability.
  readonly plaintext: string | null;
}

// Bound both metadata and retained plaintext per native storage instance. Hashes
// avoid retaining caller-owned ciphertext buffers. Positive results also prevent
// replaying healthy records before a bad record when an injector drops its cache.
// Each outcome has 64 slots: positive churn must never evict failure backoff.
// Oversized/evicted positives remain live rather than growing secret retention.
const spawnDecryptions = new WeakMap<
  ReadableSafeStorage,
  Map<string, SpawnDecryption>
>();
const MAX_SPAWN_DECRYPTIONS_PER_OUTCOME = 64;
const MAX_SPAWN_PLAINTEXT_BYTES = 1_048_576;

function rememberSpawnDecryption(
  storage: ReadableSafeStorage,
  digest: string,
  plaintext: string | null,
): void {
  const size = (plaintext?.length ?? 0) * 2;
  if (size > MAX_SPAWN_PLAINTEXT_BYTES) return;
  const results =
    spawnDecryptions.get(storage) ?? new Map<string, SpawnDecryption>();
  const now = performance.now();
  let retainedBytes = 0;
  let retainedOutcomes = 0;
  for (const [key, result] of Array.from(results)) {
    if (now >= result.expiresAt || key === digest) results.delete(key);
    else {
      retainedBytes += (result.plaintext?.length ?? 0) * 2;
      if ((result.plaintext === null) === (plaintext === null))
        retainedOutcomes += 1;
    }
  }
  for (const [key, result] of Array.from(results)) {
    if ((result.plaintext === null) !== (plaintext === null)) continue;
    if (
      retainedOutcomes < MAX_SPAWN_DECRYPTIONS_PER_OUTCOME &&
      retainedBytes + size <= MAX_SPAWN_PLAINTEXT_BYTES
    )
      break;
    results.delete(key);
    retainedOutcomes -= 1;
    retainedBytes -= (result.plaintext?.length ?? 0) * 2;
  }
  results.set(digest, { plaintext, expiresAt: now + 1_000 });
  spawnDecryptions.set(storage, results);
}

function unreadableRecoveryCiphertext(): Error {
  const secureStorageFailure: SecureStorageFailure = Object.freeze({
    version: 1,
    code: 'SECURE_STORAGE_DECRYPT_FAILED',
    operation: 'read',
    state: 'secure',
    backend: 'gnome_libsecret',
    retryable: false,
  });
  return Object.assign(new Error('Secure storage decryption failed'), {
    secureStorageFailure,
  });
}

function recoveryAvailable(
  storage: ReadableSafeStorage,
  options: SafeStorageReadOptions,
): boolean {
  if (getSelectedStorageBackend(storage) !== 'gnome_libsecret') return false;
  if (!recoveryReady.has(storage)) {
    if (
      options.forSpawn &&
      performance.now() < (recoveryRetryAt.get(storage) ?? 0)
    )
      return false;
    try {
      if (!probeLinuxSafeStorageRecovery()) {
        recoveryRetryAt.set(storage, performance.now() + 1_000);
        return false;
      }
      recoveryReady.add(storage);
      recoveryRetryAt.delete(storage);
    } catch {
      recoveryRetryAt.set(storage, performance.now() + 1_000);
      return false;
    }
  }
  recordNativeAvailability(storage, true);
  return true;
}

function invalidateRecovery(storage: ReadableSafeStorage): void {
  spawnDecryptions.delete(storage);
  recoveryReady.delete(storage);
  recoveryRetryAt.set(storage, performance.now() + 1_000);
  spawnObservation = null;
}

function usesRecovery(storage: ReadableSafeStorage): boolean {
  return (
    hostOperatingSystem() === 'linux' &&
    recoveryReady.has(storage) &&
    getSelectedStorageBackend(storage) === 'gnome_libsecret'
  );
}

function decryptString(
  storage: ReadableSafeStorage,
  encrypted: Buffer,
  options: SafeStorageReadOptions = {},
): string {
  if (hostOperatingSystem() === 'linux' && recoveryRequired.has(storage)) {
    if (!isEncryptionAvailable(storage, options)) {
      const secureStorageFailure: SecureStorageFailure = Object.freeze({
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'unavailable',
        backend: getSelectedStorageBackend(storage),
        retryable: true,
      });
      throw Object.assign(new Error('Secure storage recovery unavailable.'), {
        secureStorageFailure,
      });
    }
  }
  if (!usesRecovery(storage)) return storage.decryptString(encrypted);
  const digest = createHash('sha256').update(encrypted).digest('hex');
  const results = spawnDecryptions.get(storage);
  const recent = results?.get(digest);
  // Explicit reads/Retry bypass and evict either outcome, even before expiry.
  if (options.forSpawn && recent && performance.now() < recent.expiresAt) {
    if (recent.plaintext === null) throw unreadableRecoveryCiphertext();
    return recent.plaintext;
  }
  results?.delete(digest);
  try {
    const plaintext = decryptWithLinuxSafeStorageRecovery(encrypted);
    if (options.forSpawn) rememberSpawnDecryption(storage, digest, plaintext);
    return plaintext;
  } catch (error) {
    const failure = isRecord(error) ? error.secureStorageFailure : undefined;
    const unreadableCiphertext =
      isRecord(failure) &&
      failure.version === 1 &&
      failure.code === 'SECURE_STORAGE_DECRYPT_FAILED' &&
      failure.operation === 'read' &&
      failure.state === 'secure' &&
      failure.backend === 'gnome_libsecret' &&
      failure.retryable === false;
    // A healthy helper rejecting these bytes says nothing about sibling secrets.
    if (!unreadableCiphertext) invalidateRecovery(storage);
    else if (options.forSpawn) rememberSpawnDecryption(storage, digest, null);
    throw error;
  }
}

function classifySafeStorage(
  context: ElectronContext | null,
  options: SafeStorageReadOptions = {},
): SafeStorageStatus {
  const unavailable: SafeStorageStatus = {
    state: 'unavailable',
    backend: null,
  };
  if (!isAppReady(context?.app)) {
    spawnObservation = null;
    return unavailable;
  }

  const storage = context?.safeStorage;
  if (!isWritableSafeStorage(storage)) {
    spawnObservation = null;
    return unavailable;
  }
  const platform = hostOperatingSystem();
  if (platform === null) return unavailable;

  if (platform === 'linux') {
    const state = observeLinuxSecretService(storage, options);
    if (state !== 'secure')
      return { state, backend: getSelectedStorageBackend(storage) };
    if (recoveryRequired.has(storage)) {
      const backend = getSelectedStorageBackend(storage);
      return {
        state: recoveryAvailable(storage, options) ? 'secure' : 'unavailable',
        backend,
      };
    }
    // Chromium consumes its one-shot initialization config even on failure.
    // Do not poison it by probing while the service is absent or locked.
  }

  let available: boolean;
  try {
    const result: unknown = storage.isEncryptionAvailable();
    if (platform === 'linux') recordNativeAvailability(storage, result);
    if (platform === 'linux' && result === true) nativeConfirmed.add(storage);
    if (typeof result !== 'boolean') return unavailable;
    available = result;
  } catch {
    return unavailable;
  }
  if (available) recoveryReady.delete(storage);
  if (platform !== 'linux') {
    return { state: available ? 'secure' : 'unavailable', backend: null };
  }

  const backend = getSelectedStorageBackend(storage);
  if (backend !== 'gnome_libsecret') return { state: 'unavailable', backend };
  return {
    state:
      available || recoveryAvailable(storage, options)
        ? 'secure'
        : 'unavailable',
    backend,
  };
}

function isEncryptionAvailable(
  storage: ReadableSafeStorage,
  options: SafeStorageReadOptions = {},
  requireSecureProvider = false,
): boolean {
  if (hostOperatingSystem() !== 'linux') return storage.isEncryptionAvailable();
  const provider = observeLinuxSecretService(storage, options);
  if (provider !== 'secure') {
    if (requireSecureProvider) {
      refuseSafeStorageWrite({
        state: provider,
        backend: getSelectedStorageBackend(storage),
      });
    }
    return false;
  }
  if (recoveryRequired.has(storage)) {
    const available = recoveryAvailable(storage, options);
    if (!available && requireSecureProvider) {
      refuseSafeStorageWrite({
        state: 'unavailable',
        backend: getSelectedStorageBackend(storage),
      });
    }
    return available;
  }
  const available = storage.isEncryptionAvailable();
  recordNativeAvailability(storage, available);
  if (available === true) {
    nativeConfirmed.add(storage);
    recoveryReady.delete(storage);
  }
  return available === false ? recoveryAvailable(storage, options) : available;
}

/**
 * Lazily classifies a fresh Electron context without encryption. Only explicit
 * spawn reads may reuse the short-lived Linux observation; defaults stay live.
 * Before app readiness it returns `unavailable`; backend probes run only after
 * readiness. Each facade write independently evaluates the same policy again.
 * Secret consumers use the typed secure-storage policy layer.
 */
export function getSafeStorageStatus(
  options: SafeStorageReadOptions = {},
): SafeStorageStatus {
  return classifySafeStorage(getElectronContext(), options);
}

function refuseSafeStorageWrite(status: DeniedSafeStorageStatus): never {
  try {
    logMainProcessWarn('Secure storage write refused', {
      state: status.state,
      backend: status.backend,
    });
  } catch {
    // An unavailable logger must not replace the typed write refusal.
  }
  throw new SafeStorageWriteError(status);
}

function encryptString(text: string): Buffer {
  const context = getElectronContext();
  const status = classifySafeStorage(context);
  if (status.state !== 'secure') {
    refuseSafeStorageWrite({
      state: status.state,
      backend: status.backend,
    });
  }
  const storage = context?.safeStorage;
  if (!isWritableSafeStorage(storage)) {
    refuseSafeStorageWrite({ state: 'unavailable', backend: null });
  }
  if (!usesRecovery(storage)) return storage.encryptString(text);
  try {
    return encryptWithLinuxSafeStorageRecovery(text);
  } catch {
    invalidateRecovery(storage);
    refuseSafeStorageWrite({ state: 'unavailable', backend: status.backend });
  }
}

export function getReadableSafeStorage(
  options: SafeStorageReadOptions & {
    /** Environment writes must distinguish provider denial from native false. */
    readonly requireSecureProvider?: boolean;
  } = {},
): ReadableSafeStorage | null {
  const storage = getElectronContext()?.safeStorage;
  if (!isReadableSafeStorage(storage)) {
    if (options.requireSecureProvider && hostOperatingSystem() === 'linux') {
      const provider = getLinuxSecretServiceState();
      if (provider !== 'secure') {
        refuseSafeStorageWrite({ state: provider, backend: null });
      }
    }
    return null;
  }
  return Object.freeze({
    isEncryptionAvailable: (): boolean =>
      isEncryptionAvailable(storage, options, options.requireSecureProvider),
    decryptString: (encrypted: Buffer): string =>
      decryptString(storage, encrypted, options),
  });
}

export function getWritableSafeStorage(): WritableSafeStorage | null {
  const storage = getElectronContext()?.safeStorage;
  if (!isWritableSafeStorage(storage)) return null;
  return Object.freeze({
    isEncryptionAvailable: (): boolean => isEncryptionAvailable(storage),
    decryptString: (encrypted: Buffer): string =>
      decryptString(storage, encrypted),
    encryptString,
  });
}
