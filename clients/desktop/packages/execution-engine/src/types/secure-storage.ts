export type SecureStorageBackendState =
  | 'secure'
  | 'unknown'
  | 'unavailable'
  | 'locked';

export type SecureStorageFailureCode =
  | 'SECURE_STORAGE_WRITE_REFUSED'
  | 'SECURE_STORAGE_READ_UNAVAILABLE'
  | 'SECURE_STORAGE_PROBE_FAILED'
  | 'SECURE_STORAGE_ENCRYPT_FAILED'
  | 'SECURE_STORAGE_DECRYPT_FAILED';

/** Safe to serialize; never includes secret material or native diagnostics. */
export interface SecureStorageFailure {
  readonly version: 1;
  readonly code: SecureStorageFailureCode;
  readonly operation: 'read' | 'write' | 'probe';
  readonly state: SecureStorageBackendState;
  readonly backend: string | null;
  /** A later attempt is appropriate, but recovery is not guaranteed. */
  readonly retryable: boolean;
}

export type StoredSecretReadResult<T> =
  | {
      status: 'ok';
      value: T | null;
      migrationWriteFailure?: SecureStorageFailure;
    }
  | { status: 'storage-error'; failure: SecureStorageFailure }
  | { status: 'error'; error: unknown };

/** A credential was not saved/read; safe to send through Electron IPC. */
export interface CredentialReadFailure {
  readonly success: false;
  readonly error: string;
  readonly secureStorageFailure?: SecureStorageFailure;
}

export type CredentialSaveResult =
  | { readonly success: true }
  | CredentialReadFailure;

/** Fresh policy observation, not an operation failure or native lock query. */
export interface SecureStorageDiagnostic {
  readonly version: 1;
  readonly state: SecureStorageBackendState;
  readonly backend: string | null;
  readonly writeAvailable: boolean;
}
