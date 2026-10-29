import {
  DiscoveryCursorStore,
  CURSOR_TTL_MS,
} from '../project-discovery/cursor-store';

const binding = 'account:1:caller:personal:projects.list';
const rows = [
  { id: 'b', sortKey: 'same', incarnation: 'born-b' },
  { id: 'a', sortKey: 'same', incarnation: 'born-a' },
  { id: 'c', sortKey: 'z', incarnation: 'born-c' },
];

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
    )
      return error.code;
    throw error;
  }
  return undefined;
}

describe('discovery cursor snapshot store', () => {
  test('sorts before paging with canonical-ID tie break, and preserves total/revision', () => {
    const store = new DiscoveryCursorStore();
    const first = store.page(rows, { binding, pageSize: 1, order: 'asc' });
    expect(first.items.map((item) => item.id)).toEqual(['a']);
    expect(first.totalMatches).toBe(3);
    expect(first.nextCursor).toMatch(/^[a-f0-9]{64}$/);
    const next = store.page(rows, {
      binding,
      pageSize: 2,
      order: 'asc',
      cursor: first.nextCursor ?? undefined,
    });
    expect(next.items.map((item) => item.id)).toEqual(['b', 'c']);
    expect(next.nextCursor).toBeNull();
    expect(next.revision).toBe(first.revision);
  });
  test('descending primary order still uses ascending canonical-ID tie-break', () => {
    expect(
      new DiscoveryCursorStore()
        .page(rows, { binding, pageSize: 3, order: 'desc' })
        .items.map((item) => item.id),
    ).toEqual(['c', 'a', 'b']);
  });
  test('runtime-filter matches freeze across pages while fresh rows are sampled and authorized', () => {
    const store = new DiscoveryCursorStore();
    const matched = rows.filter((row) => row.id !== 'c');
    const first = store.page(matched, {
      binding,
      pageSize: 1,
      order: 'asc',
      freezeMatches: true,
    });
    const allFresh = rows.map((row) => ({
      ...row,
      runtimeState: 'idle',
      sortKey: 'changed-live-activity',
    }));
    const next = store.page(allFresh, {
      binding,
      pageSize: 1,
      order: 'asc',
      freezeMatches: true,
      cursor: first.nextCursor ?? undefined,
    });
    expect(next.items.map((row) => [row.id, row.runtimeState])).toEqual([
      ['b', 'idle'],
    ]);
    expect(next.totalMatches).toBe(2);
    expect(next.revision).toBe(first.revision);
    const removed = allFresh.filter((row) => row.id !== 'b');
    expect(
      errorCode(() =>
        store.page(removed, {
          binding,
          pageSize: 1,
          order: 'asc',
          freezeMatches: true,
          cursor: first.nextCursor ?? undefined,
        }),
      ),
    ).toBe('cursor_context_changed');
  });
  test('unknown, malformed and expired handles fail closed', () => {
    let now = 0;
    const store = new DiscoveryCursorStore(() => now);
    const first = store.page(rows, { binding, pageSize: 1, order: 'asc' });
    for (const cursor of ['bad', 'a'.repeat(64)])
      expect(
        errorCode(() =>
          store.page(rows, { binding, pageSize: 1, order: 'asc', cursor }),
        ),
      ).toBe('cursor_expired');
    now = CURSOR_TTL_MS;
    expect(
      errorCode(() =>
        store.page(rows, {
          binding,
          pageSize: 1,
          order: 'asc',
          cursor: first.nextCursor ?? undefined,
        }),
      ),
    ).toBe('cursor_expired');
  });
  test.each(['epoch', 'caller', 'owner', 'operation', 'filters', 'sort'])(
    'rejects changed %s binding',
    (changed) => {
      const store = new DiscoveryCursorStore();
      const first = store.page(rows, { binding, pageSize: 1, order: 'asc' });
      expect(
        errorCode(() =>
          store.page(rows, {
            binding: `${binding}:${changed}`,
            pageSize: 1,
            order: 'asc',
            cursor: first.nextCursor ?? undefined,
          }),
        ),
      ).toBe('cursor_context_changed');
    },
  );
  test('continuations are replay-safe and do not extend original snapshot TTL', () => {
    let now = 0;
    const store = new DiscoveryCursorStore(() => now);
    const first = store.page(rows, { binding, pageSize: 1, order: 'asc' });
    now = CURSOR_TTL_MS - 1;
    const options = {
      binding,
      pageSize: 1,
      order: 'asc' as const,
      cursor: first.nextCursor ?? undefined,
    };
    const next = store.page(rows, options);
    expect(store.page(rows, options).items).toEqual(next.items);
    now++;
    expect(
      errorCode(() =>
        store.page(rows, { ...options, cursor: next.nextCursor ?? undefined }),
      ),
    ).toBe('cursor_expired');
  });
  test('rejects removed, transferred or recreated items without silent skipping', () => {
    for (const changed of [
      rows.slice(1),
      rows.map((row) => ({ ...row, incarnation: 'new' })),
      rows.map((row) => ({ ...row, sortKey: 'new' })),
    ]) {
      const store = new DiscoveryCursorStore();
      const first = store.page(rows, { binding, pageSize: 1, order: 'asc' });
      expect(
        errorCode(() =>
          store.page(changed, {
            binding,
            pageSize: 1,
            order: 'asc',
            cursor: first.nextCursor ?? undefined,
          }),
        ),
      ).toBe('cursor_context_changed');
    }
  });
  test('retains only 128 LRU handles and continuation refreshes recency, not TTL', () => {
    const store = new DiscoveryCursorStore();
    const handles = Array.from(
      { length: 128 },
      () =>
        store.page(rows, { binding, pageSize: 1, order: 'asc' }).nextCursor ??
        '',
    );
    store.page(rows, {
      binding,
      pageSize: 1,
      order: 'asc',
      cursor: handles[0],
    });
    store.page(rows, { binding, pageSize: 1, order: 'asc' });
    expect(
      errorCode(() =>
        store.page(rows, {
          binding,
          pageSize: 1,
          order: 'asc',
          cursor: handles[1],
        }),
      ),
    ).toBe('cursor_expired');
    expect(
      errorCode(() =>
        store.page(rows, {
          binding,
          pageSize: 1,
          order: 'asc',
          cursor: handles[0],
        }),
      ),
    ).toBeUndefined();
  });
  test('serves the first page with honest totals, but refuses continuation past 5,000 stored IDs', () => {
    const store = new DiscoveryCursorStore();
    const many = Array.from({ length: 5001 }, (_, i) => ({
      id: `${i}`,
      sortKey: `${i}`,
      incarnation: '1',
    }));
    let page = store.page(many, { binding, pageSize: 200, order: 'asc' });
    expect(page.items).toHaveLength(200);
    expect(page.totalMatches).toBe(5001);
    for (let i = 1; i < 25; i++)
      page = store.page(many, {
        binding,
        pageSize: 200,
        order: 'asc',
        cursor: page.nextCursor ?? undefined,
      });
    expect(page.items).toHaveLength(200);
    expect(
      errorCode(() =>
        store.page(many, {
          binding,
          pageSize: 200,
          order: 'asc',
          cursor: page.nextCursor ?? undefined,
        }),
      ),
    ).toBe('cursor_expired');
    expect(
      store.page(many.slice(0, 5000), { binding, pageSize: 200, order: 'asc' })
        .totalMatches,
    ).toBe(5000);
  });
});

