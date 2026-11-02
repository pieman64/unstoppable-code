import { handleCopilotTurnCleanupError } from '../turn-cleanup';

describe('Copilot turn cleanup errors', () => {
  let warning: jest.SpyInstance;
  beforeEach(() => {
    warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warning.mockRestore());

  it('does not report a cleanup error already thrown after a successful turn as a turn error', () => {
    const cleanup = new Error('Copilot process cleanup did not finish.');
    expect(() => handleCopilotTurnCleanupError(cleanup, false)).toThrow(
      cleanup,
    );
    // The next owner sees the thrown cleanup error as its own turn failure.
    handleCopilotTurnCleanupError(cleanup, true);
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not report a non-Error cleanup rejection again after a successful turn', () => {
    let thrown: unknown;
    try {
      handleCopilotTurnCleanupError({ reason: 'not an Error' }, false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    handleCopilotTurnCleanupError(thrown, true);
    expect(warning).not.toHaveBeenCalled();
  });

  it('names the signal that stopped a timed-out process command', () => {
    const cleanup = Object.assign(
      new Error('Copilot process ownership could not be inspected.'),
      {
        cause: Object.assign(new Error('Command failed: /bin/ps'), {
          killed: true,
          signal: 'SIGTERM',
          code: null,
        }),
      },
    );
    handleCopilotTurnCleanupError(cleanup, true);
    expect(warning.mock.calls).toEqual([
      [
        'Copilot runtime cleanup failed after a turn error.',
        { code: 'COPILOT_TURN_CLEANUP_FAILED', detail: 'SIGTERM' },
      ],
    ]);
  });

  it('names the OS error behind a cleanup warning', () => {
    const cleanup = Object.assign(
      new Error('Copilot process ownership could not be inspected.'),
      {
        cause: Object.assign(new Error('spawn EBADF'), {
          code: 'EBADF',
          syscall: 'spawn',
        }),
      },
    );
    handleCopilotTurnCleanupError(cleanup, true);
    expect(warning.mock.calls).toEqual([
      [
        'Copilot runtime cleanup failed after a turn error.',
        { code: 'COPILOT_TURN_CLEANUP_FAILED', detail: 'spawn EBADF' },
      ],
    ]);
  });
});
