import {
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  type LoadWorktreeTerminalStateResponse,
  type SaveWorktreeTerminalStateRequest,
  type TerminalSession,
} from '@canopy/protocol/terminal';
import type * as TerminalStoreModuleImport from '../terminal-store';

type TerminalStoreModule = typeof TerminalStoreModuleImport;

import { createFakeTerminalClient } from './fake-terminal-client';
import { bindTerminalClient } from '../terminal-client-binding';

const fake = createFakeTerminalClient();
const killMock = fake.calls.commands['terminal.kill'];
const loadWorktreeStateMock = fake.calls.queries['terminal.worktreeState.get'];
const saveWorktreeStateMock =
  fake.calls.commands['terminal.worktreeState.save'];
let dispose: (() => void) | undefined;

async function loadTerminalStore(): Promise<TerminalStoreModule> {
  const mod = await import('../terminal-store');
  dispose?.();
  dispose = bindTerminalClient(fake.client);
  return mod;
}

function makeSession(
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id: overrides.id ?? 'term-1',
    projectId: overrides.projectId ?? 'proj-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    shell: overrides.shell ?? '/bin/zsh',
    shellBasename: overrides.shellBasename ?? 'zsh',
    cwd: overrides.cwd ?? '/tmp',
    createdAt: overrides.createdAt ?? 1,
  };
}

function makeLoadResponse(
  overrides: Partial<LoadWorktreeTerminalStateResponse> = {},
): LoadWorktreeTerminalStateResponse {
  return {
    drawerCollapsed:
      overrides.drawerCollapsed ?? DEFAULT_TERMINAL_DRAWER_COLLAPSED,
    groups: overrides.groups ?? [],
    activeGroupId: overrides.activeGroupId ?? null,
    nextGroupOrdinal: overrides.nextGroupOrdinal ?? 1,
    groupOrdinals: overrides.groupOrdinals ?? {},
    terminalCustomNames: overrides.terminalCustomNames ?? {},
    groupCustomNames: overrides.groupCustomNames ?? {},
    terminals: overrides.terminals ?? [],
    liveTerminalIds: overrides.liveTerminalIds ?? [],
  };
}

function getPersistRequest(): SaveWorktreeTerminalStateRequest {
  const callCount = saveWorktreeStateMock.mock.calls.length;
  const lastCall =
    callCount > 0 ? saveWorktreeStateMock.mock.calls[callCount - 1] : undefined;
  if (!lastCall) {
    throw new Error('expected saveWorktreeState to be called');
  }
  const [request] = lastCall;
  return request;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (resolvePromise === null) {
        throw new Error('deferred promise has no resolver');
      }
      resolvePromise(value);
    },
  };
}

