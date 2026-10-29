import { dialog } from 'electron';
import { IPC_CHANNELS, type RepoSelection } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { isGitRepo, getRepoName } from '../lib/git';

jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: jest.fn(),
  },
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  isGitRepo: jest.fn(),
  getRepoName: jest.fn(),
  addRemoteAndSync: jest.fn(),
  cloneRepo: jest.fn(),
  getRemoteUrl: jest.fn(),
  initLocalRepo: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve()),
  readdir: jest.fn(() => Promise.resolve([])),
  stat: jest.fn(() => Promise.reject(new Error('not found'))),
}));

jest.mock('../lib/paths', () => ({
  getDefaultReposDir: jest.fn(() => '/default/repos'),
}));

jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
}));

jest.mock('../lib/repo-url-matcher', () => ({
  remoteUrlsMatch: jest.fn(),
}));

const mockedDialog = jest.mocked(dialog);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedGetRepoName = jest.mocked(getRepoName);

function getHandler(
  channel: string,
): (...args: unknown[]) => Promise<RepoSelection | null> {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  const handler = call?.[1];
  if (typeof handler !== 'function') {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler as (...args: unknown[]) => Promise<RepoSelection | null>;
}

describe('repos IPC: browsing a folder for the add-workspace flow', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const { registerRepoHandlers } = await import('../ipc/repos');
    registerRepoHandlers();
  });

  it('with allowNonGit: true, resolves a non-git folder without throwing, using the folder name', async () => {
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/demo/plain-folder'],
    } as never);
    mockedIsGitRepo.mockResolvedValue(false);

    const handler = getHandler(IPC_CHANNELS.repoBrowse);
    const result = await handler(undefined, { allowNonGit: true });

    expect(result).toEqual({
      name: 'plain-folder',
      path: '/Users/demo/plain-folder',
    });
    expect(mockedGetRepoName).not.toHaveBeenCalled();
  });

  it('with allowNonGit: true, still resolves the git-derived name for a git repo folder', async () => {
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/demo/some-repo'],
    } as never);
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetRepoName.mockResolvedValue('some-repo');

    const handler = getHandler(IPC_CHANNELS.repoBrowse);
    const result = await handler(undefined, { allowNonGit: true });

    expect(result).toEqual({
      name: 'some-repo',
      path: '/Users/demo/some-repo',
    });
  });

  it('without allowNonGit (multi-repo add-repo flow), rejects a non-git folder at browse time', async () => {
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/demo/plain-folder'],
    } as never);
    mockedIsGitRepo.mockResolvedValue(false);

    const handler = getHandler(IPC_CHANNELS.repoBrowse);

    await expect(handler(undefined)).rejects.toThrow(
      'Selected directory is not a git repository',
    );
    expect(mockedGetRepoName).not.toHaveBeenCalled();
  });

  it('without allowNonGit, still resolves the git-derived name for a git repo folder', async () => {
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/demo/some-repo'],
    } as never);
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetRepoName.mockResolvedValue('some-repo');

    const handler = getHandler(IPC_CHANNELS.repoBrowse);
    const result = await handler(undefined, { allowNonGit: false });

    expect(result).toEqual({
      name: 'some-repo',
      path: '/Users/demo/some-repo',
    });
  });

  it('returns null when the dialog is canceled', async () => {
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as never);

    const handler = getHandler(IPC_CHANNELS.repoBrowse);
    const result = await handler(undefined, { allowNonGit: true });

    expect(result).toBeNull();
    expect(mockedIsGitRepo).not.toHaveBeenCalled();
  });

  it('repoAddLocal still requires a git repository (unaffected by the browse fix)', async () => {
    mockedIsGitRepo.mockResolvedValue(false);

    const handler = getHandler(IPC_CHANNELS.repoAddLocal);
    await expect(
      handler(undefined, '/Users/demo/plain-folder'),
    ).rejects.toThrow('Selected directory is not a git repository');
  });
});
