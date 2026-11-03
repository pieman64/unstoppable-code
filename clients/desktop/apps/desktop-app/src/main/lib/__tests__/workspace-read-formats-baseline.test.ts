import { createWorkspaceIndexRepository } from '../workspace-index-repository';
import { createWorkspaceManifestRepository } from '../workspace-manifest-repository';
import { createWorktreeListRepository } from '../worktree-list-repository';
import { createMemoryFileStore } from './w5-memory-file-store';

// Independent expected values, established against the CAN-3800/3803 readers.
describe('CAN-4201 desktop read format baseline', () => {
  it('preserves index order, duplicates, defaults and first-raw unknown fields', async () => {
    const document = {
      version: 1,
      future: { keep: true },
      workspaces: [
        {
          id: 'z',
          name: 'Z',
          type: 'single-repo',
          color: '',
          pinned: true,
          activitySectionOrder: ['todo', 'future', 1, 'todo'],
          futureRow: 'first',
        },
        {
          id: 'a',
          name: 'A',
          type: 'multi-repo',
          color: '#fff',
          order: -2,
          collapsed: true,
          pinned: 'true',
          activitySectionOrder: [],
        },
        {
          id: 'z',
          name: 'Again',
          type: 'cowork',
          color: 'red',
          order: 4,
          collapsed: 'true',
          futureRow: 'second',
        },
        { id: 'future', type: 'notebook', opaque: [1] },
      ],
    };
    const memory = createMemoryFileStore({ index: JSON.stringify(document) });
    const repo = createWorkspaceIndexRepository({
      store: memory.store,
      filePath: () => 'index',
      storage: { namespace: 'workspace_index', writer: 'electron_main' },
      onCommitted: () => {},
      onRefused: () => {},
    });
    expect(await repo.read()).toEqual({
      authority: 'partial',
      entries: [
        {
          id: 'z',
          name: 'Z',
          type: 'single-repo',
          color: '',
          collapsed: false,
          order: 0,
          pinned: true,
          activitySectionOrder: ['todo', 'todo'],
        },
        {
          id: 'a',
          name: 'A',
          type: 'multi-repo',
          color: '#fff',
          collapsed: true,
          order: -2,
          activitySectionOrder: undefined,
        },
        {
          id: 'z',
          name: 'Again',
          type: 'cowork',
          color: 'red',
          collapsed: false,
          order: 4,
          activitySectionOrder: undefined,
        },
      ],
      unreadableRowIds: ['future'],
    });
    await repo.update(({ entries }) => ({ result: undefined, entries }));
    expect(JSON.parse(memory.files.get('index') ?? '')).toEqual({
      version: 1,
      future: { keep: true },
      workspaces: [
        {
          id: 'z',
          name: 'Z',
          type: 'single-repo',
          color: '',
          collapsed: false,
          order: 0,
          pinned: true,
          activitySectionOrder: ['todo', 'todo'],
          futureRow: 'first',
        },
        {
          id: 'a',
          name: 'A',
          type: 'multi-repo',
          color: '#fff',
          collapsed: true,
          order: -2,
        },
        {
          id: 'z',
          name: 'Again',
          type: 'cowork',
          color: 'red',
          collapsed: false,
          order: 4,
          futureRow: 'first',
        },
        { id: 'future', type: 'notebook', opaque: [1] },
      ],
    });
    expect(memory.files.has('index.bak')).toBe(false);
  });

  it.each(['single-repo', 'multi-repo', 'cowork', 'future'])(
    'keeps manifest %s fields uninterpreted',
    async (type) => {
      const document = {
        version: 1,
        type,
        repos: [null, { opaque: true }],
        unknown: { a: 1 },
      };
      const memory = createMemoryFileStore({
        manifest: JSON.stringify(document),
      });
      const repo = createWorkspaceManifestRepository({
        store: memory.store,
        filePath: () => 'manifest',
        storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
        knownFields: new Set(),
        knownRepoFields: new Set(),
      });
      expect(await repo.read('w')).toEqual({
        authority: 'ok',
        document,
        raw: JSON.stringify(document),
      });
    },
  );

  it('keeps every accepted worktree field and duplicate in file order, with partial diagnostics', async () => {
    const first = {
      id: 'z',
      branchName: '',
      createdAt: 'not-a-date',
      label: 5,
      unknown: { keep: true },
    };
    const second = {
      id: 'a',
      branchName: 'main',
      createdAt: '',
      pinned: 'yes',
    };
    const document = {
      version: 1,
      future: true,
      worktrees: [first, { id: 'lost' }, null, second, first],
    };
    const memory = createMemoryFileStore({ list: JSON.stringify(document) });
    const repo = createWorktreeListRepository({
      store: memory.store,
      filePath: () => 'list',
      storage: { namespace: 'worktree_list', writer: 'electron_main' },
      knownRowFields: new Set(),
    });
    expect(await repo.read('w')).toEqual({
      authority: 'ok',
      worktrees: [first, second, first].map((row) => ({
        ...row,
        replica: { state: 'never-recorded' },
      })),
      complete: false,
      unreadableRowIds: ['lost'],
      document,
      raw: JSON.stringify(document),
    });
  });
});
