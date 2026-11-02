import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDirectory, writeFileAtomically } from '../atomic-file';
import { withStorageAdmission } from '../storage-admission';
import type * as StorageAuthority from '../../../../../core-runtime/src/storage/writer-authority';
import type * as OutcomeUnknown from '../../../../../core-runtime/src/storage/outcome-unknown';

jest.mock('@canopy/core-runtime/storage', () => ({
  ...jest.requireActual<typeof StorageAuthority>(
    '@canopy/core-runtime/storage/writer-authority',
  ),
  ...jest.requireActual<typeof OutcomeUnknown>(
    '@canopy/core-runtime/storage/outcome-unknown',
  ),
  STORAGE_OWNERSHIP: [
    {
      id: 'workspace_index',
      transitionOwner: 'daemon',
      currentWriters: [],
      schemaVersion: 1,
      backupPolicy: 'required_before_flip',
    },
    {
      id: 'workspace_manifest',
      transitionOwner: 'legacy',
      currentWriters: ['electron_main'],
      schemaVersion: 1,
      backupPolicy: 'required_before_flip',
    },
  ],
}));

it.each(['electron_main', 'desktop_cli'] as const)(
  'refuses %s before touching a daemon-owned destination or sibling',
  async (writer) => {
    const root = await mkdtemp(join(tmpdir(), 'storage-refusal-'));
    const target = join(root, 'index.json');
    try {
      await writeFile(target, 'original');
      const options = {
        mode: 0o600,
        storage: { namespace: 'workspace_index' as const, writer },
      };
      await expect(
        writeFileAtomically(target, 'replacement', options),
      ).rejects.toMatchObject({ reason: 'daemon_owned' });
      expect(await readFile(target, 'utf8')).toBe('original');
      expect(await readdir(root)).toEqual(['index.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { namespace: 'workspace_index', writer: 'daemon' },
  { namespace: 'workspace_manifest', writer: 'electron_main' },
] as const)(
  'installs allowed $writer writes to $namespace',
  async (storage) => {
    const root = await mkdtemp(join(tmpdir(), 'storage-allowed-'));
    const target = join(root, 'index.json');
    try {
      const options = { mode: 0o600, overwrite: false, storage };
      await withStorageAdmission([storage], async () => {
        await writeFileAtomically(target, 'complete', options);
        expect(await readFile(target, 'utf8')).toBe('complete');
        await expect(
          writeFileAtomically(target, 'other', options),
        ).rejects.toMatchObject({ code: 'EEXIST' });
      });
      expect(await readFile(target, 'utf8')).toBe('complete');
      expect(await readdir(root)).toEqual(['index.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['win32', 'darwin', 'linux'])(
  'fails a missing folder sync on %s instead of skipping it',
  async (platform) => {
    const missing = join(
      tmpdir(),
      'w5-sync-directory-missing',
      String(Date.now()),
    );
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      await expect(syncDirectory(missing)).rejects.toMatchObject({
        name: 'DirectoryFlushError',
        stage: 'open',
        code: 'ENOENT',
      });
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  },
);

it('flushes an existing folder on the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-sync-'));
  try {
    await writeFile(join(root, 'entry'), 'x');
    await expect(syncDirectory(root)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('durably replaces through a Windows read-write parent flush, reporting any failure after install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-windows-'));
  const target = join(root, 'state.json');
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  const host = process.platform;
  try {
    await writeFile(target, 'previous');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const write = writeFileAtomically(target, 'next', { durable: true });
    if (host === 'win32') {
      await expect(write).resolves.toBeUndefined();
    } else {
      // POSIX refuses to open a folder read-write: the D1 flush cannot run
      // here, so the installed write's outcome is unknown, never a no-op.
      await expect(write).rejects.toMatchObject({
        name: 'StorageOutcomeUnknownError',
        stage: 'directory_flush',
        cause: { name: 'DirectoryFlushError', stage: 'open', code: 'EISDIR' },
      });
    }
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
  try {
    expect(await readFile(target, 'utf8')).toBe('next');
    expect(await readdir(root)).toEqual(['state.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
