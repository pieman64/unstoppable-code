import {
  isProfileRecord,
  type BrowserProfileErrorCode,
  type BrowserProfilePatch,
} from '@canopy/protocol/browser-profiles';

export class BrowserProfileError extends Error {
  constructor(
    readonly code: BrowserProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserProfileError';
  }
}

/** Reject unknown configuration fields; agents cannot use this user-only shape. */
export function validateProfilePatch(
  value: unknown,
): asserts value is BrowserProfilePatch {
  if (
    !isProfileRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !['displayName', 'color', 'allowEnable', 'allowClear'].includes(key),
    ) ||
    (value.displayName !== undefined &&
      (typeof value.displayName !== 'string' ||
        !value.displayName.trim() ||
        value.displayName.length > 100)) ||
    (value.color !== undefined &&
      (typeof value.color !== 'string' ||
        !/^#[0-9a-fA-F]{6}$/.test(value.color))) ||
    (value.allowEnable !== undefined &&
      typeof value.allowEnable !== 'boolean') ||
    (value.allowClear !== undefined && typeof value.allowClear !== 'boolean')
  ) {
    throw new BrowserProfileError(
      'invalid_request',
      'Invalid browser profile settings. Use a name of 1–100 characters, a hex color, and boolean permissions.',
    );
  }
}
