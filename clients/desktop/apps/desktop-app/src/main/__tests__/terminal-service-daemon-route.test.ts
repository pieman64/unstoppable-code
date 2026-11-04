/* eslint-disable @typescript-eslint/unbound-method */
import type { TerminalSession } from '@canopy/desktop-shared/types';

const session: TerminalSession = {
  id: 'terminal-1',
  projectId: 'project',
  worktreeId: 'task',
  shell: '/bin/zsh',
  shellBasename: 'zsh',
  cwd: '/root',
  createdAt: 1,
};

const daemon = {
  has: jest.fn((): boolean => false),
  create: jest.fn(() => Promise.resolve({ ...session, id: 'daemon-1' })),
  reattach: jest.fn(() => Promise.resolve({ ...session, id: 'daemon-1' })),
  recreate: jest.fn(() => Promise.resolve(session)),
};

jest.mock('../terminal/worker-terminal', () => ({
  workerTerminal: {
    create: jest.fn(() => session),
    restore: jest.fn(() => session),
    get: jest.fn(() => null),
    prewarmShell: jest.fn(() => Promise.resolve()),
    get daemonTerminals(): unknown {
      return daemon;
    },
  },
  desktopTerminalShells: {
    profile: jest.fn(() => ({
      shell: '/bin/zsh',
      args: ['-l'],
      shellBasename: 'zsh',
    })),
    persisted: jest.fn(() => ({
      shell: '/bin/zsh',
      args: ['-l'],
      shellBasename: 'zsh',
    })),
  },
  desktopTerminalEnvironmentFor: jest.fn(() => ({ PATH: '/usr/bin' })),
}));

jest.mock('../terminal/daemon-terminal-route', () => ({
  selectDaemonTerminalTarget: jest.fn(),
  getDaemonTerminals: jest.fn(() => daemon),
  noteDaemonTerminalFallback: jest.fn(() => false),
  daemonRestoreDirectory: jest.fn(() => ({
    cwdRelativePath: '',
    cwd: '/root',
  })),
}));

jest.mock('../terminal/persistence', () => ({
  terminalPersistenceStore: { getPersistedTerminalEntry: jest.fn() },
}));

const reservations = { held: 0 };

jest.mock('../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: jest.fn(
    async (_project: string, _task: string, start: () => Promise<unknown>) => {
      reservations.held += 1;
      try {
        return await start();
      } finally {
        reservations.held -= 1;
      }
    },
  ),
}));

jest.mock('./../services/split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/root'),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/bin/claude'),
}));

import {
  restoreTerminalForRenderer,
  spawnTerminalForRenderer,
} from '../services/terminal-service';
import { workerTerminal } from '../terminal/worker-terminal';
import {
  noteDaemonTerminalFallback,
  selectDaemonTerminalTarget,
} from '../terminal/daemon-terminal-route';
import { terminalPersistenceStore } from '../terminal/persistence';
import { withWorkspaceTargetRuntimeStartReservation } from '../lib/workspace-target-exclusion';

