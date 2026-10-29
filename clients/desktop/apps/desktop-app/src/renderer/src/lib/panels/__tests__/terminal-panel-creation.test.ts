/** @jest-environment jsdom */

/**
 * A terminal opened from a shell profile that cannot start is a failed
 * explicit selection: the add-panel menu keeps its recovery path (an error
 * toast carrying the main-process reason) and opens nothing, so the user's
 * command is never reinterpreted by a different shell.
 */
const addToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): unknown => ({ addToast }) },
}));

const addGroupWithTerminal = jest.fn();
jest.mock('@/stores/terminalStore', () => ({
  ensureTerminalWorktreeHydrated: (): Promise<void> => Promise.resolve(),
  useTerminalStore: {
    getState: (): unknown => ({
      addGroupWithTerminal,
      removeTerminal: jest.fn(),
    }),
  },
}));

jest.mock('../tab-row-limit', () => ({
  refuseFullTabRow: (): boolean => false,
}));

import { createTerminalPanel } from '../panel-creation-actions';

const spawn = jest.fn();

describe('createTerminalPanel with a shell that cannot start', () => {
  beforeEach(() => {
    addToast.mockReset();
    addGroupWithTerminal.mockReset();
    spawn.mockReset();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { terminal: { spawn, kill: jest.fn() } },
    });
  });

  afterEach(() => {
    delete (window as typeof window & { api?: unknown }).api;
  });

  it('reports the reason once and opens no terminal or fallback shell', async () => {
    spawn.mockRejectedValue(
      new Error(
        "Error invoking remote method 'terminal:spawn': Error: Can't start zsh: it isn't installed on this computer. Choose another shell and try again.",
      ),
    );

    const added = await createTerminalPanel('project/wt', 'group', 'zsh');

    expect(added).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ terminalProfileId: 'zsh' }),
    );
    expect(addGroupWithTerminal).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      "Unable to open Terminal. Can't start zsh: it isn't installed on this computer. Choose another shell and try again.",
      'error',
      undefined,
      {
        projectId: 'project',
        worktreeId: 'wt',
        blockMessageFromReplay: true,
      },
    );
  });
});
