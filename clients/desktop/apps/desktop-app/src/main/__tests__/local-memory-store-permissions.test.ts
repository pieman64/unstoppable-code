import type * as FsPromises from 'node:fs/promises';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, chmod: jest.fn(actual.chmod) };
});

import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendInboxNote } from '../memory/local/store';

const chmodMock = jest.mocked(chmod);

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

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('local memory store permissions', () => {
  let rootDir: string;
  let scopeDir: string;

  beforeEach(async () => {
    chmodMock.mockClear();
    rootDir = await mkdtemp(join(tmpdir(), 'local-memory-permissions-'));
    scopeDir = join(rootDir, 'scope');
  });

  afterEach(async () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt(
    'creates directories owner-only and writes notes and the manifest 0o600',
    async () => {
      const fileKey = await appendInboxNote(scopeDir, note);
      expect(fileKey).toMatch(/^inbox\//);

      await expect(modeOf(scopeDir)).resolves.toBe(0o700);
      await expect(modeOf(join(scopeDir, 'inbox'))).resolves.toBe(0o700);
      await expect(modeOf(join(scopeDir, fileKey))).resolves.toBe(0o600);
      await expect(modeOf(join(scopeDir, 'manifest.json'))).resolves.toBe(
        0o600,
      );
    },
  );

  it('fails closed on POSIX when chmod cannot tighten the directory', async () => {
    setPlatform('darwin');
    chmodMock.mockRejectedValueOnce(new Error('EPERM'));
    await expect(appendInboxNote(scopeDir, note)).resolves.toBe('');
    await expect(stat(join(scopeDir, 'inbox'))).rejects.toThrow();
  });

  it('tolerates chmod failures on Windows, which has no POSIX modes', async () => {
    setPlatform('win32');
    chmodMock
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockRejectedValueOnce(new Error('EPERM'));
    await expect(appendInboxNote(scopeDir, note)).resolves.toMatch(/^inbox\//);
  });

  posixIt(
    'replaces a corrupt manifest with an owner-only version 2 manifest',
    async () => {
      await appendInboxNote(scopeDir, note);
      await writeFile(join(scopeDir, 'manifest.json'), 'not-json', {
        mode: 0o644,
      });

      await expect(appendInboxNote(scopeDir, note)).resolves.toMatch(
        /^inbox\//,
      );

      const manifest: unknown = JSON.parse(
        await readFile(join(scopeDir, 'manifest.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({ version: 2, minWriterFormat: 2 });
      await expect(modeOf(join(scopeDir, 'manifest.json'))).resolves.toBe(
        0o600,
      );
    },
  );
});
