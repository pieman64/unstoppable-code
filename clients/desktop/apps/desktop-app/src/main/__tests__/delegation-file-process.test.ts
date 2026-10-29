const stat = jest.fn(() =>
  Promise.resolve({ isFile: () => true, nlink: 1, size: 42 }),
);
jest.mock('node:fs/promises', () => ({ lstat: stat }));
jest.mock('../pipelines/config-paths', () => ({
  getBundledDelegationFileBrokerPath: (): string =>
    '/bundled/bin/canopy-file-broker',
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));
import path from 'node:path';
import { delegationStopSignal } from '../agents/delegation/stop-signal';
import {
  type DelegationRootFileSystem,
  canonicalDelegationRoot,
  delegationFileBinary,
  delegationFileBoundaryAvailable,
} from '../agents/delegation/file-process';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

it('accepts the Windows boundary only when the fixed binary is present', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await expect(delegationFileBoundaryAvailable()).resolves.toBe(true);
  stat.mockRejectedValueOnce(new Error('ENOENT'));
  await expect(delegationFileBoundaryAvailable()).resolves.toBe(false);
  // A hard-linked copy is not the bundled binary.
  stat.mockResolvedValueOnce({ isFile: () => true, nlink: 2, size: 42 });
  await expect(delegationFileBoundaryAvailable()).resolves.toBe(false);
});

it('accepts the macOS boundary only when the fixed binary is present', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  expect(delegationFileBinary()).toBe('/bundled/bin/canopy-file-broker');
  await expect(delegationFileBoundaryAvailable()).resolves.toBe(true);
  expect(stat).toHaveBeenCalledWith('/bundled/bin/canopy-file-broker');
  stat.mockRejectedValueOnce(new Error('ENOENT'));
  await expect(delegationFileBoundaryAvailable()).resolves.toBe(false);
});

it('does not make an unsupported host eligible', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  await expect(delegationFileBoundaryAvailable()).resolves.toBe(false);
});

describe('canonicalDelegationRoot', () => {
  const stats = (
    links: readonly string[],
  ): DelegationRootFileSystem & {
    lstat: jest.Mock<Promise<{ isSymbolicLink(): boolean }>, [string]>;
  } => ({
    realpath: jest.fn((directory: string) =>
      Promise.resolve(directory.replace('RUNNER~1', 'runneradmin')),
    ),
    lstat: jest.fn((file: string) =>
      Promise.resolve({ isSymbolicLink: () => links.includes(file) }),
    ),
  });

  it('accepts a Windows root whose realpath only expands an 8.3 short name', async () => {
    const fsApi = stats([]);
    await expect(
      canonicalDelegationRoot(
        'C:\\Users\\RUNNER~1\\repo',
        'win32',
        fsApi,
        path.win32,
      ),
    ).resolves.toBe('C:\\Users\\runneradmin\\repo');
    expect(fsApi.lstat.mock.calls.map(([file]) => file)).toEqual([
      'C:\\Users\\RUNNER~1\\repo',
      'C:\\Users\\RUNNER~1',
      'C:\\Users',
      'C:\\',
    ]);
  });

  it('refuses a Windows root below a junction or symbolic link', async () => {
    await expect(
      canonicalDelegationRoot(
        'C:\\work\\linked\\repo',
        'win32',
        stats(['C:\\work\\linked']),
        path.win32,
      ),
    ).rejects.toThrow('cannot traverse symbolic links');
  });

  it('keeps the exact macOS realpath rule, including /var aliases', async () => {
    const aliased = {
      realpath: jest.fn(() => Promise.resolve('/private/var/folders/x/repo')),
      lstat: jest.fn(),
    };
    await expect(
      canonicalDelegationRoot(
        '/var/folders/x/repo',
        'darwin',
        aliased,
        path.posix,
      ),
    ).resolves.toBe('/private/var/folders/x/repo');
    const linked = {
      realpath: jest.fn(() => Promise.resolve('/Users/me/elsewhere')),
      lstat: jest.fn(),
    };
    await expect(
      canonicalDelegationRoot('/Users/me/repo', 'darwin', linked, path.posix),
    ).rejects.toThrow('cannot traverse symbolic links');
    expect(linked.lstat).not.toHaveBeenCalled();
  });
});

it('stops delegated process trees with SIGKILL on Windows and SIGTERM elsewhere', () => {
  expect(delegationStopSignal('win32')).toBe('SIGKILL');
  expect(delegationStopSignal('darwin')).toBe('SIGTERM');
  expect(delegationStopSignal('linux')).toBe('SIGTERM');
});
