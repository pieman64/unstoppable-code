import {
  FileSaveConflictError,
  isFileSaveConflictError,
} from '@canopy/protocol/file-save-conflict';
import {
  FileSaveConflictError as AppCoreFileSaveConflictError,
  isFileSaveConflictError as appCoreGuard,
} from '../index';

describe('FileSaveConflictError', () => {
  it('exports one semantic error through protocol and app-core', () => {
    expect(AppCoreFileSaveConflictError).toBe(FileSaveConflictError);
    expect(appCoreGuard).toBe(isFileSaveConflictError);
    const error = new FileSaveConflictError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FileSaveConflictError');
    expect(isFileSaveConflictError(error)).toBe(true);
    expect(error.toString()).toBe(
      'FileSaveConflictError: File changed on disk since it was loaded.',
    );
  });

  it('recognizes the identity without matching the message', () => {
    expect(isFileSaveConflictError(new FileSaveConflictError('changed'))).toBe(
      true,
    );
    expect(
      isFileSaveConflictError({ name: 'FileSaveConflictError', message: '' }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    false,
    409,
    'FileSaveConflictError',
    {},
    { name: 'FileSaveConflictError' },
    { name: 'FileSaveConflictError', message: 123 },
    { name: 'Error', message: 'File changed on disk since it was loaded.' },
    {
      code: 'execution_failed',
      message: 'File changed on disk since it was loaded.',
    },
    new Error('File changed on disk since it was loaded.'),
    new Error(
      "Error invoking remote method 'file:save-content': FileSaveConflictError: changed",
    ),
  ])('does not classify unrelated or malformed errors: %p', (error) => {
    expect(isFileSaveConflictError(error)).toBe(false);
  });
});