describe('terminalStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    killMock.mockReset();
    loadWorktreeStateMock.mockReset();
    saveWorktreeStateMock.mockReset();
    killMock.mockResolvedValue(undefined);
    saveWorktreeStateMock.mockResolvedValue(undefined);
    loadWorktreeStateMock.mockResolvedValue(makeLoadResponse());
  });

  afterEach(() => {
    dispose?.();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('purges only the selected worktree including names, layout and pending hydration', async () => {
    const mod = await loadTerminalStore();
    const store = mod.useTerminalStore;
    store.getState().addGroupWithTerminal(makeSession());
    store
      .getState()
      .addGroupWithTerminal(makeSession({ id: 'other', worktreeId: 'wt-2' }));
    const groupId = store.getState().worktrees['proj-1/wt-1'].groups[0].id;
    store
      .getState()
      .setTerminalName('proj-1', 'wt-1', 'term-1', 'Private shell');
    store.getState().setGroupName('proj-1', 'wt-1', groupId, 'Private group');
    const deferred = createDeferred<LoadWorktreeTerminalStateResponse>();
    loadWorktreeStateMock.mockReturnValueOnce(deferred.promise);
    const pending = store.getState().hydrateWorktree('proj-1', 'wt-1');
    store.getState().setSplitSizes('proj-1', 'wt-1', groupId, [1]);
    saveWorktreeStateMock.mockClear();
    mod.purgeTerminalWorktrees(['wt-1']);
    await jest.advanceTimersByTimeAsync(1000);
    expect(saveWorktreeStateMock).not.toHaveBeenCalled();
    expect(store.getState().worktrees['proj-1/wt-1']).toBeUndefined();
    expect(
      store.getState().worktrees['proj-1/wt-2'].sessions.other,
    ).toBeDefined();
    expect(store.getState().terminalCustomNames['term-1']).toBeUndefined();
    expect(store.getState().groupCustomNames[groupId]).toBeUndefined();
    deferred.resolve(
      makeLoadResponse({
        terminals: [
          {
            session: makeSession(),
            scrollbackLines: ['deleted secret'],
            exitCode: 0,
            signal: null,
          },
        ],
      }),
    );
    await pending;
    expect(store.getState().worktrees['proj-1/wt-1']).toBeUndefined();
    await mod.ensureTerminalWorktreeHydrated('proj-1', 'wt-1');
    expect(store.getState().worktrees['proj-1/wt-1'].sessions).toEqual({});
  });

  it('hydrates one worktree from persisted main-side terminal state', async () => {
    const mod = await loadTerminalStore();
    const live = makeSession({ id: 'live-1', createdAt: 10 });
    const exited = makeSession({ id: 'exit-1', createdAt: 20 });
    loadWorktreeStateMock.mockResolvedValueOnce(
      makeLoadResponse({
        groups: [
          {
            id: 'group-1',
            terminalIds: [live.id, exited.id],
            focusedTerminalId: exited.id,
            splitSizes: [0.5, 0.5],
          },
        ],
        activeGroupId: 'group-1',
        nextGroupOrdinal: 3,
        groupOrdinals: { 'group-1': 2 },
        terminalCustomNames: {
          [live.id]: 'Frontend shell',
        },
        groupCustomNames: {
          'group-1': 'Daily split',
        },
        terminals: [
          {
            session: live,
            scrollbackLines: ['npm run dev'],
            exitCode: null,
            signal: null,
          },
          {
            session: exited,
            scrollbackLines: ['pytest', 'done'],
            exitCode: 0,
            signal: null,
          },
        ],
        liveTerminalIds: [live.id],
      }),
    );

    await mod.useTerminalStore.getState().hydrateWorktree('proj-1', 'wt-1');

    expect(loadWorktreeStateMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    expect(bucket.hydrated).toBe(true);
    expect(bucket.drawerCollapsed).toBe(true);
    expect(bucket.groups).toEqual([
      {
        id: 'group-1',
        terminalIds: ['live-1', 'exit-1'],
        focusedTerminalId: 'exit-1',
        splitSizes: [0.5, 0.5],
      },
    ]);
    expect(bucket.groupOrdinals).toEqual({ 'group-1': 2 });
    expect(bucket.nextGroupOrdinal).toBe(3);
    expect(bucket.sessions['live-1']).toMatchObject({
      id: 'live-1',
      live: true,
      scrollbackLines: ['npm run dev'],
      exitCode: null,
      signal: null,
    });
    expect(bucket.sessions['exit-1']).toMatchObject({
      id: 'exit-1',
      live: false,
      scrollbackLines: ['pytest', 'done'],
      exitCode: 0,
      signal: null,
    });
    expect(mod.useTerminalStore.getState().terminalCustomNames).toEqual({
      'live-1': 'Frontend shell',
    });
    expect(mod.useTerminalStore.getState().groupCustomNames).toEqual({
      'group-1': 'Daily split',
    });
  });

  it('preserves locally spawned terminals when a stale hydration response resolves later', async () => {
    const mod = await loadTerminalStore();
    const deferred = createDeferred<LoadWorktreeTerminalStateResponse>();
    loadWorktreeStateMock.mockReturnValueOnce(deferred.promise);

    const hydrationPromise = mod.useTerminalStore
      .getState()
      .hydrateWorktree('proj-1', 'wt-1');

    const spawned = makeSession({ id: 'term-local' });
    mod.useTerminalStore.getState().addGroupWithTerminal(spawned);

    deferred.resolve(makeLoadResponse());
    await hydrationPromise;

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }

    expect(bucket.sessions['term-local']).toMatchObject({
      id: 'term-local',
      live: true,
    });
    expect(bucket.groups).toHaveLength(1);
    expect(bucket.groups[0]?.terminalIds).toEqual(['term-local']);
    expect(bucket.activeGroupId).toBe(bucket.groups[0]?.id ?? null);
  });

  it('creates new groups with stable ordinals and persists worktree layout', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'term-1' });
    const second = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    mod.useTerminalStore.getState().addGroupWithTerminal(second);

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }

    expect(bucket.groups).toHaveLength(2);
    expect(bucket.groupOrdinals[bucket.groups[0].id]).toBe(1);
    expect(bucket.groupOrdinals[bucket.groups[1].id]).toBe(2);
    expect(bucket.nextGroupOrdinal).toBe(3);

    const request = getPersistRequest();
    expect(request.projectId).toBe('proj-1');
    expect(request.worktreeId).toBe('wt-1');
    expect(request.groups).toHaveLength(2);
    expect(request.drawerCollapsed).toBe(true);
    expect(request.activeGroupId).toBe(bucket.groups[1].id);
    expect(request.groupOrdinals).toEqual(bucket.groupOrdinals);
  });

  it('adds a background terminal without replacing the active group', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'term-1' });
    const background = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    const activeGroupId = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    )?.activeGroupId;
    mod.useTerminalStore
      .getState()
      .addGroupWithTerminal(background, { activate: false });

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    expect(bucket?.groups).toHaveLength(2);
    expect(bucket?.activeGroupId).toBe(activeGroupId);
  });

  it('keeps the active group null when adding a background terminal', async () => {
    const mod = await loadTerminalStore();
    const background = makeSession({ id: 'term-background' });

    mod.useTerminalStore
      .getState()
      .addGroupWithTerminal(background, { activate: false });

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    expect(bucket?.groups).toHaveLength(1);
    expect(bucket?.activeGroupId).toBeNull();
  });

  it('splits a group, normalizes split sizes, and keeps the new pane focused', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'term-1' });
    const second = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    const groupId = bucket.groups[0].id;

    mod.useTerminalStore
      .getState()
      .splitGroup('proj-1', 'wt-1', groupId, second);

    const nextBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!nextBucket) {
      throw new Error('bucket missing');
    }
    expect(nextBucket.groups[0]).toEqual({
      id: groupId,
      terminalIds: ['term-1', 'term-2'],
      focusedTerminalId: 'term-2',
      splitSizes: [0.5, 0.5],
    });
    expect(nextBucket.sessions['term-2']).toMatchObject({
      id: 'term-2',
      live: true,
    });
  });

  it('debounces split-size persistence per worktree', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'term-1' });
    const second = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    const groupId = bucket.groups[0].id;
    mod.useTerminalStore
      .getState()
      .splitGroup('proj-1', 'wt-1', groupId, second);

    saveWorktreeStateMock.mockClear();
    mod.useTerminalStore
      .getState()
      .setSplitSizes('proj-1', 'wt-1', groupId, [3, 1]);
    mod.useTerminalStore
      .getState()
      .setSplitSizes('proj-1', 'wt-1', groupId, [1, 3]);

    expect(saveWorktreeStateMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(120);

    expect(saveWorktreeStateMock).toHaveBeenCalledTimes(1);
    expect(getPersistRequest().groups[0]?.splitSizes).toEqual([0.25, 0.75]);
  });

  it('scopes drawer collapsed state per worktree', async () => {
    const mod = await loadTerminalStore();
    loadWorktreeStateMock.mockResolvedValueOnce(
      makeLoadResponse({ drawerCollapsed: false }),
    );
    loadWorktreeStateMock.mockResolvedValueOnce(
      makeLoadResponse({ drawerCollapsed: true }),
    );

    await mod.useTerminalStore.getState().hydrateWorktree('proj-1', 'wt-1');
    await mod.useTerminalStore.getState().hydrateWorktree('proj-1', 'wt-2');

    const firstBefore = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    const secondBefore = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-2',
    );
    if (!firstBefore || !secondBefore) {
      throw new Error('bucket missing');
    }
    expect(firstBefore.drawerCollapsed).toBe(false);
    expect(secondBefore.drawerCollapsed).toBe(true);

    mod.useTerminalStore.getState().setDrawerCollapsed('proj-1', 'wt-2', false);

    const firstBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    const secondBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-2',
    );
    if (!firstBucket || !secondBucket) {
      throw new Error('bucket missing');
    }

    expect(firstBucket.drawerCollapsed).toBe(false);
    expect(secondBucket.drawerCollapsed).toBe(false);
    expect(getPersistRequest()).toMatchObject({
      projectId: 'proj-1',
      worktreeId: 'wt-2',
      drawerCollapsed: false,
    });
  });

  it('does not persist drawer collapsed changes before hydration', async () => {
    const mod = await loadTerminalStore();
    loadWorktreeStateMock.mockResolvedValueOnce(
      makeLoadResponse({
        groups: [
          {
            id: 'persisted-group',
            terminalIds: [],
            focusedTerminalId: 'term-1',
            splitSizes: [],
          },
        ],
        activeGroupId: 'persisted-group',
        nextGroupOrdinal: 2,
        groupOrdinals: { 'persisted-group': 1 },
      }),
    );

    mod.useTerminalStore.getState().setDrawerCollapsed('proj-1', 'wt-1', false);

    expect(saveWorktreeStateMock).not.toHaveBeenCalled();
    const preHydrationBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!preHydrationBucket) {
      throw new Error('bucket missing');
    }
    expect(preHydrationBucket.hydrated).toBe(false);
    expect(preHydrationBucket.drawerCollapsed).toBe(false);

    await mod.useTerminalStore.getState().hydrateWorktree('proj-1', 'wt-1');

    expect(saveWorktreeStateMock).not.toHaveBeenCalled();
    const hydratedBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!hydratedBucket) {
      throw new Error('bucket missing');
    }
    expect(hydratedBucket.hydrated).toBe(true);
    expect(hydratedBucket.drawerCollapsed).toBe(false);
    expect(hydratedBucket.groups).toEqual([
      {
        id: 'persisted-group',
        terminalIds: [],
        focusedTerminalId: 'term-1',
        splitSizes: [],
      },
    ]);

    mod.useTerminalStore.getState().setDrawerCollapsed('proj-1', 'wt-1', true);

    expect(getPersistRequest()).toMatchObject({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      drawerCollapsed: true,
      groups: [
        {
          id: 'persisted-group',
          terminalIds: [],
          focusedTerminalId: 'term-1',
          splitSizes: [],
        },
      ],
    });
  });

  it('scopes the active visible terminal group per worktree', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'wt-1-term-1', worktreeId: 'wt-1' });
    const second = makeSession({
      id: 'wt-1-term-2',
      worktreeId: 'wt-1',
      createdAt: 2,
    });
    const other = makeSession({ id: 'wt-2-term-1', worktreeId: 'wt-2' });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    mod.useTerminalStore.getState().addGroupWithTerminal(second);
    mod.useTerminalStore.getState().addGroupWithTerminal(other);

    const firstBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    const secondBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-2',
    );
    if (!firstBucket || !secondBucket) {
      throw new Error('bucket missing');
    }

    const firstWorktreeInitialActive = firstBucket.activeGroupId;
    const firstWorktreeFirstGroup = firstBucket.groups[0]?.id;
    if (
      firstWorktreeInitialActive === null ||
      firstWorktreeFirstGroup === undefined
    ) {
      throw new Error('group missing');
    }

    mod.useTerminalStore
      .getState()
      .setActiveGroup('proj-1', 'wt-1', firstWorktreeFirstGroup);

    const nextFirstBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    const nextSecondBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-2',
    );
    if (!nextFirstBucket || !nextSecondBucket) {
      throw new Error('bucket missing');
    }

    expect(nextFirstBucket.activeGroupId).toBe(firstWorktreeFirstGroup);
    expect(nextSecondBucket.activeGroupId).toBe(secondBucket.activeGroupId);
    expect(nextFirstBucket.activeGroupId).not.toBe(firstWorktreeInitialActive);
  });

  it('persists sanitized terminal and group custom names in the worktree state', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'term-1' });
    const second = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    const groupId = bucket.groups[0].id;
    mod.useTerminalStore
      .getState()
      .splitGroup('proj-1', 'wt-1', groupId, second);

    saveWorktreeStateMock.mockClear();
    mod.useTerminalStore
      .getState()
      .setTerminalName('proj-1', 'wt-1', 'term-1', '  frontend shell  ');
    mod.useTerminalStore
      .getState()
      .setGroupName('proj-1', 'wt-1', groupId, '  Daily split  ');
    mod.useTerminalStore
      .getState()
      .setTerminalName('proj-1', 'wt-1', 'term-2', '   ');

    expect(mod.useTerminalStore.getState().terminalCustomNames).toEqual({
      'term-1': 'frontend shell',
    });
    expect(mod.useTerminalStore.getState().groupCustomNames).toEqual({
      [groupId]: 'Daily split',
    });
    expect(getPersistRequest().terminalCustomNames).toEqual({
      'term-1': 'frontend shell',
    });
    expect(getPersistRequest().groupCustomNames).toEqual({
      [groupId]: 'Daily split',
    });
  });

  it('removes only the selected pane from a split and prunes its custom name', async () => {
    const mod = await loadTerminalStore();
    const first = makeSession({ id: 'term-1' });
    const second = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(first);
    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    const groupId = bucket.groups[0].id;
    mod.useTerminalStore
      .getState()
      .splitGroup('proj-1', 'wt-1', groupId, second);
    mod.useTerminalStore
      .getState()
      .setTerminalName('proj-1', 'wt-1', 'term-2', 'pane 2');

    saveWorktreeStateMock.mockClear();
    mod.useTerminalStore.getState().removeTerminal('proj-1', 'wt-1', 'term-2');

    const nextBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!nextBucket) {
      throw new Error('bucket missing');
    }
    expect(nextBucket.groups).toEqual([
      {
        id: groupId,
        terminalIds: ['term-1'],
        focusedTerminalId: 'term-1',
        splitSizes: [1],
      },
    ]);
    expect(nextBucket.sessions['term-2']).toBeUndefined();
    expect(
      mod.useTerminalStore.getState().terminalCustomNames['term-2'],
    ).toBeUndefined();
    expect(getPersistRequest().groups).toEqual([
      {
        id: groupId,
        terminalIds: ['term-1'],
        focusedTerminalId: 'term-1',
        splitSizes: [1],
      },
    ]);
  });

  it('removes a whole group, kills only live panes, and clears persisted metadata', async () => {
    const mod = await loadTerminalStore();
    const live = makeSession({ id: 'term-1' });
    const exited = makeSession({ id: 'term-2', createdAt: 2 });

    mod.useTerminalStore.getState().addGroupWithTerminal(live);
    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    const groupId = bucket.groups[0].id;
    mod.useTerminalStore
      .getState()
      .splitGroup('proj-1', 'wt-1', groupId, exited);
    mod.useTerminalStore
      .getState()
      .setTerminalName('proj-1', 'wt-1', 'term-1', 'live pane');
    mod.useTerminalStore
      .getState()
      .setTerminalName('proj-1', 'wt-1', 'term-2', 'old pane');
    mod.useTerminalStore
      .getState()
      .setGroupName('proj-1', 'wt-1', groupId, 'split');
    mod.useTerminalStore.getState().applyExit({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      terminalId: 'term-2',
      exitCode: 0,
      signal: null,
    });

    killMock.mockClear();
    saveWorktreeStateMock.mockClear();
    mod.useTerminalStore.getState().removeGroup('proj-1', 'wt-1', groupId);

    expect(killMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledWith({ terminalId: 'term-1' });
    const nextBucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!nextBucket) {
      throw new Error('bucket missing');
    }
    expect(nextBucket.groups).toEqual([]);
    expect(nextBucket.activeGroupId).toBeNull();
    expect(nextBucket.sessions).toEqual({});
    expect(mod.useTerminalStore.getState().terminalCustomNames).toEqual({});
    expect(mod.useTerminalStore.getState().groupCustomNames).toEqual({});
    expect(getPersistRequest().groups).toEqual([]);
    expect(getPersistRequest().terminalCustomNames).toEqual({});
    expect(getPersistRequest().groupCustomNames).toEqual({});
  });

  it('focuses the previous group when the active group is removed', async () => {
    // Closing the active tab should fall back to its neighbor (the tab to the
    // left), not jump to the first tab: [1,2,3,4] close 4 → 3, not 1.
    const mod = await loadTerminalStore();
    const store = mod.useTerminalStore.getState();
    store.addGroupWithTerminal(makeSession({ id: 'term-1' }));
    store.addGroupWithTerminal(makeSession({ id: 'term-2', createdAt: 2 }));
    store.addGroupWithTerminal(makeSession({ id: 'term-3', createdAt: 3 }));
    store.addGroupWithTerminal(makeSession({ id: 'term-4', createdAt: 4 }));

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    expect(bucket.groups).toHaveLength(4);
    // The last-added group is active.
    expect(bucket.activeGroupId).toBe(bucket.groups[3].id);
    const group3 = bucket.groups[2].id;
    const group4 = bucket.groups[3].id;

    mod.useTerminalStore.getState().removeGroup('proj-1', 'wt-1', group4);

    const next = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!next) {
      throw new Error('bucket missing');
    }
    expect(next.groups).toHaveLength(3);
    expect(next.activeGroupId).toBe(group3);
  });

  it('focuses the next group when the first (active) group is removed', async () => {
    // No previous neighbor → fall back to the new first group.
    const mod = await loadTerminalStore();
    const store = mod.useTerminalStore.getState();
    store.addGroupWithTerminal(makeSession({ id: 'term-1' }));
    store.addGroupWithTerminal(makeSession({ id: 'term-2', createdAt: 2 }));

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    const group1 = bucket.groups[0].id;
    const group2 = bucket.groups[1].id;
    // Make the FIRST group active, then remove it.
    mod.useTerminalStore.getState().setActiveGroup('proj-1', 'wt-1', group1);
    mod.useTerminalStore.getState().removeGroup('proj-1', 'wt-1', group1);

    const next = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!next) {
      throw new Error('bucket missing');
    }
    expect(next.activeGroupId).toBe(group2);
  });

  it('keeps exited terminals in the drawer as historical entries', async () => {
    const mod = await loadTerminalStore();
    mod.useTerminalStore
      .getState()
      .addGroupWithTerminal(makeSession({ id: 'term-1' }));

    mod.useTerminalStore.getState().applyExit({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      terminalId: 'term-1',
      exitCode: 143,
      signal: 'SIGTERM',
    });

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    expect(bucket.groups).toHaveLength(1);
    expect(bucket.sessions['term-1']).toMatchObject({
      id: 'term-1',
      live: false,
      exitCode: 143,
      signal: 'SIGTERM',
    });
  });

  it('marks a historical terminal live again after lazy restore', async () => {
    const mod = await loadTerminalStore();
    const session = makeSession({ id: 'term-1' });
    mod.useTerminalStore.getState().addGroupWithTerminal(session);

    mod.useTerminalStore.getState().applyExit({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      terminalId: 'term-1',
      exitCode: null,
      signal: 'app-quit',
    });
    mod.useTerminalStore.getState().markTerminalLive(session);

    const bucket = mod.selectBucket(
      mod.useTerminalStore.getState(),
      'proj-1',
      'wt-1',
    );
    if (!bucket) {
      throw new Error('bucket missing');
    }
    expect(bucket.sessions['term-1']).toMatchObject({
      id: 'term-1',
      live: true,
      exitCode: null,
      signal: null,
    });
  });

  it('formats group labels for single-pane and split groups', async () => {
    const mod = await loadTerminalStore();
    expect(mod.formatGroupLabel({ terminalIds: ['a'] }, 1)).toBe('TERMINAL 1');
    expect(mod.formatGroupLabel({ terminalIds: ['a', 'b'] }, 1)).toBe(
      'SPLIT 1',
    );
    expect(mod.formatGroupLabel({ terminalIds: ['a', 'b', 'c'] }, 4)).toBe(
      'SPLIT 4',
    );
  });

  // The sidebar popover's label chain, shared by desktop `WorktreeItem` and
  // web cloud rows: terminal name → group name → group label → `TERMINAL`.
  describe('resolveTerminalRowLabel', () => {
    const groups = [
      { id: 'g-solo', terminalIds: ['solo'] },
      { id: 'g-split', terminalIds: ['left', 'right'] },
    ];
    const sources = {
      terminalCustomNames: { left: 'Dev server' },
      groupCustomNames: { 'g-split': 'Builds' },
      groupOrdinals: { 'g-solo': 3, 'g-split': 4 },
      groups,
    };

    it('prefers the terminal custom name over its group', async () => {
      const mod = await loadTerminalStore();
      expect(mod.resolveTerminalRowLabel('left', null, sources)).toBe(
        'Dev server',
      );
    });

    it('falls back to the group custom name, finding the group by terminal', async () => {
      const mod = await loadTerminalStore();
      expect(mod.resolveTerminalRowLabel('right', null, sources)).toBe(
        'Builds',
      );
    });

    it('falls back to the group label with its stable ordinal', async () => {
      const mod = await loadTerminalStore();
      expect(mod.resolveTerminalRowLabel('solo', null, sources)).toBe(
        'TERMINAL 3',
      );
      expect(
        mod.resolveTerminalRowLabel('right', null, {
          ...sources,
          groupCustomNames: {},
        }),
      ).toBe('SPLIT 4');
    });

    it('uses a known group id before looking the terminal up', async () => {
      const mod = await loadTerminalStore();
      expect(mod.resolveTerminalRowLabel('solo', 'g-split', sources)).toBe(
        'Builds',
      );
    });

    it('ends at TERMINAL without a group, an ordinal, or a known group', async () => {
      const mod = await loadTerminalStore();
      expect(mod.resolveTerminalRowLabel('orphan', null, sources)).toBe(
        'TERMINAL',
      );
      expect(
        mod.resolveTerminalRowLabel('solo', null, {
          ...sources,
          groupOrdinals: {},
        }),
      ).toBe('TERMINAL');
      expect(mod.resolveTerminalRowLabel('solo', 'gone', sources)).toBe(
        'TERMINAL',
      );
    });

    it('ignores empty custom names', async () => {
      const mod = await loadTerminalStore();
      expect(
        mod.resolveTerminalRowLabel('left', null, {
          ...sources,
          terminalCustomNames: { left: '' },
          groupCustomNames: { 'g-split': '' },
        }),
      ).toBe('SPLIT 4');
    });
  });
});
