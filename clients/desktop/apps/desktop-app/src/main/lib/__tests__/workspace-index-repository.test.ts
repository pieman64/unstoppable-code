import type { WorkspaceIndexEntry } from '@canopy/desktop-shared/types';
import {
  createWorkspaceIndexRepository,
  WorkspaceIndexUnreadableError,
  type WorkspaceIndexRepository,
} from '../workspace-index-repository';
import {
  createMemoryFileStore,
  type MemoryFileStore,
} from './w5-memory-file-store';

const INDEX = '/data/workspaces/index.json';

function entry(id: string, order: number): Record<string, unknown> {
  return {
    id,
    name: `Project ${id}`,
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order,
  };
}

function indexJson(document: Record<string, unknown>): string {
  return JSON.stringify(document, null, 2);
}

function parsed(memory: MemoryFileStore, filePath = INDEX): unknown {
  const raw = memory.files.get(filePath);
  if (raw === undefined) throw new Error(`No file at ${filePath}`);
  return JSON.parse(raw);
}

describe('workspace index repository (CAN-3800)', () => {
  let memory: MemoryFileStore;
  let committed: number;
  let refused: number;
  let repository: WorkspaceIndexRepository;

  function setUp(initial?: string): void {
    memory = createMemoryFileStore(
      initial === undefined ? {} : { [INDEX]: initial },
    );
    committed = 0;
    refused = 0;
    repository = createWorkspaceIndexRepository({
      store: memory.store,
      filePath: () => INDEX,
      storage: { namespace: 'workspace_index', writer: 'electron_main' },
      onCommitted: () => {
        committed += 1;
      },
      onRefused: () => {
        refused += 1;
      },
    });
  }

  function writeAll<T>(
    result: T,
    map: (entries: WorkspaceIndexEntry[]) => WorkspaceIndexEntry[],
  ): Promise<T> {
    return repository.update(({ entries }) => ({
      result,
      entries: map(entries),
    }));
  }

  describe('read', () => {
    it.each<[string, string | undefined, string]>([
      ['a missing file', undefined, 'absent'],
      [
        'a valid index',
        indexJson({ version: 1, workspaces: [entry('a', 0)] }),
        'ok',
      ],
      [
        'an entry it cannot normalize',
        indexJson({
          version: 1,
          workspaces: [entry('a', 0), { ...entry('b', 1), type: 'notebook' }],
        }),
        'partial',
      ],
      ['invalid JSON', '{"version": 1, "work', 'unreadable'],
      [
        'another version',
        indexJson({ version: 2, workspaces: [] }),
        'unreadable',
      ],
      [
        'a non-object entry',
        indexJson({ version: 1, workspaces: [entry('a', 0), null] }),
        'unreadable',
      ],
    ])('reports %s as %s', async (_label, initial, authority) => {
      setUp(initial);
      expect((await repository.read()).authority).toBe(authority);
    });

    it('reports a failed read as unreadable, never as an empty index', async () => {
      setUp(indexJson({ version: 1, workspaces: [entry('a', 0)] }));
      memory.unreadable.add(INDEX);

      expect(await repository.read()).toEqual({
        entries: [],
        authority: 'unreadable',
      });
    });
  });

  describe('update', () => {
    it('keeps unknown fields and unreadable entries while clearing known fields', async () => {
      const future = { ...entry('future', 2), type: 'notebook' };
      setUp(
        indexJson({
          version: 1,
          futureTopLevel: true,
          workspaces: [
            { ...entry('a', 0), pinned: true, futureField: 'kept' },
            entry('b', 1),
            future,
          ],
        }),
      );

      await writeAll(undefined, (entries) =>
        entries.map((current) => ({
          ...current,
          pinned: undefined,
          collapsed: true,
        })),
      );

      expect(parsed(memory)).toEqual({
        version: 1,
        futureTopLevel: true,
        workspaces: [
          { ...entry('a', 0), collapsed: true, futureField: 'kept' },
          { ...entry('b', 1), collapsed: true },
          future,
        ],
      });
      expect(committed).toBe(1);
    });

    it('drops an unreadable entry once an entry with its id replaces it', async () => {
      setUp(
        indexJson({
          version: 1,
          workspaces: [{ ...entry('a', 0), type: 'notebook' }],
        }),
      );

      await writeAll(undefined, () => [
        {
          ...entry('a', 0),
          type: 'cowork',
          name: 'A',
          color: '#fff',
          collapsed: false,
          order: 0,
          id: 'a',
        },
      ]);

      expect(parsed(memory)).toEqual({
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'A',
            type: 'cowork',
            color: '#fff',
            collapsed: false,
            order: 0,
          },
        ],
      });
    });

    it('refuses to rewrite an unreadable index and leaves it as it is', async () => {
      setUp('{"version": 1, "work');

      await expect(writeAll(undefined, () => [])).rejects.toBeInstanceOf(
        WorkspaceIndexUnreadableError,
      );

      expect(memory.files.get(INDEX)).toBe('{"version": 1, "work');
      expect(memory.writes).toEqual([]);
      expect(refused).toBe(1);
      expect(committed).toBe(0);
    });

    it('writes nothing when the change decides not to', async () => {
      setUp(indexJson({ version: 1, workspaces: [entry('a', 0)] }));

      expect(await repository.update(() => ({ result: 'skipped' }))).toBe(
        'skipped',
      );

      expect(memory.writes).toEqual([]);
      expect(committed).toBe(0);
    });

    it('backs up only a fully readable index', async () => {
      const readable = indexJson({ version: 1, workspaces: [entry('a', 0)] });
      setUp(readable);
      await writeAll(undefined, (entries) =>
        entries.map((current) => ({ ...current, name: 'Changed' })),
      );
      expect(memory.files.get(`${INDEX}.bak`)).toBe(readable);

      const partial = indexJson({
        version: 1,
        workspaces: [entry('b', 0), { ...entry('c', 1), type: 'notebook' }],
      });
      memory.files.set(INDEX, partial);
      await writeAll(undefined, (entries) =>
        entries.map((current) => ({ ...current, name: 'Changed' })),
      );
      expect(memory.files.get(`${INDEX}.bak`)).toBe(readable);
    });

    it('creates the index when none exists, without a backup', async () => {
      setUp();

      await writeAll(undefined, () => [
        {
          id: 'a',
          name: 'A',
          type: 'cowork',
          color: '#fff',
          collapsed: false,
          order: 0,
        },
      ]);

      expect(memory.writes).toEqual([INDEX]);
      expect(committed).toBe(1);
    });

    it('does not publish a failed write and keeps the committed index', async () => {
      const before = indexJson({ version: 1, workspaces: [entry('a', 0)] });
      setUp(before);
      memory.failingWrites.add(INDEX);

      await expect(
        writeAll(undefined, (entries) =>
          entries.map((current) => ({ ...current, name: 'Renamed' })),
        ),
      ).rejects.toThrow('ENOSPC');

      expect(memory.files.get(INDEX)).toBe(before);
      expect(committed).toBe(0);

      // The queue is not left blocked by the failure.
      memory.failingWrites.clear();
      await writeAll(undefined, (entries) =>
        entries.map((current) => ({ ...current, name: 'Renamed' })),
      );
      expect(parsed(memory)).toMatchObject({
        workspaces: [{ id: 'a', name: 'Renamed' }],
      });
    });

    it('keeps both of two concurrent targeted updates', async () => {
      setUp(
        indexJson({ version: 1, workspaces: [entry('a', 0), entry('b', 1)] }),
      );

      await Promise.all([
        writeAll(undefined, (entries) =>
          entries.map((current) =>
            current.id === 'a' ? { ...current, name: 'Renamed' } : current,
          ),
        ),
        writeAll(undefined, (entries) =>
          entries.map((current) =>
            current.id === 'b' ? { ...current, pinned: true } : current,
          ),
        ),
      ]);

      expect(parsed(memory)).toMatchObject({
        workspaces: [
          { id: 'a', name: 'Renamed' },
          { id: 'b', pinned: true },
        ],
      });
      expect(committed).toBe(2);
    });
  });
});
