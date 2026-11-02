/** Maximum decoded image body. Base64 is bounded before decoding. */
export const MAX_IMAGE_SAVE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SAVE_BASE64_LENGTH =
  4 * Math.ceil(MAX_IMAGE_SAVE_BYTES / 3);

export interface FileSaveOptions {
  /** Omission preserves the existing UTF-8 text editor contract. */
  encoding?: 'utf8' | 'base64';
  /** Exclusive creation; never overwrite a file, directory or symlink. */
  createOnly?: boolean;
}

export interface FileImageSaveSupport {
  version: 1;
  maxDecodedBytes: number;
  formats: {
    png?: { encoding: 'base64'; createOnly: true };
    svg?: { encoding: 'utf8'; createOnly: true };
  };
}

export const DESKTOP_FILE_IMAGE_SAVE_SUPPORT: Readonly<FileImageSaveSupport> = {
  version: 1,
  maxDecodedBytes: MAX_IMAGE_SAVE_BYTES,
  formats: {
    png: { encoding: 'base64', createOnly: true },
    svg: { encoding: 'utf8', createOnly: true },
  },
};

/** Missing/older peers and providers without an explicit format opt-in are unavailable. */
export function supportsFileImageSave(
  support: FileImageSaveSupport | undefined,
  format: 'png' | 'svg',
): boolean {
  const entry = support?.formats?.[format];
  return (
    support?.version === 1 &&
    Number.isFinite(support.maxDecodedBytes) &&
    support.maxDecodedBytes > 0 &&
    entry?.createOnly === true &&
    entry.encoding === (format === 'png' ? 'base64' : 'utf8')
  );
}

// Electron invoke serializes error names. Keep a distinct name for each code
// so transports can restore identity without guessing from filesystem shapes.
export class FileNameConflictError extends Error {
  override readonly name = 'FileNameConflictError';
  readonly code = 'name_conflict';
  constructor(message = 'A file with this name already exists.') {
    super(message);
  }
}
export class FileSaveValidationError extends Error {
  override readonly name = 'FileSaveValidationError';
  readonly code = 'validation';
}
export class FileSaveUnsupportedError extends Error {
  override readonly name = 'FileSaveUnsupportedError';
  readonly code = 'unsupported';
}
export class FileSaveOperationalError extends Error {
  override readonly name = 'FileSaveOperationalError';
  readonly code = 'operation_failed';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    // No class field: Playwright's Babel transform rejects `declare` fields,
    // and a plain field needs `override` only where the lib has Error.cause.
    Object.defineProperty(this, 'cause', {
      value: options?.cause,
      configurable: true,
      writable: true,
    });
  }
}
export type FileImageSaveError =
  | FileNameConflictError
  | FileSaveValidationError
  | FileSaveUnsupportedError
  | FileSaveOperationalError;

/** Restore only this channel's exact named failures, never arbitrary error-object shapes. */
export function restoreFileImageSaveError(
  error: unknown,
): FileImageSaveError | null {
  if (
    error instanceof FileNameConflictError ||
    error instanceof FileSaveValidationError ||
    error instanceof FileSaveUnsupportedError ||
    error instanceof FileSaveOperationalError
  )
    return error;
  if (!(error instanceof Error)) return null;
  const match =
    /^Error invoking remote method 'file:save-content': (FileNameConflictError|FileSaveValidationError|FileSaveUnsupportedError|FileSaveOperationalError): ([\s\S]*)$/.exec(
      error.message,
    );
  if (!match) return null;
  switch (match[1]) {
    case 'FileNameConflictError':
      return new FileNameConflictError(match[2]);
    case 'FileSaveValidationError':
      return new FileSaveValidationError(match[2]);
    case 'FileSaveUnsupportedError':
      return new FileSaveUnsupportedError(match[2]);
    case 'FileSaveOperationalError':
      return new FileSaveOperationalError(match[2]);
    default:
      return null;
  }
}
