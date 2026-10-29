import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';

export interface SecureStorageNoticeState {
  state: 'locked' | 'unavailable' | 'failed';
  title: string;
  description: string;
  retryable: boolean;
}

export function getSecureStorageNotice(
  failure: SecureStorageFailure,
): SecureStorageNoticeState;
export function getSecureStorageNotice(failure: null): null;
export function getSecureStorageNotice(
  failure: SecureStorageFailure | null,
): SecureStorageNoticeState | null;
export function getSecureStorageNotice(
  failure: SecureStorageFailure | null,
): SecureStorageNoticeState | null {
  if (!failure) return null;
  const outcome =
    failure.operation === 'read'
      ? 'Saved credentials could not be read. Your saved credentials have not been removed.'
      : failure.operation === 'write'
        ? 'Your credentials were not saved. Existing saved credentials have not been removed.'
        : 'Secure storage could not be checked. Existing saved credentials have not been removed.';
  const recovery = failure.retryable
    ? 'Start or unlock your system’s credential store, then retry.'
    : 'Start or configure your system’s credential store, then reopen the app.';
  if (failure.state === 'locked') {
    return {
      state: 'locked',
      title: 'Secure storage is locked or temporarily unavailable.',
      description: `${outcome} ${recovery}`,
      retryable: failure.retryable,
    };
  }
  if (failure.state === 'unavailable') {
    return {
      state: 'unavailable',
      title: 'Secure storage is unavailable.',
      description: `${outcome} ${recovery}`,
      retryable: failure.retryable,
    };
  }
  return {
    state: 'failed',
    title: 'Couldn’t access secure storage.',
    description: `${outcome} ${failure.retryable ? 'Retry when secure storage is available.' : 'Start or configure your system’s credential store, then reopen the app.'}`,
    retryable: failure.retryable,
  };
}

/** Compatibility for older responses that expose only the availability flag. */
export function unavailableSecureStorageFailure(
  operation: SecureStorageFailure['operation'] = 'probe',
): SecureStorageFailure {
  return {
    version: 1,
    code: 'SECURE_STORAGE_PROBE_FAILED',
    operation,
    state: 'unavailable',
    backend: null,
    retryable: true,
  };
}

/** An operation failed without a fresh native availability observation. */
export function unknownSecureStorageFailure(
  operation: SecureStorageFailure['operation'],
): SecureStorageFailure {
  return {
    ...unavailableSecureStorageFailure(operation),
    state: 'unknown',
  };
}
