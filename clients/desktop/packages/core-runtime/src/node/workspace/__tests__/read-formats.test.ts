import {
  readWorkspaceIndex,
  readWorkspaceManifest,
  readWorktreeList,
  type WorkspaceFileRead,
} from '../read-formats';

function present(document: unknown): WorkspaceFileRead {
  return { state: 'present', raw: JSON.stringify(document) };
}

function sections(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter(
    (item): item is string => item === 'todo' || item === 'summary',
  );
  return filtered.length ? filtered : undefined;
}

const row = { id: 'z', name: 'Z', type: 'cowork', color: '#fff' };

describe('portable workspace read formats', () => {
  it.each<WorkspaceFileRead>([{ state: 'absent' }, { state: 'unreadable' }])(
    'preserves $state read state',
    (input) => {
      expect(readWorkspaceIndex(input, sections)).toEqual({
        authority: input.state,
        entries: [],
        raw: null,
        document: undefined,
        rawEntriesById: new Map(),
        unreadableEntries: [],
      });
      expect(readWorkspaceManifest(input)).toEqual({ authority: input.state });
      expect(readWorktreeList(input)).toEqual({ authority: input.state });
    },
  );

  it.each(['{', 'null', '[]', '1', '"text"', '{"version":2}', '{}'])(
    'rejects invalid JSON/envelope %s',
    (raw) => {
      const input: WorkspaceFileRead = { state: 'present', raw };
      expect(readWorkspaceIndex(input, sections).authority).toBe('unreadable');
      expect(readWorkspaceManifest(input).authority).toBe('unreadable');
      expect(readWorktreeList(input).authority).toBe('unreadable');
    },
  );

  it.each(['single-repo', 'multi-repo', 'cowork'])(
    'normalizes index %s without sorting or deduplicating',
    (type) => {
      const first = {
        ...row,
        type,
        future: { keep: true },
        pinned: true,
        activitySectionOrder: ['todo', 7, 'future', 'summary', 'todo'],
      };
      const duplicate = {
        ...row,
        type,
        name: 'Second',
        collapsed: 'yes',
        order: '3',
        pinned: 1,
        activitySectionOrder: [],
      };
      const other = { ...row, id: 'a', type, collapsed: true, order: -2 };
      const document = {
        version: 1,
        futureTop: 3,
        workspaces: [first, other, duplicate],
      };
      const input = present(document);
      const read = readWorkspaceIndex(input, sections);
      expect(read).toEqual({
        authority: 'ok',
        raw: JSON.stringify(document),
        document,
        entries: [
          {
            id: 'z',
            name: 'Z',
            type,
            color: '#fff',
            collapsed: false,
            order: 0,
            pinned: true,
            activitySectionOrder: ['todo', 'summary', 'todo'],
          },
          {
            id: 'a',
            name: 'Z',
            type,
            color: '#fff',
            collapsed: true,
            order: -2,
            activitySectionOrder: undefined,
          },
          {
            id: 'z',
            name: 'Second',
            type,
            color: '#fff',
            collapsed: false,
            order: 0,
            activitySectionOrder: undefined,
          },
        ],
        rawEntriesById: new Map([
          ['z', first],
          ['a', other],
        ]),
        unreadableEntries: [],
      });
    },
  );

  it.each([
    { ...row, type: 'future' },
    { ...row, id: 1 },
    { ...row, name: null },
    { ...row, color: false },
    {},
  ])('keeps unknown index objects as partial: %j', (unknownRow) => {
    const document = { version: 1, workspaces: [unknownRow, row] };
    const read = readWorkspaceIndex(present(document), sections);
    expect(read.authority).toBe('partial');
    expect(read.unreadableEntries).toEqual([unknownRow]);
    expect(read.entries).toEqual([
      { ...row, collapsed: false, order: 0, activitySectionOrder: undefined },
    ]);
    expect(read.document).toEqual(document);
  });

  it.each([null, [], 'future', 1, true])(
    'rejects entire index for non-object row %j',
    (invalid) => {
      const read = readWorkspaceIndex(
        present({ version: 1, workspaces: [row, invalid] }),
        sections,
      );
      expect(read).toEqual({
        authority: 'unreadable',
        entries: [],
        raw: null,
        document: undefined,
        rawEntriesById: new Map(),
        unreadableEntries: [],
      });
    },
  );

  it.each([undefined, null, {}, 'rows'])(
    'rejects invalid list member %j',
    (value) => {
      expect(
        readWorkspaceIndex(present({ version: 1, workspaces: value }), sections)
          .authority,
      ).toBe('unreadable');
      expect(
        readWorktreeList(present({ version: 1, worktrees: value })).authority,
      ).toBe('unreadable');
    },
  );

  it.each(['single-repo', 'multi-repo', 'cowork', 'future'])(
    'leaves supported manifests uninterpreted (%s)',
    (type) => {
      const document = {
        version: 1,
        type,
        repos: [null, { future: true }],
        futureTop: { keep: [1] },
      };
      expect(readWorkspaceManifest(present(document))).toEqual({
        authority: 'ok',
        document,
      });
      expect(readWorkspaceManifest(present({ version: 1 }))).toEqual({
        authority: 'ok',
        document: { version: 1 },
      });
    },
  );

  it('retains all accepted row fields, duplicates and order with partial diagnostics', () => {
    const first = {
      id: 'z',
      branchName: '',
      createdAt: 'not-a-date',
      label: 7,
      future: { keep: true },
    };
    const second = {
      id: 'a',
      branchName: 'main',
      createdAt: '',
      pinned: 'yes',
    };
    const document = {
      version: 1,
      futureTop: true,
      worktrees: [
        first,
        { id: 'missing' },
        null,
        { id: 'bad-branch', branchName: 1, createdAt: '' },
        { id: 'bad-date', branchName: '', createdAt: false },
        { id: 9 },
        [],
        second,
        first,
      ],
    };
    expect(readWorktreeList(present(document))).toEqual({
      authority: 'ok',
      worktrees: [first, second, first],
      complete: false,
      unreadableRowIds: ['missing', 'bad-branch', 'bad-date'],
      document,
    });
  });

  it('reports empty and fully readable lists as complete', () => {
    for (const worktrees of [[], [{ id: '', branchName: '', createdAt: '' }]]) {
      const document = { version: 1, worktrees };
      expect(readWorktreeList(present(document))).toEqual({
        authority: 'ok',
        worktrees,
        complete: true,
        unreadableRowIds: [],
        document,
      });
    }
    expect(
      readWorkspaceIndex(present({ version: 1, workspaces: [] }), sections)
        .authority,
    ).toBe('ok');
  });
});
