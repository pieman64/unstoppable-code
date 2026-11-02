import type { CanopyClientLeaseState } from '@canopy/core-client';
import {
  createEventsCore,
  type EventsClient,
  type EventsCore,
} from '../../../../../../packages/core-client/src/__tests__/fixtures/events-core';
import {
  createWorkspaceCommitEventBinding,
  WORKSPACE_COMMIT_EVENTS_RECHECK_MS,
  WorkspaceCommitHandlersError,
  type WorkspaceCommitEventBinding,
  type WorkspaceCommitEventHandlers,
  type WorkspaceCommitEventSession,
  type WorktreeListRead,
} from '../workspace-commit-events';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function handlers(lists: Map<string, WorktreeListRead>): {
  handlers: WorkspaceCommitEventHandlers;
  calls: string[];
} {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push(
        [name, ...args.map((arg) => JSON.stringify(arg))].join(' '),
      );
  return {
    calls,
    handlers: {
      schedulePortalStructuralSync: record('structuralSync'),
      notifyPortalStructureChanged: record('structureChanged'),
      refreshWorkspaceRegistries: () => {
        record('registries')();
        return Promise.resolve();
      },
      reconcileManifestPluginDefaults: (id) => {
        record('pluginDefaults')(id);
        return Promise.resolve();
      },
      listWorkspaceIds: () => ['a', 'b'],
      readWorktreeList: (id) => {
        record('readList')(id);
        return Promise.resolve(
          lists.get(id) ?? { authority: 'absent', worktrees: [] },
        );
      },
      publishWorktreeListWrite: record('listWrite'),
      publishWorktreeMembershipChange: record('membership'),
    },
  };
}

const plan = {
  broad: false,
  index: false,
  workspaces: [],
  manifests: [],
  worktreeLists: [],
} as const;

