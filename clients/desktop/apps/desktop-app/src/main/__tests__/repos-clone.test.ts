import { stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { cloneRepo, getRemoteUrl, isGitRepo } from '../lib/git';
import { registerIpcHandler } from '../ipc/register';
import { registerRepoHandlers } from '../ipc/repos';
import { unusedGitReadRuntime } from './helpers/unused-git-read-runtime';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve()),
  readdir: jest.fn(),
  stat: jest.fn(),
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/dialog-window', () => ({
  showOpenDialogForEvent: jest.fn(),
}));
jest.mock('../lib/canopy-json', () => ({ readCanopyJson: jest.fn() }));
jest.mock('../lib/git', () => ({
  cloneRepo: jest.fn(() => Promise.resolve()),
  isGitRepo: jest.fn(() => Promise.resolve(true)),
  getRepoName: jest.fn(() => Promise.resolve('plugins')),
  getRemoteUrl: jest.fn(),
}));

function handler(
  channel: string,
): (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown {
  const call = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`Missing handler ${channel}`);
  return call[1];
}

const event = {} as IpcMainInvokeEvent;

describe('repository clone-only entrypoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(stat)
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    registerRepoHandlers(unusedGitReadRuntime());
  });

  it.each(['tree/main/pstack', 'blob/main/pstack/README.md'])(
    'probes the repository root and reuses its origin for %s',
    async (suffix) => {
      jest.mocked(stat).mockResolvedValue(statSync(__dirname));
      jest
        .mocked(getRemoteUrl)
        .mockResolvedValue('https://github.com/cursor/plugins.git');
      await expect(
        handler(IPC_CHANNELS.repoProbeCloneDestination)(event, {
          remoteUrl: `https://github.com/cursor/plugins/${suffix}`,
          destinationDir: '/repos',
        }),
      ).resolves.toEqual({
        repoName: 'plugins',
        candidateExists: true,
        reusablePath: '/repos/plugins',
      });
      expect(isGitRepo).toHaveBeenCalledWith('/repos/plugins');
    },
  );

  it('normalizes clone-only provisioning and retains collision suffixes', async () => {
    jest.mocked(stat).mockImplementation((candidate) => {
      if (candidate === '/repos/plugins')
        return Promise.resolve(statSync(__dirname));
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    await expect(
      handler(IPC_CHANNELS.repoAddRemote)(event, {
        remoteUrl: ' https://github.com/cursor/plugins/tree/main/pstack ',
        destinationDir: '/repos',
      }),
    ).resolves.toEqual({ name: 'plugins', path: '/repos/plugins-2' });
    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/cursor/plugins',
      '/repos/plugins-2',
    );
  });

  it('does not reuse a different origin', async () => {
    jest.mocked(stat).mockResolvedValue(statSync(__dirname));
    jest
      .mocked(getRemoteUrl)
      .mockResolvedValue('https://github.com/other/plugins');
    await expect(
      handler(IPC_CHANNELS.repoProbeCloneDestination)(event, {
        remoteUrl: 'https://github.com/cursor/plugins/tree/main/pstack',
        destinationDir: '/repos',
      }),
    ).resolves.toEqual({
      repoName: 'plugins',
      candidateExists: true,
      reusablePath: null,
    });
  });

  it('preserves destination validation', async () => {
    await expect(
      handler(IPC_CHANNELS.repoAddRemote)(event, {
        remoteUrl: 'https://github.com/cursor/plugins/tree/main/pstack',
        destinationDir: 'relative',
      }),
    ).rejects.toThrow('Destination directory must be an absolute path');
    expect(cloneRepo).not.toHaveBeenCalled();
  });
});
