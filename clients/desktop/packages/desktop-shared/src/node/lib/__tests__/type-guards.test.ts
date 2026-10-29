import { isErrnoException } from '../type-guards';

describe('type guards', () => {
  it('recognizes errors with errno metadata', () => {
    const error = Object.assign(new Error('permission denied'), {
      code: 'EPERM',
    });

    expect(isErrnoException(error)).toBe(true);
  });

  it('rejects non-error values that resemble errno exceptions', () => {
    expect(isErrnoException({ code: 'EPERM' })).toBe(false);
    expect(isErrnoException('EPERM')).toBe(false);
    expect(isErrnoException(null)).toBe(false);
  });
});