const TARGET = {
  scope: { workspaceId: 'workspace', worktreeId: 'task' },
  cwdRootId: 'workspace',
  rootPath: '/root',
};
const LOCAL = { localWindow: true };
const REQUEST = {
  projectId: 'project',
  worktreeId: 'task',
  cols: 80,
  rows: 24,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('renderer terminals and the daemon-terminals experiment (CAN-5088)', () => {
  it('opens the next terminal in the daemon while the experiment selects it', async () => {
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(TARGET);
    await expect(
      spawnTerminalForRenderer(REQUEST, LOCAL),
    ).resolves.toMatchObject({
      id: 'daemon-1',
    });
    expect(selectDaemonTerminalTarget).toHaveBeenCalledWith(REQUEST, LOCAL);
    expect(withWorkspaceTargetRuntimeStartReservation).toHaveBeenCalledWith(
      'project',
      'task',
      expect.any(Function),
    );
    expect(daemon.create).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'task',
      scope: TARGET.scope,
      cwdRootId: 'workspace',
      cwdRelativePath: '',
      cwd: '/root',
      shell: { shell: '/bin/zsh', args: ['-l'], shellBasename: 'zsh' },
      environment: { PATH: '/usr/bin' },
      cols: 80,
      rows: 24,
    });
    expect(workerTerminal.create).not.toHaveBeenCalled();
  });

  it('holds a runtime start reservation until the daemon terminal is mirrored, so archiving waits', async () => {
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(TARGET);
    let finish = (): void => undefined;
    daemon.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = (): void => resolve({ ...session, id: 'daemon-1' });
        }),
    );
    const spawning = spawnTerminalForRenderer(REQUEST, LOCAL);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(daemon.create).toHaveBeenCalled();
    expect(reservations.held).toBe(1);
    finish();
    await spawning;
    expect(reservations.held).toBe(0);
  });

  it('opens the next terminal in process once the experiment is off, with nothing to repair', async () => {
    // The route selects nothing when the experiment is off.
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(null);
    await expect(spawnTerminalForRenderer(REQUEST, LOCAL)).resolves.toBe(
      session,
    );
    expect(workerTerminal.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project', worktreeId: 'task' }),
    );
    expect(daemon.create).not.toHaveBeenCalled();
  });

  it('validates renderer ids before any daemon routing', async () => {
    await expect(
      spawnTerminalForRenderer({ ...REQUEST, projectId: '../outside' }, LOCAL),
    ).rejects.toThrow();
    expect(selectDaemonTerminalTarget).not.toHaveBeenCalled();
  });

  it('never consults the route without a renderer window context', async () => {
    await spawnTerminalForRenderer(REQUEST);
    await spawnTerminalForRenderer(REQUEST, { localWindow: false });
    expect(selectDaemonTerminalTarget).not.toHaveBeenCalled();
    expect(workerTerminal.create).toHaveBeenCalledTimes(2);
  });

  it('opens in process when the daemon cannot be reached', async () => {
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(TARGET);
    daemon.create.mockRejectedValueOnce(new Error('unreachable'));
    jest.mocked(noteDaemonTerminalFallback).mockReturnValueOnce(true);
    await expect(spawnTerminalForRenderer(REQUEST, LOCAL)).resolves.toBe(
      session,
    );
    expect(workerTerminal.create).toHaveBeenCalled();
  });

  it('fails a refusal from a reached daemon instead of opening in process', async () => {
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(TARGET);
    const refusal = new Error('refused');
    daemon.create.mockRejectedValueOnce(refusal);
    await expect(spawnTerminalForRenderer(REQUEST, LOCAL)).rejects.toBe(
      refusal,
    );
    expect(workerTerminal.create).not.toHaveBeenCalled();
  });

  it('keeps restoring a live daemon terminal in the daemon after the experiment turns off', async () => {
    daemon.has.mockReturnValueOnce(true);
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(null);
    await restoreTerminalForRenderer(
      { terminalId: 'daemon-1', cols: 90, rows: 30 },
      session,
      LOCAL,
    );
    expect(daemon.reattach).toHaveBeenCalledWith('daemon-1', 90, 30);
    expect(workerTerminal.restore).not.toHaveBeenCalled();
  });

  it('recreates a persisted shell in the daemon when its worktree is selected', async () => {
    jest
      .mocked(terminalPersistenceStore.getPersistedTerminalEntry)
      .mockReturnValue({
        session,
        scrollbackLines: ['one', 'two'],
        exitCode: null,
        signal: 'connection-lost',
      });
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(TARGET);
    await restoreTerminalForRenderer(
      { terminalId: 'terminal-1', cols: 90, rows: 30 },
      session,
      LOCAL,
    );
    expect(daemon.recreate).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: 'terminal-1',
        scrollback: 'one\ntwo',
        cols: 90,
        rows: 30,
      }),
    );
    expect(workerTerminal.restore).not.toHaveBeenCalled();
  });

  it('restores a persisted shell in process when the experiment is off', async () => {
    jest
      .mocked(terminalPersistenceStore.getPersistedTerminalEntry)
      .mockReturnValue({
        session,
        scrollbackLines: [],
        exitCode: null,
        signal: 'app-quit',
      });
    jest.mocked(selectDaemonTerminalTarget).mockResolvedValue(null);
    await restoreTerminalForRenderer(
      { terminalId: 'terminal-1', cols: 90, rows: 30 },
      session,
      LOCAL,
    );
    expect(workerTerminal.restore).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      cols: 90,
      rows: 30,
    });
    expect(daemon.recreate).not.toHaveBeenCalled();
  });
});
