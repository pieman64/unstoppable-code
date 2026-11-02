import { toW5CommitLogWorkerError } from '../worker-requests';

class FolderFlushError extends Error {
  readonly code = 'EPERM';
  constructor() {
    super('Directory open failed: EPERM, open C:\\Users');
    this.name = 'DirectoryFlushError';
  }
}

describe('W5 commit log worker errors (CAN-5153)', () => {
  it('names an unexpected failure by its error name and code, never its message', () => {
    const error = toW5CommitLogWorkerError(new FolderFlushError());
    expect(error).toEqual({
      kind: 'failed',
      message:
        'The W5 commit log call failed unexpectedly (DirectoryFlushError EPERM)',
    });
  });

  it.each([
    ['a value that is not an error', 'C:\\Users\\someone'],
    [
      'a name or code that is not a plain identifier',
      { name: 'C:\\x', code: 'E/1' },
    ],
  ])('keeps the fixed message for %s', (_case, thrown) => {
    expect(toW5CommitLogWorkerError(thrown)).toEqual({
      kind: 'failed',
      message: 'The W5 commit log call failed unexpectedly',
    });
  });

  it('keeps only the name when the error has no code', () => {
    expect(toW5CommitLogWorkerError(new TypeError('at /private/x'))).toEqual({
      kind: 'failed',
      message: 'The W5 commit log call failed unexpectedly (TypeError)',
    });
  });
});
