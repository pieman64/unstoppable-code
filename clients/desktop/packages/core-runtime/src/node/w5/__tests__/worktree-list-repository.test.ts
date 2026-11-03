import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  W5RecordUnservedError,
  type W5FileReplacement,
  type W5FileStore,
} from '../file-store';
import type { W5StorageTarget } from '../storage-target';
import type { LocalReplicaContext } from '../worktree-replica-record';
import {
  createWorktreeListRepository,
  parseWorktreeList,
  WorktreeRegistryUnreadableError,
  type W5WorktreeListReadRow,
  type W5WorktreeListRow,
  type WorktreeListRepository,
} from '../worktree-list-repository';

const LIST = '/w5/workspaces/ws/worktrees.json';
const storage: W5StorageTarget = {
  namespace: 'worktree_list',
  writer: 'electron_main',
};

interface HostRow extends W5WorktreeListRow {
  label?: string;
  projected: true;
}

function projectRow(row: W5WorktreeListReadRow): HostRow {
  return {
    id: row.id,
    branchName: row.branchName,
    createdAt: row.createdAt,
    replica: row.replica,
    ...(typeof row.label === 'string' ? { label: row.label } : {}),
    projected: true,
  };
}

function setup(options: { unreadable?: boolean; context?: boolean } = {}): {
  files: Map<string, string>;
  replacements: W5FileReplacement[];
  contextReads: string[];
  repository: WorktreeListRepository<HostRow>;
} {
  const files = new Map<string, string>();
  const replacements: W5FileReplacement[] = [];
  const contextReads: string[] = [];
  const store: W5FileStore = {
    read: (filePath) => {
      if (options.unreadable)
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
    contextReads,
    repository: createWorktreeListRepository<HostRow>({
      store,
      filePath: () => LIST,
      storage,
      knownRowFields: new Set([
        'id',
        'branchName',
        'createdAt',
        'replica',
        'label',
        'projected',
      ]),
      readRow: projectRow,
      ...(options.context
        ? {
            localReplicaContext: (
              workspaceId: string,
            ): Promise<LocalReplicaContext> => {
              contextReads.push(workspaceId);
              return Promise.resolve({
                authorityId: 'local-desktop',
                targetId: 'in_process_worker',
                repoIds: ['child', WORKSPACE_ROOT_REPO_ID],
              });
            },
          }
        : {}),
    }),
  };
}

function row(id: string, extra: Record<string, unknown> = {}): object {
  return { id, branchName: `branch-${id}`, createdAt: '2026-10-30', ...extra };
}

it('projects every readable row through the host and reports left-out rows', async () => {
  const raw = JSON.stringify({
    version: 1,
    worktrees: [row('a', { label: 'A', extra: true }), { id: 'broken' }],
  });
  const parsed: unknown = JSON.parse(raw);
  const read = parseWorktreeList(raw, 'ws', projectRow);
  expect(read).toEqual({
    authority: 'ok',
    worktrees: [
      {
        id: 'a',
        branchName: 'branch-a',
        createdAt: '2026-10-30',
        replica: { state: 'never-recorded' },
        label: 'A',
        projected: true,
      },
    ],
    complete: false,
    unreadableRowIds: ['broken'],
    document: parsed,
    raw,
  });
  const { files, repository } = setup();
  files.set(LIST, raw);
  await expect(repository.read('ws')).resolves.toEqual(read);
});

it('keeps unknown fields and unreadable rows, mints missing replicas and advances changed rows', async () => {
  const { files, replacements, contextReads, repository } = setup({
    context: true,
  });
  const before = JSON.stringify({
    version: 1,
    future: 1,
    worktrees: [row('a', { label: 'A', extra: true }), { id: 'broken' }],
  });
  files.set(LIST, before);
  const previous = await repository.read('ws');
  if (previous.authority !== 'ok') throw new Error('Expected a readable list');
  const contents = await repository.replace(
    'ws',
    [
      ...previous.worktrees.map((worktree) => ({
        ...worktree,
        label: undefined,
      })),
      {
        id: 'b',
        branchName: 'branch-b',
        createdAt: '2026-10-30',
        projected: true,
      },
    ],
    previous,
  );
  expect(files.get(LIST)).toBe(contents);
  const written = parseWorktreeList(contents, 'ws', projectRow);
  if (written.authority !== 'ok') throw new Error('Expected a readable list');
  const document: unknown = JSON.parse(contents);
  expect(document).toMatchObject({
    version: 1,
    future: 1,
    worktrees: [
      row('a', { extra: true, projected: true }),
      {},
      { id: 'broken' },
    ],
  });
  expect(written.worktrees[0]).not.toHaveProperty('label');
  // Rows written without a recorded replica get one from a single context read.
  expect(
    written.worktrees.map((worktree) =>
      worktree.replica?.state === 'recorded'
        ? worktree.replica.repositories.map((entry) => [
            entry.worktreeId,
            entry.repoId,
          ])
        : worktree.replica,
    ),
  ).toEqual([
    [
      ['a', WORKSPACE_ROOT_REPO_ID],
      ['a', 'child'],
    ],
    [
      ['b', WORKSPACE_ROOT_REPO_ID],
      ['b', 'child'],
    ],
  ]);
  expect(contextReads).toEqual(['ws']);
  expect(replacements).toEqual([
    {
      operation: 'w5.worktree_list.write',
      advance: [
        { kind: 'worktrees', workspaceId: 'ws' },
        { kind: 'worktree', workspaceId: 'ws', worktreeId: 'a' },
        { kind: 'worktree', workspaceId: 'ws', worktreeId: 'b' },
      ],
      previousRaw: before,
    },
  ]);

  // Rewriting the rows as read changes nothing and needs no identity.
  const reread = await repository.read('ws');
  if (reread.authority !== 'ok') throw new Error('Expected a readable list');
  await expect(
    repository.replace('ws', reread.worktrees, reread),
  ).resolves.toBe(contents);
  expect(replacements).toHaveLength(1);
  expect(contextReads).toEqual(['ws']);
});

it('refuses to replace a list that could not be read', async () => {
  const { replacements, repository } = setup({ unreadable: true });
  const previous = await repository.read('ws');
  expect(previous).toEqual({
    authority: 'unreadable',
    error: new Error('EACCES'),
  });
  await expect(repository.replace('ws', [], previous)).rejects.toBeInstanceOf(
    WorktreeRegistryUnreadableError,
  );
  await expect(repository.replace('ws', [], previous)).rejects.toThrow(
    'Worktree registry is unreadable',
  );
  expect(replacements).toEqual([]);
});

it('refuses a list the record port cannot serve with that specific reason (CAN-5531)', async () => {
  const { replacements, repository } = setup();
  const unserved = new W5RecordUnservedError('limit-exceeded', 'worktrees');
  await expect(
    repository.replace('ws', [], { authority: 'unreadable', error: unserved }),
  ).rejects.toMatchObject({
    name: 'WorktreeRegistryUnreadableError',
    message: unserved.message,
    cause: unserved,
  });
  expect(replacements).toEqual([]);
});

it.each([
  { raw: 'not json', collection: true, ids: [] },
  { raw: '{"worktrees":[]}', collection: false, ids: [] },
  { raw: 'null', collection: false, ids: [] },
  { raw: '[]', collection: false, ids: [] },
  { raw: '{}', collection: false, ids: [] },
  { raw: '{"worktrees":null}', collection: false, ids: [] },
  { raw: '{"worktrees":{}}', collection: false, ids: [] },
  { raw: '{"worktrees":[null,3,"bad"]}', collection: false, ids: [] },
  { raw: '{"worktrees":[{}, {"id":3}]}', collection: true, ids: [] },
  {
    raw: '{"worktrees":[{"id":"one"},{"id":"two"},{"id":"one"}]}',
    collection: true,
    ids: ['one', 'two'],
  },
])(
  'removes a list with only the revisions its removed rows affect: $raw',
  async ({ raw, collection, ids }) => {
    const { files, replacements, repository } = setup();
    files.set(LIST, raw);
    await repository.remove('ws');
    await repository.remove('ws');
    expect(files.has(LIST)).toBe(false);
    expect(replacements).toEqual([
      {
        operation: 'w5.worktree_list.remove',
        previousRaw: raw,
        advance: [
          ...(collection ? [{ kind: 'worktrees', workspaceId: 'ws' }] : []),
          ...ids.map((worktreeId) => ({
            kind: 'worktree',
            workspaceId: 'ws',
            worktreeId,
          })),
        ],
      },
    ]);
  },
);
it('refuses removal when the list cannot be read', async () => {
  const { replacements, repository } = setup({ unreadable: true });
  await expect(repository.remove('ws')).rejects.toBeInstanceOf(
    WorktreeRegistryUnreadableError,
  );
  expect(replacements).toEqual([]);
});
