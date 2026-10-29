import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { logMainProcessWarn } from './main-process-logging';
import { isRecord } from './type-guards';

export interface ReadableSafeStorage {
  isEncryptionAvailable: () => boolean;
  decryptString: (encrypted: Buffer) => string;
}

export interface WritableSafeStorage extends ReadableSafeStorage {
  encryptString: (text: string) => Buffer;
}

/**
 * `secure` permits native encryption; `unavailable` covers failed readiness,
 * probes, or a missing supported backend. `locked` means selected libsecret
 * reports encryption unavailable (an inference, not a native lock query).
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
}

function classifySafeStorage(
  context: ElectronContext | null,
): SafeStorageStatus {
  const unavailable: SafeStorageStatus = {
    state: 'unavailable',
    backend: null,
  };
  if (!isAppReady(context?.app)) return unavailable;

  const storage = context?.safeStorage;
  if (!isWritableSafeStorage(storage)) return unavailable;
  const platform = hostOperatingSystem();
  if (platform === null) return unavailable;

  let available: boolean;
  try {
    const result: unknown = storage.isEncryptionAvailable();
    if (typeof result !== 'boolean') return unavailable;
    available = result;
  } catch {
    return unavailable;
  }
  if (platform !== 'linux') {
    return { state: available ? 'secure' : 'unavailable', backend: null };
  }

  const backend = getSelectedStorageBackend(storage);
  if (backend !== 'gnome_libsecret') return { state: 'unavailable', backend };
  // The synchronous API has no lock query; unavailability is inferred.
  return { state: available ? 'secure' : 'locked', backend };
}

/**
 * Lazily classifies a fresh Electron context without encryption or caching.
 * Before app readiness it returns `unavailable`; backend probes run only after
 * readiness. Each facade write independently evaluates the same policy again.
 * Secret consumers use the typed secure-storage policy layer.
 */
export function getSafeStorageStatus(): SafeStorageStatus {
  return classifySafeStorage(getElectronContext());
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
  return storage.encryptString(text);
}

export function getReadableSafeStorage(): ReadableSafeStorage | null {
  const storage = getElectronContext()?.safeStorage;
  if (!isReadableSafeStorage(storage)) return null;
  return Object.freeze({
    isEncryptionAvailable: (): boolean => storage.isEncryptionAvailable(),
    decryptString: (encrypted: Buffer): string =>
      storage.decryptString(encrypted),
  });
}

export function getWritableSafeStorage(): WritableSafeStorage | null {
  const storage = getElectronContext()?.safeStorage;
  if (!isWritableSafeStorage(storage)) return null;
  return Object.freeze({
    isEncryptionAvailable: (): boolean => storage.isEncryptionAvailable(),
    decryptString: (encrypted: Buffer): string =>
      storage.decryptString(encrypted),
    encryptString,
  });
}