import {
  parseProjectDiscoveryAction,
  type ProjectDiscoveryAction,
  type ProjectTaskRow,
} from '@canopy/desktop-shared/lib/project-discovery';
import {
  cursorBinding,
  pageRows,
  toDiscoveryJson,
} from '../project-discovery/paging';

function action(value: unknown): ProjectDiscoveryAction {
  const parsed = parseProjectDiscoveryAction(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.action;
}

describe('discovery cursor authorization binding and serializer', () => {
  const caller = {
    kind: 'project_agent',
    projectId: 'project',
    worktreeId: 'task',
    chatId: 'chat',
  } as const;
  const owner = { kind: 'personal' } as const;
  test('account epoch, caller identity, owner and filters are actual binding inputs', () => {
    const query = action({ type: 'projects.list', types: ['code', 'cowork'] });
    const initial = cursorBinding(query, caller, owner, 1);
    expect(cursorBinding(query, caller, owner, 2)).not.toBe(initial);
    expect(
      cursorBinding(query, { ...caller, chatId: 'other' }, owner, 1),
    ).not.toBe(initial);
    expect(
      cursorBinding(
        query,
        caller,
        { kind: 'organization', organizationId: 'org' },
        1,
      ),
    ).not.toBe(initial);
    expect(
      cursorBinding(
        action({ type: 'projects.list', types: ['code'] }),
        caller,
        owner,
        1,
      ),
    ).not.toBe(initial);
    expect(
      cursorBinding(
        action({
          type: 'projects.list',
          types: ['cowork', 'code'],
          pageSize: 200,
          cursor: 'opaque',
        }),
        caller,
        owner,
        1,
      ),
    ).toBe(initial);
  });
  test('sampled runtime data refreshes while metadata incarnation and ordering remain bound', () => {
    const query = action({
      type: 'projects.list_task_chats',
      projectId: 'p',
      pageSize: 1,
      sort: 'title',
      order: 'asc',
    });
    const candidates = rows.map((row) => ({ ...row, runtimeState: 'unknown' }));
    const first = pageRows(
      candidates,
      query,
      binding,
      (row) => ({ id: row.id, incarnation: row.incarnation }),
      (row) => row.sortKey,
    );
    const continuation = { ...query, cursor: first.nextCursor ?? undefined };
    const next = pageRows(
      candidates.map((row) => ({ ...row, runtimeState: 'running' })),
      continuation,
      binding,
      (row) => ({ id: row.id, incarnation: row.incarnation }),
      (row) => row.sortKey,
    );
    expect(next.items[0]?.runtimeState).toBe('running');
  });
  test('JSON-safe conversion omits optional undefined fields without casts', () => {
    expect(
      toDiscoveryJson({
        items: [{ projectId: 'p', optional: undefined }],
        count: null,
      }),
    ).toEqual({ items: [{ projectId: 'p' }], count: null });
  });
});

jest.mock('../project-discovery/owner-policy', () => ({
  getCallerOwner: jest.fn(),
  requireAuthorizedProject: jest.fn(),
}));
jest.mock('../project-discovery/projects-list', () => ({
  listProjectCandidates: jest.fn(),
  hydrateProjectRow: jest.fn(),
}));
jest.mock('../project-discovery/tasks-list', () => ({
  listTaskRows: jest.fn(),
}));
jest.mock('../project-discovery/chats-list', () => ({
  listChatRows: jest.fn(),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(),
}));

import { dispatchProjectDiscoveryAction } from '../project-discovery';
import { DiscoveryError } from '../project-discovery/errors';

const mockOwners = jest.requireMock<{
  getCallerOwner: jest.Mock;
  requireAuthorizedProject: jest.Mock;
}>('../project-discovery/owner-policy');
const mockProjects = jest.requireMock<{
  listProjectCandidates: jest.Mock;
  hydrateProjectRow: jest.Mock;
}>('../project-discovery/projects-list');
const mockTasks = jest.requireMock<{ listTaskRows: jest.Mock }>(
  '../project-discovery/tasks-list',
);
const mockChats = jest.requireMock<{ listChatRows: jest.Mock }>(
  '../project-discovery/chats-list',
);

const mockContext = jest.requireMock<{ getWorkspaceContextService: jest.Mock }>(
  '../lib/workspace-context-service',
);

describe('discovery dispatch cursor integration', () => {
  let epoch = 1;
  const caller = {
    kind: 'project_agent',
    projectId: 'origin',
    worktreeId: 'entry',
    chatId: 'chat',
  } as const;
  const query = action({ type: 'projects.list', pageSize: 1, sort: 'name' });
  beforeEach(() => {
    jest.clearAllMocks();
    epoch = 1;
    mockContext.getWorkspaceContextService.mockReturnValue({
      initialize: () => Promise.resolve(),
      whenIdle: () => Promise.resolve(),
      accountEpoch: () => epoch,
    });
    mockOwners.getCallerOwner.mockResolvedValue({ kind: 'personal' });
    mockProjects.listProjectCandidates.mockResolvedValue([
      { projectId: 'b', name: 'Same', incarnation: 'b-born' },
      { projectId: 'a', name: 'Same', incarnation: 'a-born' },
    ]);
    mockProjects.hydrateProjectRow.mockImplementation(
      (candidate: { projectId: string; name: string }) =>
        Promise.resolve({
          projectId: candidate.projectId,
          type: 'cowork',
          purpose: 'project',
          name: candidate.name,
          displayName: candidate.name,
          owner: { kind: 'personal' },
          readiness: 'ready',
          isDefault: false,
          countsAvailable: true,
          taskCount: 0,
          activeTaskCount: 0,
          doneTaskCount: 0,
          details: {
            kind: 'cowork',
            presetCount: 0,
            hasDefaultPluginSelections: false,
          },
        }),
    );
  });
  async function firstCursor(): Promise<string> {
    const first = await dispatchProjectDiscoveryAction(query, caller);
    if (
      !first.ok ||
      !first.result ||
      typeof first.result !== 'object' ||
      Array.isArray(first.result) ||
      typeof first.result.nextCursor !== 'string'
    )
      throw new Error('Expected cursor');
    return first.result.nextCursor;
  }
  test('hydrates only returned projects and provides JSON-safe full page envelope', async () => {
    const result = await dispatchProjectDiscoveryAction(query, caller);
    expect(result).toMatchObject({
      ok: true,
      result: {
        items: [{ projectId: 'a' }],
        returned: 1,
        totalMatches: 2,
      },
    });
    expect(mockProjects.hydrateProjectRow).toHaveBeenCalledTimes(1);
  });
  test('malformed unknown cursor fails before any inventory or ownership read', async () => {
    const result = await dispatchProjectDiscoveryAction(
      { ...query, cursor: 'not-a-handle' },
      caller,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cursor_expired' },
    });
    expect(mockOwners.getCallerOwner).not.toHaveBeenCalled();
    expect(mockProjects.listProjectCandidates).not.toHaveBeenCalled();
  });
  test('account epoch changes reject continuation before listing', async () => {
    const cursor = await firstCursor();
    epoch++;
    mockProjects.listProjectCandidates.mockClear();
    expect(
      await dispatchProjectDiscoveryAction({ ...query, cursor }, caller),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
    expect(mockProjects.listProjectCandidates).not.toHaveBeenCalled();
  });
  test('owner retirement and transfer reject the entire continuation', async () => {
    const cursor = await firstCursor();
    mockOwners.getCallerOwner.mockRejectedValue(
      new DiscoveryError('owner_context_unavailable', 'owner unknown'),
    );
    expect(
      await dispatchProjectDiscoveryAction({ ...query, cursor }, caller),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
    mockOwners.getCallerOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org',
    });
    expect(
      await dispatchProjectDiscoveryAction({ ...query, cursor }, caller),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });
  test('a target authorization change during hydration fails the whole page', async () => {
    mockProjects.listProjectCandidates
      .mockResolvedValueOnce([
        { projectId: 'a', name: 'Same', incarnation: 'a-born' },
        { projectId: 'b', name: 'Same', incarnation: 'b-born' },
      ])
      .mockResolvedValueOnce([
        { projectId: 'b', name: 'Same', incarnation: 'b-born' },
      ]);
    expect(await dispatchProjectDiscoveryAction(query, caller)).toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });
  });
  test('an account change while hydration is in flight fails the whole page', async () => {
    mockProjects.hydrateProjectRow.mockImplementationOnce(() => {
      epoch++;
      return Promise.resolve({ projectId: 'a' });
    });
    expect(await dispatchProjectDiscoveryAction(query, caller)).toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });
  });
  test('a queued account change during hydration is drained before the final binding check', async () => {
    let queued = false;
    mockContext.getWorkspaceContextService.mockReturnValue({
      initialize: () => Promise.resolve(),
      whenIdle: () => {
        if (queued) {
          epoch++;
          queued = false;
        }
        return Promise.resolve();
      },
      accountEpoch: () => epoch,
    });
    mockProjects.hydrateProjectRow.mockImplementationOnce(() => {
      queued = true;
      return Promise.resolve({ projectId: 'a' });
    });
    expect(await dispatchProjectDiscoveryAction(query, caller)).toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });
  });
  test('a queued account change during final owner resolution is drained before comparing the binding', async () => {
    let queued = false;
    mockContext.getWorkspaceContextService.mockReturnValue({
      initialize: () => Promise.resolve(),
      whenIdle: () => {
        if (queued) {
          epoch++;
          queued = false;
        }
        return Promise.resolve();
      },
      accountEpoch: () => epoch,
    });
    mockOwners.getCallerOwner
      .mockResolvedValueOnce({ kind: 'personal' })
      .mockImplementationOnce(() => {
        queued = true;
        return Promise.resolve({ kind: 'personal' });
      });
    expect(await dispatchProjectDiscoveryAction(query, caller)).toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });
  });
  test('strict malformed payload does not execute source reads', async () => {
    const malformed = { ...query, ui: { selected: true } };
    expect(
      await dispatchProjectDiscoveryAction(malformed, caller),
    ).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(mockProjects.listProjectCandidates).not.toHaveBeenCalled();
  });
  test.each(['work_entry', 'worktree'] as const)(
    '%s activity and sampled details outside the current page preserve task continuation order',
    async (kind) => {
      const query = action({
        type: 'projects.list_tasks',
        projectId: 'p',
        pageSize: 1,
      });
      mockOwners.requireAuthorizedProject.mockResolvedValue({
        owner: { kind: 'personal' },
        readiness: 'ready',
        incarnation: 'project-1',
      });
      const rows = ['a', 'b', 'c'].map((taskId, index): ProjectTaskRow => {
        const metadata = {
          projectId: 'p',
          taskId,
          title: taskId,
          createdAt: `born-${taskId}`,
          lastActivityAt: `2026-10-${13 - index}`,
          status: 'active' as const,
          retentionState: 'retained' as const,
          chatCount: 1,
          hasRunningChats: false,
        };
        return kind === 'work_entry'
          ? {
              ...metadata,
              kind,
              details: {
                kind,
                pinned: false,
                titleOverride: taskId,
                hasUserChanges: false,
                lastTouchedAt: `2026-10-${13 - index}`,
                lastMessageAt: `2026-10-${13 - index}`,
                providerType: 'claude',
              },
            }
          : {
              ...metadata,
              kind,
              details: {
                kind,
                branchName: taskId,
                hidden: false,
                setupPhase: 'git-ready',
                pausedHookKeys: [],
                trackedBaseBranch: null,
                trackedRepoBaseBranches: {},
                healthIssue: {
                  code: 'missing-git-metadata',
                  message: 'Sampled health',
                  checkedAt: '2026-10-01',
                },
              },
            };
      });
      mockTasks.listTaskRows.mockResolvedValue({
        items: rows,
        projectType: kind === 'worktree' ? 'code' : 'cowork',
      });
      const first = await dispatchProjectDiscoveryAction(query, caller);
      if (
        !first.ok ||
        !first.result ||
        typeof first.result !== 'object' ||
        Array.isArray(first.result) ||
        typeof first.result.nextCursor !== 'string'
      )
        throw new Error('Expected task cursor');
      expect(first).toMatchObject({ result: { items: [{ taskId: 'a' }] } });
      const touched = rows.map((row): ProjectTaskRow => {
        if (row.taskId !== 'c') return row;
        const samples = {
          lastActivityAt: '2026-10-14',
          chatCount: 2,
          hasRunningChats: true,
        };
        return row.kind === 'work_entry'
          ? {
              ...row,
              ...samples,
              details: {
                ...row.details,
                lastTouchedAt: '2026-10-14',
                lastMessageAt: '2026-10-14',
                hasUserChanges: true,
                providerType: 'codex',
              },
            }
          : {
              ...row,
              ...samples,
              details: {
                ...row.details,
                setupPhase: 'git-pending',
                pausedHookKeys: ['hook'],
                healthIssue: {
                  code: 'missing-git-metadata',
                  message: 'Fresh sample',
                  checkedAt: '2026-10-14',
                },
              },
            };
      });
      mockTasks.listTaskRows.mockResolvedValue({
        items: touched,
        projectType: kind === 'worktree' ? 'code' : 'cowork',
      });
      const next = await dispatchProjectDiscoveryAction(
        { ...query, cursor: first.result.nextCursor },
        caller,
      );
      expect(next).toMatchObject({
        ok: true,
        result: { items: [{ taskId: 'b' }], totalMatches: 3 },
      });
      if (
        !next.ok ||
        !next.result ||
        typeof next.result !== 'object' ||
        Array.isArray(next.result) ||
        typeof next.result.nextCursor !== 'string'
      )
        throw new Error('Expected second task cursor');
      const last = await dispatchProjectDiscoveryAction(
        { ...query, cursor: next.result.nextCursor },
        caller,
      );
      expect(last).toMatchObject({
        ok: true,
        result: {
          items: [
            {
              taskId: 'c',
              lastActivityAt: '2026-10-14',
              chatCount: 2,
              hasRunningChats: true,
              details: touched[2]?.details,
            },
          ],
          nextCursor: null,
        },
      });

      mockTasks.listTaskRows.mockResolvedValue({
        items: touched.map((row) =>
          row.taskId === 'c' ? { ...row, createdAt: 'recreated' } : row,
        ),
        projectType: kind === 'worktree' ? 'code' : 'cowork',
      });
      await expect(
        dispatchProjectDiscoveryAction(
          { ...query, cursor: next.result.nextCursor },
          caller,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'cursor_context_changed' },
      });
    },
  );
  test('default last-activity chat paging keeps the ordered snapshot while refreshing runtime fields', async () => {
    const query = action({
      type: 'projects.list_task_chats',
      projectId: 'p',
      pageSize: 1,
    });
    mockOwners.requireAuthorizedProject.mockResolvedValue({
      owner: { kind: 'personal' },
      readiness: 'ready',
      incarnation: 'project-1',
    });
    const rows = [
      {
        projectId: 'p',
        taskId: 'task',
        chatId: 'a',
        title: 'A',
        createdAt: 'born-a',
        lastActivityAt: '2026-10-13',
        runtimeState: 'running',
      },
      {
        projectId: 'p',
        taskId: 'task',
        chatId: 'b',
        title: 'B',
        createdAt: 'born-b',
        lastActivityAt: '2026-10-12',
        runtimeState: 'running',
      },
    ];
    mockChats.listChatRows.mockResolvedValueOnce(rows).mockResolvedValueOnce(
      rows.map((row) => ({
        ...row,
        ...(row.chatId === 'b' ? { lastActivityAt: '2026-10-14' } : {}),
        runtimeState: 'idle',
        runtimeObservedAt: '2026-10-14',
        queuedMessageCount: 2,
        session: { state: 'idle' },
      })),
    );
    const first = await dispatchProjectDiscoveryAction(query, caller);
    if (
      !first.ok ||
      !first.result ||
      typeof first.result !== 'object' ||
      Array.isArray(first.result) ||
      typeof first.result.nextCursor !== 'string'
    )
      throw new Error('Expected cursor');
    expect(
      await dispatchProjectDiscoveryAction(
        { ...query, cursor: first.result.nextCursor },
        caller,
      ),
    ).toMatchObject({
      ok: true,
      result: {
        items: [
          {
            chatId: 'b',
            runtimeState: 'idle',
            lastActivityAt: '2026-10-14',
            runtimeObservedAt: '2026-10-14',
            queuedMessageCount: 2,
            session: { state: 'idle' },
          },
        ],
        totalMatches: 2,
      },
    });
    mockChats.listChatRows.mockResolvedValue(
      rows.map((row) =>
        row.chatId === 'b' ? { ...row, createdAt: 'recreated' } : row,
      ),
    );
    await expect(
      dispatchProjectDiscoveryAction(
        { ...query, cursor: first.result.nextCursor },
        caller,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });
  });
  test('read failures never become empty successes', async () => {
    mockProjects.listProjectCandidates.mockRejectedValue(
      new DiscoveryError(
        'execution_failed',
        'Project inventory could not be read.',
      ),
    );
    expect(await dispatchProjectDiscoveryAction(query, caller)).toEqual({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Project inventory could not be read.',
      },
    });
  });
});
