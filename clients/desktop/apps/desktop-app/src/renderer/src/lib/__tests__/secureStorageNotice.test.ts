import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import { getSecureStorageNotice } from '../secureStorageNotice';

function failure(
  state: SecureStorageFailure['state'],
  code: SecureStorageFailure['code'] = 'SECURE_STORAGE_WRITE_REFUSED',
): SecureStorageFailure {
  return {
    version: 1,
    code,
    state,
    operation: 'write',
    backend: null,
    retryable: true,
  };
}

describe('secure storage notice mapping', () => {
  it.each(['locked', 'unavailable', 'secure'] as const)(
    'maps %s without native diagnostics',
    (state) => {
      const notice = getSecureStorageNotice(failure(state));
      expect(notice.state).toBe(
        state === 'locked'
          ? 'locked'
          : state === 'unavailable'
            ? 'unavailable'
            : 'failed',
      );
      expect(notice.title).toBeTruthy();
      expect(notice.description).not.toContain('WRITE_REFUSED');
      expect(notice.retryable).toBe(true);
    },
  );
  it('treats encryption and probe failures as failed even with a secure backend', () => {
    expect(
      getSecureStorageNotice(failure('secure', 'SECURE_STORAGE_ENCRYPT_FAILED'))
        .state,
    ).toBe('failed');
    expect(
      getSecureStorageNotice(failure('secure', 'SECURE_STORAGE_PROBE_FAILED'))
        .state,
    ).toBe('failed');
  });
  it('does not call a saved credential unavailable when no failure exists', () => {
    expect(getSecureStorageNotice(null)).toBeNull();
  });
  it('does not promise a retry for non-retryable corruption', () => {
    expect(
      getSecureStorageNotice({
        ...failure('secure', 'SECURE_STORAGE_DECRYPT_FAILED'),
        retryable: false,
      }).retryable,
    ).toBe(false);
  });
});
