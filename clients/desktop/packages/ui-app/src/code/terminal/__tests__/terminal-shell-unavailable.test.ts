import { terminalShellUnavailableMessage } from '../terminal-shell-unavailable';

describe('terminalShellUnavailableMessage', () => {
  it('returns the sentence behind IPC and class prefixes', () => {
    expect(
      terminalShellUnavailableMessage(
        new Error(
          "Error invoking remote method 'terminal:spawn': Error: Terminal shell unavailable: zsh can't start.",
        ),
      ),
    ).toBe("zsh can't start.");
    expect(
      terminalShellUnavailableMessage('Terminal shell unavailable: gone'),
    ).toBe('gone');
  });

  it.each([
    new Error('posix_spawnp failed.'),
    new Error('Terminal shell unavailable: '),
    'Unable to start terminal',
    { message: 7 },
    null,
    undefined,
  ])('returns null for other errors (%p)', (error) => {
    expect(terminalShellUnavailableMessage(error)).toBeNull();
  });

  it('tolerates a throwing message getter', () => {
    const error = {
      get message(): string {
        throw new Error('boom');
      },
    };
    expect(terminalShellUnavailableMessage(error)).toBeNull();
  });
});
