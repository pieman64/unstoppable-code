import type { WorkspaceIndexReadEntry } from '../../workspace/read-formats';
import { runW5Commit } from '../commit-scope';
import type { W5FileRead, W5FileReplacement, W5FileStore } from '../file-store';
import type { W5StorageTarget } from '../storage-target';
import {
  createWorkspaceIndexRepository,
  WorkspaceIndexUnreadableError,
  type StoredWorkspaceIndexRepository,
} from '../workspace-index-repository';

const INDEX = '/w5/workspaces/index.json';
const storage: W5StorageTarget = {
  namespace: 'workspace_index',
  writer: 'electron_main',
};
type Section = 'chats' | 'plans';
type Entry = WorkspaceIndexReadEntry<Section>;

interface MemoryStore extends W5FileStore {
  files: Map<string, string>;
  replacements: Array<{ filePath: string; replacement: W5FileReplacement }>;
}

function memoryStore(unreadable = new Set<string>()): MemoryStore {
  const files = new Map<string, string>();
  const replacements: MemoryStore['replacements'] = [];
  return {
    files,
    replacements,
    read: (filePath): Promise<W5FileRead> => {
      if (unreadable.has(filePath))
        return Promise.resolve({
          state: 'unreadable',
          error: new Error('EACCES'),
        });
      const raw = files.get(filePath);
      return Promise.resolve(
        raw === undefined ? { state: 'absent' } : { state: 'present', raw },
      );
    },
    replace: (filePath, contents, _storage, replacement): Promise<void> => {
      replacements.push({ filePath, replacement });
      if (replacement.backup)
        files.set(replacement.backup.path, replacement.backup.contents);
      files.set(filePath, contents);
      return Promise.resolve();
    },
  };
}

function entry(id: string): Entry {
  return {
    id,
    name: id,
    type: 'single-repo',
    color: 'blue',
    collapsed: false,
    order: 0,
  };
}

function repository(
  store: W5FileStore,
  hooks: { onCommitted?: () => void; onRefused?: () => void } = {},
): StoredWorkspaceIndexRepository<Entry> {
  return createWorkspaceIndexRepository<Section>({
    store,
    filePath: () => INDEX,
    storage,
    normalizeActivitySectionOrder: (value) => {
      if (!Array.isArray(value)) return undefined;
      const sections = value.filter(
        (section): section is Section =>
          section === 'chats' || section === 'plans',
      );
      return sections.length > 0 ? sections : undefined;
    },
    onCommitted: hooks.onCommitted ?? ((): void => undefined),
    onRefused: hooks.onRefused ?? ((): void => undefined),
  });
}

it('reads activity section orders through the host normalizer', async () => {
  const store = memoryStore();
  store.files.set(
    INDEX,
    JSON.stringify({
      version: 1,
      workspaces: [
        { ...entry('a'), activitySectionOrder: ['plans', 'other', 'chats'] },
        { ...entry('b'), activitySectionOrder: ['other'] },
      ],
    }),
  );
  const read = await repository(store).readStored();
  expect(read.authority).toBe('ok');
  expect(read.entries.map((item) => item.activitySectionOrder)).toEqual([
    ['plans', 'chats'],
    undefined,
  ]);
  expect(read.storedFields[1]?.activitySectionOrder).toEqual(['other']);
});

it('keeps unknown fields and unreadable entries, advances changed rows and backs up only a readable index', async () => {
  const store = memoryStore();
  const before = JSON.stringify({
    version: 1,
    future: true,
    workspaces: [{ ...entry('a'), kept: 1 }, { id: 'broken' }],
  });
  store.files.set(INDEX, before);
  const committed = jest.fn();
  const index = repository(store, { onCommitted: committed });
  await expect(
    index.update((current) => ({
      result: 'done',
      entries: [...current.entries, entry('b')],
    })),
  ).resolves.toBe('done');
  const written = store.files.get(INDEX) ?? '';
  expect(JSON.parse(written)).toEqual({
    version: 1,
    future: true,
    workspaces: [{ ...entry('a'), kept: 1 }, entry('b'), { id: 'broken' }],
  });
  expect(store.replacements).toEqual([
    {
      filePath: INDEX,
      replacement: {
        operation: 'w5.workspace_index.write',
        advance: [
          { kind: 'workspaces' },
          { kind: 'workspace', workspaceId: 'b' },
        ],
        previousRaw: before,
        backup: undefined,
      },
    },
  ]);
  expect(committed).toHaveBeenCalledTimes(1);

  // Replacing the broken entry makes the index fully readable.
  await index.update(() => ({ result: undefined, entries: [entry('broken')] }));
  await index.update(() => ({ result: undefined, entries: [] }));
  expect(store.replacements[2]?.replacement.backup).toEqual({
    path: `${INDEX}.bak`,
    contents: store.files.get(`${INDEX}.bak`),
    previousRaw: null,
  });
  expect(JSON.parse(store.files.get(`${INDEX}.bak`) ?? '')).toMatchObject({
    workspaces: [entry('broken')],
  });
});

it('refuses to rewrite an unreadable index and reports the refusal', async () => {
  const store = memoryStore(new Set([INDEX]));
  const refused = jest.fn();
  const committed = jest.fn();
  const rejection = repository(store, {
    onCommitted: committed,
    onRefused: refused,
  }).update(() => ({ result: undefined, entries: [] }));
  await expect(rejection).rejects.toBeInstanceOf(WorkspaceIndexUnreadableError);
  await expect(rejection).rejects.toMatchObject({
    cause: new Error('EACCES'),
  });
  expect(refused).toHaveBeenCalledTimes(1);
  expect(committed).not.toHaveBeenCalled();
  expect(store.replacements).toEqual([]);
});

it('writes once when the post-commit notification fails, and a retry writes nothing', async () => {
  const store = memoryStore();
  const notified = jest.fn((): void => {
    throw new Error('notification failed');
  });
  const index = repository(store, { onCommitted: notified });
  const change = (): { result: string; entries: Entry[] } => ({
    result: 'written',
    entries: [entry('a')],
  });
  await expect(index.update(change)).rejects.toThrow('notification failed');
  expect(store.replacements).toHaveLength(1);
  expect(notified).toHaveBeenCalledTimes(1);
  expect(JSON.parse(store.files.get(INDEX) ?? '')).toEqual({
    version: 1,
    workspaces: [entry('a')],
  });
  await expect(index.update(change)).resolves.toBe('written');
  expect(store.replacements).toHaveLength(1);
  expect(notified).toHaveBeenCalledTimes(1);
});

it('notifies only after its scope commits, and a failed notification does not commit again', async () => {
  const store = memoryStore();
  const events: string[] = [];
  const index = repository(store, {
    onCommitted: () => {
      events.push('notified');
      throw new Error('notification failed');
    },
  });
  const commit = jest.fn((): Promise<void> => {
    events.push('committed');
    return Promise.resolve();
  });
  await expect(
    runW5Commit(
      store,
      { operation: 'test.index' },
      () => index.update(() => ({ result: undefined, entries: [entry('a')] })),
      commit,
    ),
  ).rejects.toThrow('notification failed');
  expect(events).toEqual(['committed', 'notified']);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(store.replacements).toHaveLength(1);
});
