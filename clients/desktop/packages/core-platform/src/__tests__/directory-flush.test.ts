import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { PLATFORM_SERVICE_METHODS } from '@canopy/core-runtime';
import {
  DirectoryFlushError,
  directoryFlushOpenFlags,
  flushDirectory,
  flushDirectorySync,
  WINDOWS_DIRECTORY_FLUSH_LABEL,
} from '../directory-flush';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const fsError = (code: string): Error =>
  Object.assign(new Error(code), { code });

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'directory-flush-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

it('opens Windows directories read-write and POSIX directories read-only', () => {
  expect(directoryFlushOpenFlags('win32')).toBe('r+');
  expect(directoryFlushOpenFlags('darwin')).toBe('r');
  expect(directoryFlushOpenFlags('linux')).toBe('r');
  expect(directoryFlushOpenFlags(null)).toBe('r');
  expect(WINDOWS_DIRECTORY_FLUSH_LABEL).toBe(
    'API-level flush; namespace ordering undocumented; power-loss unverified',
  );
});

// Core-runtime tests that copy this flush, which they may not import, check
// the same contract (vault crash.test.ts).
it('ships the Windows flush the platform contract declares', () => {
  const contract = PLATFORM_SERVICE_METHODS.find(
    (method) => method.id === 'secureFiles.syncDirectory',
  );
  expect(contract?.win32).toBe('implemented');
  expect(contract?.purpose).toContain(
    `Windows flushes a read-write handle (CAN-5151 D1: ${WINDOWS_DIRECTORY_FLUSH_LABEL})`,
  );
});

it('flushes a real directory on the host, asynchronously and synchronously', async () => {
  await fs.writeFile(path.join(dir, 'a'), 'a');
  await fs.rename(path.join(dir, 'a'), path.join(dir, 'b'));
  await expect(flushDirectory(dir)).resolves.toBe('flushed');
  expect(flushDirectorySync(dir)).toBe('flushed');
});

it('reports a missing directory as a typed open failure, never a no-op', async () => {
  const missing = path.join(dir, 'missing');
  for (const os of ['win32', 'darwin', 'linux'] as const) {
    await expect(flushDirectory(missing, { os })).rejects.toMatchObject({
      name: 'DirectoryFlushError',
      stage: 'open',
      code: 'ENOENT',
    });
    expect(() => flushDirectorySync(missing, { os })).toThrow(
      DirectoryFlushError,
    );
  }
});

it('closes the handle and types the failure when the flush or close fails', async () => {
  const close = jest.fn(() => Promise.resolve());
  const sync = jest.fn<Promise<void>, []>(() =>
    Promise.reject(fsError('EPERM')),
  );
  const openDirectory = jest.fn(() => Promise.resolve({ sync, close }));
  const failure = flushDirectory(dir, { os: 'win32', openDirectory });
  await expect(failure).rejects.toBeInstanceOf(DirectoryFlushError);
  await expect(
    flushDirectory(dir, { os: 'win32', openDirectory }),
  ).rejects.toMatchObject({ stage: 'flush', code: 'EPERM' });
  expect(close).toHaveBeenCalledTimes(2);
  sync.mockImplementationOnce(() =>
    Promise.reject(new Error('injected flush failure')),
  );
  await expect(
    flushDirectory(dir, { os: 'win32', openDirectory }),
  ).rejects.toMatchObject({
    message: 'Directory flush failed: injected flush failure',
    code: 'EUNKNOWN',
  });

  sync.mockImplementation(() => Promise.resolve());
  close.mockImplementationOnce(() => Promise.reject(fsError('EBADF')));
  await expect(
    flushDirectory(dir, { os: 'win32', openDirectory }),
  ).rejects.toMatchObject({ stage: 'close', code: 'EBADF' });
});

windowsIt(
  'needs a read-write handle on Windows, where a read-only flush is EPERM',
  async () => {
    const readOnly = await fs.open(dir, 'r');
    try {
      await expect(readOnly.sync()).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      await readOnly.close();
    }
    await fs.mkdir(path.join(dir, 'child'));
    await fs.writeFile(path.join(dir, 'file'), 'x');
    await fs.link(path.join(dir, 'file'), path.join(dir, 'linked'));
    await fs.unlink(path.join(dir, 'file'));
    await expect(flushDirectory(dir, { os: 'win32' })).resolves.toBe('flushed');
    expect(flushDirectorySync(dir, { os: 'win32' })).toBe('flushed');
  },
);

// CAN-5153: the anchor of every default data root (`~/.canopy*`), which a
// standard user owns. `C:\Users` and `C:\` above it are never flushed.
windowsIt('flushes the home folder read-write on Windows', async () => {
  await expect(flushDirectory(homedir(), { os: 'win32' })).resolves.toBe(
    'flushed',
  );
  expect(flushDirectorySync(homedir(), { os: 'win32' })).toBe('flushed');
});
