jest.mock('node:fs/promises', () => ({
  chmod: jest.fn(() => Promise.resolve()),
  mkdir: jest.fn(() => Promise.resolve()),
  readFile: jest.fn(() => Promise.resolve('')),
  readdir: jest.fn(() => Promise.resolve([])),
  stat: jest.fn(() => Promise.resolve({ mtimeMs: 0 })),
  writeFile: jest.fn(() => Promise.resolve()),
}));

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendInboxNote } from '../memory/local/store';

const chmodMock = jest.mocked(chmod);
const mkdirMock = jest.mocked(mkdir);
const readFileMock = jest.mocked(readFile);
const writeFileMock = jest.mocked(writeFile);

const scopeDir = join('/memory', 'scope');
const note = {
  text: 'Remember the deploy checklist.',
  source: { provider: 'claude', chatId: 'chat-1' },
};

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    writable: true,
    configurable: true,
  });
}

describe('local memory store permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('creates directories owner-only and writes notes and the manifest 0o600', async () => {
    const fileKey = await appendInboxNote(scopeDir, note);
    expect(fileKey).toMatch(/^inbox\//);

    expect(mkdirMock).toHaveBeenCalledWith(join(scopeDir, 'inbox'), {
      recursive: true,
      mode: 0o700,
    });
    expect(mkdirMock).toHaveBeenCalledWith(scopeDir, {
      recursive: true,
      mode: 0o700,
    });
    expect(chmodMock).toHaveBeenCalledWith(join(scopeDir, 'inbox'), 0o700);
    expect(chmodMock).toHaveBeenCalledWith(scopeDir, 0o700);
    expect(writeFileMock).toHaveBeenCalledWith(
      join(scopeDir, 'manifest.json'),
      '{\n  "version": 1\n}\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const noteWrite = writeFileMock.mock.calls.find(
      ([path]) =>
        typeof path === 'string' && path.startsWith(join(scopeDir, 'inbox')),
    );
    expect(noteWrite?.[2]).toEqual({
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  });

  it('fails closed on POSIX when chmod cannot tighten the directory', async () => {
    setPlatform('darwin');
    chmodMock.mockRejectedValueOnce(new Error('EPERM'));
    await expect(appendInboxNote(scopeDir, note)).resolves.toBe('');
    const noteWrite = writeFileMock.mock.calls.find(
      ([path]) =>
        typeof path === 'string' && path.startsWith(join(scopeDir, 'inbox')),
    );
    expect(noteWrite).toBeUndefined();
  });

  it('tolerates chmod failures on Windows, which has no POSIX modes', async () => {
    setPlatform('win32');
    chmodMock
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockRejectedValueOnce(new Error('EPERM'));
    await expect(appendInboxNote(scopeDir, note)).resolves.toMatch(/^inbox\//);
  });

  it('rewrites a corrupt manifest with owner-only file mode', async () => {
    const exists: NodeJS.ErrnoException = new Error('exists');
    exists.code = 'EEXIST';
    writeFileMock.mockRejectedValueOnce(exists);
    readFileMock.mockResolvedValueOnce('not-json');

    const fileKey = await appendInboxNote(scopeDir, note);
    expect(fileKey).toMatch(/^inbox\//);

    expect(writeFileMock).toHaveBeenCalledWith(
      join(scopeDir, 'manifest.json'),
      '{\n  "version": 1\n}\n',
      { encoding: 'utf8', mode: 0o600 },
    );
  });
});
