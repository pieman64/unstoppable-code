import type { W5FileReplacement, W5FileStore } from '../file-store';
import type { W5StorageTarget } from '../storage-target';
import {
  createWorkspaceManifestRepository,
  WorkspaceConfigUnreadableError,
  type WorkspaceManifestRepository,
} from '../workspace-manifest-repository';

const storage: W5StorageTarget = {
  namespace: 'workspace_manifest',
  writer: 'electron_main',
};

interface HostConfig {
  version: 1;
  name: string;
  label?: string;
  repos: { id: string; path: string }[];
}

function manifestPath(workspaceId: string): string {
  return `/w5/workspaces/${workspaceId}/workspace.json`;
}

function setup(unreadable = false): {
  files: Map<string, string>;
  replacements: W5FileReplacement[];
  repository: WorkspaceManifestRepository<HostConfig>;
} {
  const files = new Map<string, string>();
  const replacements: W5FileReplacement[] = [];
  const store: W5FileStore = {
    read: (filePath) => {
      if (unreadable)
        return Promise.resolve({
          state: 'unreadable',
          error: new Error('EACCES'),
        });
      const raw = files.get(filePath);
      return Promise.resolve(
        raw === undefined ? { state: 'absent' } : { state: 'present', raw },
      );
    },
    remove: (filePath, _storage, removal): Promise<void> => {
      replacements.push(removal);
      files.delete(filePath);
      return Promise.resolve();
    },
    replace: (filePath, contents, _storage, replacement) => {
      replacements.push(replacement);
      files.set(filePath, contents);
      return Promise.resolve();
    },
  };
  return {
    files,
    replacements,
    repository: createWorkspaceManifestRepository<HostConfig>({
      store,
      filePath: manifestPath,
      storage,
      knownFields: new Set(['version', 'name', 'label', 'repos']),
      knownRepoFields: new Set(['id', 'path']),
    }),
  };
}

it('replaces a host config, keeping unknown project and matching repository fields', async () => {
  const { files, replacements, repository } = setup();
  const before = JSON.stringify({
    version: 1,
    name: 'old',
    label: 'cleared',
    future: { kept: true },
    repos: [
      { id: 'one', path: '/a', extra: 1 },
      { id: 'gone', path: '/b', extra: 2 },
    ],
  });
  files.set(manifestPath('ws'), before);
  const previous = await repository.read('ws');
  expect(previous).toMatchObject({ authority: 'ok', raw: before });
  await repository.replace(
    'ws',
    { version: 1, name: 'new', repos: [{ id: 'one', path: '/c' }] },
    previous,
  );
  expect(JSON.parse(files.get(manifestPath('ws')) ?? '')).toEqual({
    version: 1,
    name: 'new',
    future: { kept: true },
    repos: [{ id: 'one', path: '/c', extra: 1 }],
  });
  expect(replacements).toEqual([
    {
      operation: 'w5.workspace_manifest.write',
      advance: [{ kind: 'workspace', workspaceId: 'ws' }],
      previousRaw: before,
    },
  ]);

  // Equivalent contents commit nothing.
  await repository.replace(
    'ws',
    { version: 1, name: 'new', repos: [{ id: 'one', path: '/c' }] },
    await repository.read('ws'),
  );
  expect(replacements).toHaveLength(1);
});

it('refuses to replace a manifest that could not be read', async () => {
  const { replacements, repository } = setup(true);
  const previous = await repository.read('ws');
  expect(previous).toEqual({
    authority: 'unreadable',
    error: new Error('EACCES'),
  });
  for (const write of [
    (): Promise<void> =>
      repository.replace('ws', { version: 1, name: 'x', repos: [] }, previous),
    (): Promise<void> =>
      repository.replaceDocument('ws', { name: 'x' }, previous),
  ])
    await expect(write()).rejects.toBeInstanceOf(
      WorkspaceConfigUnreadableError,
    );
  expect(replacements).toEqual([]);
});

it('removes even a corrupt manifest, advances once and is absent-idempotent', async () => {
  const { files, replacements, repository } = setup();
  files.set(manifestPath('ws'), 'not json');
  await repository.remove('ws');
  await repository.remove('ws');
  expect(files.has(manifestPath('ws'))).toBe(false);
  expect(replacements).toEqual([
    {
      operation: 'w5.workspace_manifest.remove',
      advance: [{ kind: 'workspace', workspaceId: 'ws' }],
      previousRaw: 'not json',
    },
  ]);
});
it('refuses removal when the manifest cannot be read', async () => {
  const { replacements, repository } = setup(true);
  await expect(repository.remove('ws')).rejects.toBeInstanceOf(
    WorkspaceConfigUnreadableError,
  );
  expect(replacements).toEqual([]);
});