describe('the Electron workspace commit event binding', () => {
  let binding: WorkspaceCommitEventBinding;
  afterEach(() => binding.close());

  it('maps each commit kind onto main’s existing handlers', async () => {
    const lists = new Map<string, WorktreeListRead>([
      ['a', { authority: 'ok', worktrees: [{ id: 'wt-1' }] }],
    ]);
    const { handlers: bound, calls } = handlers(lists);
    binding = createWorkspaceCommitEventBinding({
      handlers: bound,
      isOwnOrigin: () => false,
    });
    await binding.apply({ ...plan, index: true });
    expect(calls.splice(0)).toEqual([
      'structuralSync',
      'registries',
      'structureChanged',
    ]);
    await binding.apply({ ...plan, workspaces: ['a'] });
    expect(calls.splice(0)).toEqual(['structureChanged']);
    // A foreign manifest commit runs the refresh Electron's manifest writers run.
    await binding.apply({ ...plan, manifests: ['a', 'b'] });
    expect(calls.splice(0)).toEqual([
      'structuralSync',
      'registries',
      'pluginDefaults "a"',
      'pluginDefaults "b"',
      'structureChanged',
    ]);
    // A mixed commit still re-reads the registries and pushes structure once.
    await binding.apply({
      ...plan,
      index: true,
      workspaces: ['c'],
      manifests: ['a'],
      worktreeLists: ['b'],
    });
    expect(calls.splice(0)).toEqual([
      'structuralSync',
      'registries',
      'pluginDefaults "a"',
      'readList "b"',
      'membership',
      'structureChanged',
    ]);
    // First read of a list: no remembered membership, so it publishes.
    await binding.apply({ ...plan, worktreeLists: ['a'] });
    expect(calls.splice(0)).toEqual([
      'structuralSync',
      'readList "a"',
      'membership',
    ]);
    lists.set('a', {
      authority: 'ok',
      worktrees: [{ id: 'wt-1' }, { id: 'wt-2', setupPhase: 'git-pending' }],
    });
    await binding.apply({ ...plan, worktreeLists: ['a'] });
    expect(calls.splice(0)).toEqual([
      'structuralSync',
      'readList "a"',
      'listWrite [{"id":"wt-1"}] [{"id":"wt-1"},{"id":"wt-2","setupPhase":"git-pending"}]',
    ]);
    lists.set('a', { authority: 'partial', worktrees: [{ id: 'wt-1' }] });
    await binding.apply({ ...plan, worktreeLists: ['a'] });
    expect(calls.splice(0)).toEqual([
      'structuralSync',
      'readList "a"',
      'membership',
    ]);
  });

  it('invalidates broadly and forgets remembered lists', async () => {
    const lists = new Map<string, WorktreeListRead>([
      ['a', { authority: 'ok', worktrees: [{ id: 'wt-1' }] }],
    ]);
    const { handlers: bound, calls } = handlers(lists);
    binding = createWorkspaceCommitEventBinding({
      handlers: bound,
      isOwnOrigin: () => false,
    });
    await binding.apply({ ...plan, worktreeLists: ['a'] });
    calls.length = 0;
    await binding.apply({ ...plan, broad: true, index: true });
    expect(calls.splice(0)).toEqual([
      'pluginDefaults "a"',
      'pluginDefaults "b"',
      'registries',
      'structuralSync',
      'structureChanged',
      'membership',
    ]);
    await binding.apply({ ...plan, worktreeLists: ['a'] });
    expect(calls).toContain('membership');
  });

  it('keeps running the remaining handlers when one fails, then rejects', async () => {
    const { handlers: bound, calls } = handlers(new Map());
    binding = createWorkspaceCommitEventBinding({
      handlers: {
        ...bound,
        refreshWorkspaceRegistries: () => Promise.reject(new Error('down')),
        readWorktreeList: () => Promise.reject(new Error('unreadable')),
      },
      isOwnOrigin: () => false,
    });
    await expect(binding.apply({ ...plan, index: true })).rejects.toThrow(
      'down',
    );
    expect(calls.splice(0)).toEqual(['structuralSync', 'structureChanged']);
    // Every failure is reported, not only the first.
    const failure = await binding
      .apply({ ...plan, manifests: ['a'], worktreeLists: ['b'] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceCommitHandlersError);
    expect(
      failure instanceof WorkspaceCommitHandlersError &&
        failure.errors.map((error: unknown) =>
          error instanceof Error ? error.message : error,
        ),
    ).toEqual(['down', 'unreadable']);
    expect(calls).toEqual([
      'structuralSync',
      'pluginDefaults "a"',
      'structureChanged',
    ]);
  });

  describe('over a subscription', () => {
    let core: EventsCore;
    afterEach(() => core.close());

    it('skips its own commits and handles each other commit once', async () => {
      core = createEventsCore();
      const { handlers: bound, calls } = handlers(new Map());
      binding = createWorkspaceCommitEventBinding({
        handlers: bound,
        isOwnOrigin: (id) => id === 'renderer-1',
      });
      const client = await core.connect();
      const opened: string[] = [];
      await binding.attach({
        identity: client.identity,
        manifest: client.manifest,
        signal: client.signal,
        instruction: (...args) => client.instruction(...args),
        openStream: (name, ...rest) => {
          opened.push(name);
          return client.openStream(name, ...rest);
        },
      });
      await flush();
      expect(opened).toEqual(['core.events.subscribe']);
      expect(core.acknowledgements).toEqual([]);
      calls.length = 0;
      const commit = (publishedBy: string): Promise<unknown> =>
        core.append(
          'core.workspace.committed',
          {
            commit: `w5:${publishedBy}`,
            changes: [{ kind: 'workspace', workspaceId: 'a', revision: 1 }],
            files: [{ kind: 'index' }],
            publishedBy,
          },
          { workspaceId: 'a' },
        );
      await commit('renderer-1');
      await commit('cli-1');
      await flush();
      expect(calls).toEqual([
        'structuralSync',
        'registries',
        'structureChanged',
      ]);
      // Both events, its own included, are settled through core.events.ack.
      expect(core.acknowledgements).toHaveLength(2);
    });

    it('acknowledges a commit only after a failed refresh applies on retry', async () => {
      core = createEventsCore();
      const { handlers: bound, calls } = handlers(new Map());
      let down = false;
      binding = createWorkspaceCommitEventBinding({
        handlers: {
          ...bound,
          refreshWorkspaceRegistries: () => {
            if (down) return Promise.reject(new Error('down'));
            return bound.refreshWorkspaceRegistries();
          },
        },
        isOwnOrigin: () => false,
      });
      await binding.attach(await core.connect());
      await flush();
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      try {
        down = true;
        await core.append('core.workspace.committed', {
          commit: 'w5:cli',
          changes: [{ kind: 'index', revision: 1 }],
          publishedBy: 'cli-1',
        });
        await flush();
        // Neither the commit's refresh nor the broad re-read applied.
        expect(core.acknowledgements).toEqual([]);
        down = false;
        calls.length = 0;
        await jest.advanceTimersByTimeAsync(250);
        await flush();
        // The retried broad re-read covers the commit.
        expect(calls.filter((call) => call === 'registries')).toEqual([
          'registries',
        ]);
        expect(calls).toContain('membership');
        expect(core.acknowledgements).toHaveLength(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('observing daemon sessions', () => {
    let core: EventsCore;
    afterEach(async () => {
      jest.useRealTimers();
      await core.close();
    });

    /** A session whose lease can drop and adopt a replacement connection. */
    function session(client: EventsClient): {
      session: WorkspaceCommitEventSession;
      adopt(next: EventsClient | null): void;
      end(): void;
    } {
      let current: EventsClient | null = client;
      let state: CanopyClientLeaseState = 'active';
      return {
        session: {
          get client(): EventsClient {
            if (!current) throw new Error('Session closed.');
            return current;
          },
          lease: {
            get state(): CanopyClientLeaseState {
              return state;
            },
          },
        },
        adopt(next): void {
          if (next) current = next;
          state = next ? 'active' : 'reconnecting';
        },
        end(): void {
          current = null;
          state = 'released';
        },
      };
    }
    const listCommit = (workspaceId: string): Promise<unknown> =>
      core.append(
        'core.workspace.committed',
        {
          commit: `w5:${workspaceId}`,
          changes: [{ kind: 'worktreeList', workspaceId, revision: 1 }],
        },
        { workspaceId },
      );
    const listReads = (calls: readonly string[]): string[] =>
      calls.filter((call) => call.startsWith('readList'));

    it('stays on one live connection while other sessions are read', async () => {
      core = createEventsCore();
      const { handlers: bound } = handlers(new Map());
      binding = createWorkspaceCommitEventBinding({
        handlers: bound,
        isOwnOrigin: () => false,
      });
      const first = session(await core.connect());
      const second = session(await core.connect());
      binding.observe(first.session);
      await flush();
      for (const next of [second, first, second]) {
        binding.observe(next.session);
        await flush();
      }
      expect(core.subscriptions).toHaveLength(1);
    });

    it('re-attaches within the recheck bound once a dropped lease reconnects', async () => {
      core = createEventsCore();
      const { handlers: bound, calls } = handlers(new Map());
      binding = createWorkspaceCommitEventBinding({
        handlers: bound,
        isOwnOrigin: () => false,
      });
      const dropped = await core.connect();
      const observed = session(dropped);
      binding.observe(observed.session);
      await flush();
      await listCommit('a');
      await flush();
      expect(listReads(calls)).toEqual(['readList "a"']);
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      observed.adopt(null);
      await dropped.close();
      await flush();
      // Committed while no connection is live: delivered once, after reconnect.
      await listCommit('b');
      observed.adopt(await core.connect());
      calls.length = 0;
      await jest.advanceTimersByTimeAsync(
        WORKSPACE_COMMIT_EVENTS_RECHECK_MS - 1,
      );
      await flush();
      expect(core.subscriptions).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      await flush();
      expect(core.subscriptions).toHaveLength(2);
      expect(listReads(calls)).toEqual(['readList "b"']);
      await jest.advanceTimersByTimeAsync(
        WORKSPACE_COMMIT_EVENTS_RECHECK_MS * 4,
      );
      await flush();
      expect(core.subscriptions).toHaveLength(2);
    });

    it('moves to another live session when its own ends, and stops rechecking once none remains', async () => {
      core = createEventsCore();
      const { handlers: bound, calls } = handlers(new Map());
      binding = createWorkspaceCommitEventBinding({
        handlers: bound,
        isOwnOrigin: () => false,
      });
      const firstClient = await core.connect();
      const first = session(firstClient);
      const second = session(await core.connect());
      binding.observe(first.session);
      binding.observe(second.session);
      await flush();
      first.end();
      await firstClient.close();
      await flush();
      expect(core.subscriptions).toHaveLength(2);
      calls.length = 0;
      await listCommit('a');
      await flush();
      expect(listReads(calls)).toEqual(['readList "a"']);
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      second.end();
      await core.close();
      await flush();
      await jest.advanceTimersByTimeAsync(WORKSPACE_COMMIT_EVENTS_RECHECK_MS);
      expect(jest.getTimerCount()).toBe(0);
      core = createEventsCore();
    });
  });
});
