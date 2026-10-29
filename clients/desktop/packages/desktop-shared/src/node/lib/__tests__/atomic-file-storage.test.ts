import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDirectory, writeFileAtomically } from '../atomic-file';
import { withStorageAdmission } from '../storage-admission';
import type * as StorageAuthority from '../../../../../core-runtime/src/storage/writer-authority';

jest.mock('@canopy/core-runtime/storage', () => ({
  ...jest.requireActual<typeof StorageAuthority>(
    '@canopy/core-runtime/storage/writer-authority',
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

it('skips directory sync on Windows, where folders cannot be opened for sync', async () => {
  const missing = join(
    tmpdir(),
    'w5-sync-directory-missing',
    String(Date.now()),
  );
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await expect(syncDirectory(missing)).resolves.toBeUndefined();
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
  await expect(syncDirectory(missing)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
