import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  createWorktreeListRepository,
  WorktreeRegistryUnreadableError,
  type WorktreeListRepository,
} from '../worktree-list-repository';
import {
  createMemoryFileStore,
  type MemoryFileStore,
} from './w5-memory-file-store';

const listPath = (workspaceId: string): string =>
  `/data/workspaces/${workspaceId}/worktrees.json`;

function row(id: string, extra: Record<string, unknown> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

describe('worktree list repository (CAN-3803)', () => {
  let memory: MemoryFileStore;
  let repository: WorktreeListRepository;

  function setUp(initial?: unknown): void {
    memory = createMemoryFileStore(
      initial === undefined
        ? {}
        : {
            [listPath('w')]:
              typeof initial === 'string' ? initial : JSON.stringify(initial),
          },
    );
    repository = createWorktreeListRepository({
      store: memory.store,
      filePath: listPath,
      storage: { namespace: 'worktree_list', writer: 'electron_main' },
      knownRowFields: new Set(['id', 'branchName', 'createdAt', 'label']),
    });
  }

  function onDisk(): unknown {
    const raw = memory.files.get(listPath('w'));
    if (raw === undefined) throw new Error('No worktree list');
    return JSON.parse(raw);
  }

  describe('read', () => {
    it('reports a list whose rows it all read as complete', async () => {
      setUp({ version: 1, worktrees: [row('a')] });
      const read = await repository.read('w');
      expect(read.authority === 'ok' && read.complete).toBe(true);
    });

    it.each<[string, unknown, string]>([
      ['a missing file', undefined, 'absent'],
      ['invalid JSON', '{"version":1,"worktrees":[', 'unreadable'],
      ['another version', { version: 2, worktrees: [] }, 'unreadable'],
      ['a missing row list', { version: 1 }, 'unreadable'],
      ['a valid list', { version: 1, worktrees: [row('a')] }, 'ok'],
    ])('reports %s as %s', async (_label, initial, authority) => {
      setUp(initial);
      expect((await repository.read('w')).authority).toBe(authority);
    });

    it('reports a failed read as unreadable', async () => {
      setUp({ version: 1, worktrees: [row('a')] });
      memory.unreadable.add(listPath('w'));
      expect(await repository.read('w')).toEqual({ authority: 'unreadable' });
    });

    it('leaves out rows it cannot read', async () => {
      setUp({ version: 1, worktrees: [row('a'), { id: 'b' }, 'c'] });
      const read = await repository.read('w');
      expect(read.authority === 'ok' ? read.worktrees : null).toEqual([
        row('a', { replica: { state: 'never-recorded' } }),
      ]);
      expect(read.authority === 'ok' && read.complete).toBe(false);
      expect(read.authority === 'ok' ? read.unreadableRowIds : null).toEqual([
        'b',
      ]);
    });
  });

  describe('replace', () => {
    it('keeps unknown fields and unreadable rows while clearing known fields', async () => {
      setUp({
        version: 1,
        futureTopLevel: true,
        worktrees: [
          row('a', { label: 'A', futureRowField: 1 }),
          { id: 'partial' },
          row('gone', { futureRowField: 2 }),
        ],
      });

      const contents = await repository.replace(
        'w',
        [row('a')],
        await repository.read('w'),
      );

      expect(onDisk()).toEqual({
        version: 1,
        worktrees: [row('a', { futureRowField: 1 }), { id: 'partial' }],
        futureTopLevel: true,
      });
      expect(contents).toBe(memory.files.get(listPath('w')));
    });

    it('drops an unreadable row once a row with its id is written', async () => {
      setUp({ version: 1, worktrees: [{ id: 'a', branchName: 7 }] });

      await repository.replace('w', [row('a')], await repository.read('w'));

      expect(onDisk()).toEqual({ version: 1, worktrees: [row('a')] });
    });

    it('writes the rows as they are for a new list', async () => {
      setUp();

      await repository.replace('w', [row('a')], await repository.read('w'));

      expect(memory.files.get(listPath('w'))).toBe(
        JSON.stringify({ version: 1, worktrees: [row('a')] }, null, 2),
      );
    });

    it('refuses to replace a list that could not be read', async () => {
      setUp('{"version":1,"worktrees":[');

      await expect(
        repository.replace('w', [row('a')], await repository.read('w')),
      ).rejects.toBeInstanceOf(WorktreeRegistryUnreadableError);

      expect(memory.files.get(listPath('w'))).toBe(
        '{"version":1,"worktrees":[',
      );
      expect(memory.writes).toEqual([]);
    });

    it('keeps the committed list when the write fails', async () => {
      const committed = JSON.stringify({ version: 1, worktrees: [row('a')] });
      setUp(committed);
      memory.failingWrites.add(listPath('w'));

      await expect(
        repository.replace('w', [], await repository.read('w')),
      ).rejects.toThrow('ENOSPC');

      expect(memory.files.get(listPath('w'))).toBe(committed);
    });
  });
});
