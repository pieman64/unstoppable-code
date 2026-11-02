import {
  DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
  FileNameConflictError,
  FileSaveOperationalError,
  FileSaveUnsupportedError,
  FileSaveValidationError,
  restoreFileImageSaveError,
  supportsFileImageSave,
} from '../file-image-save';

it('requires explicit per-format atomic support and defaults old providers to unavailable', () => {
  expect(supportsFileImageSave(undefined, 'png')).toBe(false);
  expect(supportsFileImageSave(undefined, 'svg')).toBe(false);
  expect(
    supportsFileImageSave(
      { version: 1, maxDecodedBytes: 1, formats: {} },
      'png',
    ),
  ).toBe(false);
  expect(
    supportsFileImageSave(
      {
        version: 1,
        maxDecodedBytes: 1,
        formats: { svg: { encoding: 'utf8', createOnly: true } },
      },
      'png',
    ),
  ).toBe(false);
  expect(supportsFileImageSave(DESKTOP_FILE_IMAGE_SAVE_SUPPORT, 'png')).toBe(
    true,
  );
  expect(supportsFileImageSave(DESKTOP_FILE_IMAGE_SAVE_SUPPORT, 'svg')).toBe(
    true,
  );
});

it.each([
  FileNameConflictError,
  FileSaveValidationError,
  FileSaveUnsupportedError,
  FileSaveOperationalError,
])('restores only exact named Electron failures for %p', (ErrorType) => {
  const failure = new ErrorType('detail');
  expect(restoreFileImageSaveError(failure)).toBe(failure);
  const restored = restoreFileImageSaveError(
    new Error(
      `Error invoking remote method 'file:save-content': ${failure.name}: detail`,
    ),
  );
  expect(restored).toBeInstanceOf(ErrorType);
  expect(restored?.code).toBe(failure.code);
  expect(restored?.message).toBe('detail');
});

it.each([
  { code: 'EEXIST' },
  { name: 'FileNameConflictError', message: 'exists' },
  new Error('EEXIST'),
  new Error("Error invoking remote method 'file:save-content': Error: exists"),
  new Error(
    "Error invoking remote method 'other-channel': FileNameConflictError: exists",
  ),
])('does not infer a name conflict from arbitrary errors: %p', (error) => {
  expect(restoreFileImageSaveError(error)).toBeNull();
});
