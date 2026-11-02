/**
 * A conditional file save refused because the confirmed version is stale.
 * Transport adapters must preserve this identity rather than match messages.
 * Electron wraps the name in its invoke error message; adapters must extract
 * that name before constructing the shared error on the receiving side.
 */
export class FileSaveConflictError extends Error {
  override readonly name = 'FileSaveConflictError';

  constructor(message = 'File changed on disk since it was loaded.') {
    super(message);
  }
}

/** Recognizes the named contract, including a deserialized error object. */
export function isFileSaveConflictError(
  error: unknown,
): error is FileSaveConflictError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'FileSaveConflictError' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}
