import {
  BrowserReadTargetError,
  browserReadTargetFailure,
  decodeBrowserReadTargetError,
} from '../read-target-error';

describe('typed read failures (E3)', () => {
  it('keeps a plain message and reads the code back from the error or its IPC string', () => {
    const error = new BrowserReadTargetError(
      'frame_unavailable',
      'No frame matches the frame field.',
    );
    expect(error.message).toBe('No frame matches the frame field.');
    expect(decodeBrowserReadTargetError(error)).toEqual({
      code: 'frame_unavailable',
      message: 'No frame matches the frame field.',
    });
    // What Electron rejects an invoke with: `Error invoking … ': ${error}`.
    const crossed = new Error(
      `Error invoking remote method 'browser:inspect': ${String(error)}`,
    );
    expect(decodeBrowserReadTargetError(crossed)).toEqual({
      code: 'frame_unavailable',
      message: 'No frame matches the frame field.',
    });
    expect(decodeBrowserReadTargetError(String(error))).toEqual({
      code: 'frame_unavailable',
      message: 'No frame matches the frame field.',
    });
  });

  it.each([
    'target_not_found: No element matched the target.',
    "Error invoking remote method 'browser:inspect': Error: target_stale: gone",
    'Page said: BrowserReadTargetError[target_stale]: gone',
    "Error invoking remote method 'browser:inspect': Error: BrowserReadTargetError[target_stale]: gone",
    'BrowserReadTargetError[made_up]: gone',
    'BrowserReadTargetError[target_stale]: ',
    'BrowserReadTargetError[target_stale] gone',
    'browserreadtargeterror[target_stale]: gone',
  ])('never reads an ordinary message as a coded failure: %p', (message) => {
    expect(decodeBrowserReadTargetError(new Error(message))).toBeUndefined();
  });

  it('ignores values that are not errors or strings', () => {
    expect(decodeBrowserReadTargetError(undefined)).toBeUndefined();
    expect(
      decodeBrowserReadTargetError({ code: 'target_stale', message: 'x' }),
    ).toBeUndefined();
  });

  it('fails like an action refusal: invalid_target, the plain message, the code in details', () => {
    expect(
      browserReadTargetFailure({ code: 'target_stale', message: 'Gone.' }),
    ).toEqual({
      code: 'invalid_target',
      message: 'Gone.',
      details: {
        error: {
          code: 'target_stale',
          message: 'Gone.',
          retryable: false,
          next: 'browser.input_snapshot',
        },
      },
    });
    expect(
      browserReadTargetFailure({
        code: 'invalid_locator',
        message: 'Unsupported.',
      }),
    ).toEqual({
      code: 'execution_failed',
      message: 'Unsupported.',
      details: {
        error: {
          code: 'execution_failed',
          message: 'Unsupported.',
          retryable: false,
        },
      },
    });
  });
});
