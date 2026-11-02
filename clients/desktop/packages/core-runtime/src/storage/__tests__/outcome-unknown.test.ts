import {
  isStorageOutcomeUnknownError,
  StorageOutcomeUnknownError,
  StorageWriteRefusedError,
} from '..';

it('keeps its cause in process but serializes without it or a host path', () => {
  const cause = Object.assign(new Error('EIO /Users/someone/.canopy'), {
    code: 'EIO',
  });
  const error = new StorageOutcomeUnknownError(
    'directory_flush',
    cause,
    'workspace_approvals',
  );
  expect(error.cause).toBe(cause);
  expect(error.message).not.toContain('/Users');
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    name: 'StorageOutcomeUnknownError',
    stage: 'directory_flush',
    namespaceId: 'workspace_approvals',
  });
  expect(
    JSON.parse(
      JSON.stringify(new StorageOutcomeUnknownError('directory_flush', cause)),
    ),
  ).toEqual({ name: 'StorageOutcomeUnknownError', stage: 'directory_flush' });
});

it('is distinct from a refusal', () => {
  const refusal = new StorageWriteRefusedError(
    'preferences',
    'renderer',
    'unlisted_writer',
  );
  expect(isStorageOutcomeUnknownError(refusal)).toBe(false);
  expect(
    isStorageOutcomeUnknownError(
      new StorageOutcomeUnknownError('directory_flush', null),
    ),
  ).toBe(true);
});
