import type { PlatformTrashErrorCode } from './platform-services';

/** A Trash rejection with its outcome. Fixed messages only: no paths or helper output. */
export class PlatformTrashError extends Error {
  override readonly name = 'PlatformTrashError';
  readonly code: PlatformTrashErrorCode;

  constructor(code: PlatformTrashErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
