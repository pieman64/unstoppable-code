import {
  hydrateSubagentViewState,
  sanitizeSubagentViewStateSnapshot,
  useSubagentViewStateStore,
  type SubagentViewStatePersistence,
  type SubagentViewStateSnapshot,
} from '../subagent-view-state-store';

class MemoryPersistence implements SubagentViewStatePersistence {
  public snapshot: SubagentViewStateSnapshot | null;

  public constructor(snapshot: SubagentViewStateSnapshot | null) {
    this.snapshot = snapshot;
  }

  public load(_scopeKey: string): Promise<SubagentViewStateSnapshot | null> {
    void _scopeKey;
    return Promise.resolve(this.snapshot);
  }

  public save(_scopeKey: string, snapshot: SubagentViewStateSnapshot): void {
    this.snapshot = snapshot;
  }
}

function resetStore(): void {
  useSubagentViewStateStore.setState({ scopes: {} });
}

describe('subagent view-state store', () => {
  it('remembers Levels and Focus per root chat across a simulated reload', async () => {
    resetStore();
    const firstAdapter = new MemoryPersistence(null);
    await hydrateSubagentViewState('panel-scope', firstAdapter);
    const store = useSubagentViewStateStore.getState();
    store.setSelectedRoot('panel-scope', 'root-one');
    store.setLevels('panel-scope', 'root-one', 6);
    store.setFocus('panel-scope', 'root-one', 'node-focus');
    store.setLevels('panel-scope', 'root-two', 'all');

    expect(firstAdapter.snapshot?.roots['root-one']).toEqual({
      levels: 6,
      focusId: 'node-focus',
    });
    expect(firstAdapter.snapshot?.roots['root-two']).toEqual({
      levels: 'all',
      focusId: null,
    });

    resetStore();
    const secondAdapter = new MemoryPersistence(firstAdapter.snapshot);
    await hydrateSubagentViewState('panel-scope', secondAdapter);
    const reloaded = useSubagentViewStateStore.getState().scopes['panel-scope'];

    expect(reloaded?.selectedRootId).toBe('root-one');
    expect(reloaded?.roots['root-one']).toEqual({
      levels: 6,
      focusId: 'node-focus',
    });
    expect(reloaded?.roots['root-two']).toEqual({
      levels: 'all',
      focusId: null,
    });
  });

  it('drops forgotten roots and clears a matching selection', async () => {
    resetStore();
    const adapter = new MemoryPersistence(null);
    await hydrateSubagentViewState('forget-scope', adapter);
    const store = useSubagentViewStateStore.getState();
    store.setSelectedRoot('forget-scope', 'deleted-root');
    store.setLevels('forget-scope', 'deleted-root', 5);
    store.setFocus('forget-scope', 'retained-root', 'kept-focus');

    store.forgetSubagentRootChats('forget-scope', ['deleted-root']);

    const current = useSubagentViewStateStore.getState().scopes['forget-scope'];
    expect(current?.selectedRootId).toBeNull();
    expect(current?.roots['deleted-root']).toBeUndefined();
    expect(current?.roots['retained-root']).toEqual({
      levels: 'auto',
      focusId: 'kept-focus',
    });
    expect(adapter.snapshot?.roots['deleted-root']).toBeUndefined();
  });

  it('keeps edits made while storage is still loading', async () => {
    resetStore();
    let finishLoad:
      | ((snapshot: SubagentViewStateSnapshot | null) => void)
      | undefined;
    const loadPromise = new Promise<SubagentViewStateSnapshot | null>(
      (resolve) => {
        finishLoad = resolve;
      },
    );
    const adapter: SubagentViewStatePersistence = {
      load: (): Promise<SubagentViewStateSnapshot | null> => loadPromise,
      save: (): void => {},
    };
    const hydration = hydrateSubagentViewState('race-scope', adapter);
    useSubagentViewStateStore.getState().setFilter('race-scope', 'active');
    useSubagentViewStateStore
      .getState()
      .setFocus('race-scope', 'root', 'local-focus');
    finishLoad?.({
      version: 1,
      filter: 'attention',
      view: 'list',
      selectedRootId: null,
      roots: { root: { levels: 8, focusId: 'stored-focus' } },
    });
    await hydration;

    const current = useSubagentViewStateStore.getState().scopes['race-scope'];
    expect(current?.filter).toBe('active');
    expect(current?.view).toBe('list');
    expect(current?.roots.root).toEqual({ levels: 8, focusId: 'local-focus' });
  });

  it('sanitizes garbage snapshots and skips malformed root entries', () => {
    expect(sanitizeSubagentViewStateSnapshot(null)).toBeNull();
    expect(sanitizeSubagentViewStateSnapshot({ version: 2 })).toBeNull();

    const malformed: unknown = {
      version: 1,
      filter: 'all',
      view: 'tree',
      selectedRootId: null,
      roots: {
        good: { levels: 4, focusId: null },
        bad: { levels: 'six', focusId: 'node' },
      },
    };
    expect(sanitizeSubagentViewStateSnapshot(malformed)).toEqual({
      version: 1,
      filter: 'all',
      view: 'tree',
      selectedRootId: null,
      roots: { good: { levels: 4, focusId: null } },
    });
  });
});
