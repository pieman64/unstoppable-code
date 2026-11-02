import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { createSidebarPlacementStore } from '../create-sidebar-placement-store';
import type { SidebarPlacementSnapshot } from '../sidebar-placement-model';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const snapshot = (order = ['a', 'b', 'c']): SidebarPlacementSnapshot => ({
  order,
  groups: [],
  movableItemIds: new Set(order),
});
const move = (
  itemId: string,
  before: string,
): {
  scope: { workspaceLocalId: string };
  itemId: string;
  groupId: null;
  before: string;
} => ({
  scope: { workspaceLocalId: 'ws' },
  itemId,
  groupId: null,
  before,
});
const tick = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('sidebar placement save and reconciliation lanes', () => {
  it('lets an editor await visible projection without blocking another save', async () => {
    const older = deferred<SidebarPlacementSnapshot>();
    const newer = deferred<SidebarPlacementSnapshot>();
    const read = jest
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const save = jest.fn().mockResolvedValue(undefined);
    const store = createSidebarPlacementStore(snapshot(), {
      save,
      read,
      classifyFailure: () => 'uncertain',
    });
    await store.move(move('c', 'a'));
    const visible = jest.fn();
    const waiting = store.afterReconciliation().then(visible);
    await store.move(move('b', 'c'));
    expect(save).toHaveBeenCalledTimes(2);
    older.resolve(snapshot(['c', 'a', 'b']));
    await tick();
    expect(visible).not.toHaveBeenCalled();
    newer.resolve(snapshot(['b', 'c', 'a']));
    await waiting;
    expect(visible).toHaveBeenCalledTimes(1);
    store.dispose();
  });
  it('does not turn a committed write into a save failure when the editor refresh fails', async () => {
    const read = deferred<SidebarPlacementSnapshot>();
    const store = createSidebarPlacementStore(snapshot(), {
      save: () => Promise.resolve(),
      read: () => read.promise,
      classifyFailure: () => 'uncertain',
    });
    await store.move(move('c', 'a'));
    const waiting = store.afterReconciliation();
    read.reject(new Error('offline'));
    await waiting;
    expect(store.getState().pending[0]?.status).toBe('acknowledged');
    store.dispose();
  });
  it('paints successive drops synchronously and admits save two before read one finishes', async () => {
    const first = deferred<void>();
    const read = deferred<SidebarPlacementSnapshot>();
    const save = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const store = createSidebarPlacementStore(snapshot(), {
      save,
      read: () => read.promise,
      classifyFailure: () => 'uncertain',
    });
    const one = store.move(move('c', 'a'));
    expect(store.getState().rendered.order).toEqual(['c', 'a', 'b']);
    const two = store.move(move('b', 'c'));
    expect(store.getState().rendered.order).toEqual(['b', 'c', 'a']);
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve();
    await one;
    await two;
    expect(save).toHaveBeenCalledTimes(2);
    expect(store.getState().rendered.order).toEqual(['b', 'c', 'a']);
    store.dispose();
    read.resolve(snapshot());
  });
  it('does not let a read started before a newer acknowledgement retire its intent', async () => {
    const older = deferred<SidebarPlacementSnapshot>();
    const newer = deferred<SidebarPlacementSnapshot>();
    const read = jest
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const store = createSidebarPlacementStore(snapshot(), {
      save: () => Promise.resolve(),
      read,
      classifyFailure: () => 'uncertain',
    });
    await store.move(move('c', 'a'));
    await tick();
    await store.move(move('b', 'c'));
    older.resolve(snapshot(['c', 'a', 'b']));
    await tick();
    expect(store.getState().rendered.order).toEqual(['b', 'c', 'a']);
    expect(store.getState().pending).toHaveLength(2);
    newer.resolve(snapshot(['b', 'c', 'a']));
    await tick();
    expect(store.getState().pending).toHaveLength(0);
    store.dispose();
  });
  it('replays later moves after rejection without restoring an obsolete snapshot', async () => {
    const first = deferred<void>();
    const read = deferred<SidebarPlacementSnapshot>();
    const save = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const store = createSidebarPlacementStore(snapshot(), {
      save,
      read: () => read.promise,
      classifyFailure: () => 'rejected',
    });
    const one = store.move(move('c', 'a')).catch(() => undefined);
    const two = store.move(move('b', 'a'));
    first.reject(new Error('denied'));
    await one;
    await two;
    expect(store.getState().rendered.order).toEqual(['b', 'a', 'c']);
    store.dispose();
    read.resolve(snapshot());
  });
  it('does not retry an uncertain write and pauses only its own save lane until read', async () => {
    const read = deferred<SidebarPlacementSnapshot>();
    const save = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(undefined);
    const store = createSidebarPlacementStore(snapshot(), {
      save,
      read: () => read.promise,
      classifyFailure: () => 'uncertain',
    });
    await store.move(move('c', 'a')).catch(() => undefined);
    const two = store.move(move('b', 'c'));
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    read.resolve(snapshot(['c', 'a', 'b']));
    await two;
    expect(save).toHaveBeenCalledTimes(2);
    store.dispose();
  });
  it('retains acknowledgement after failed reads and retries without replaying saves', async () => {
    jest.useFakeTimers();
    const save = jest.fn().mockResolvedValue(undefined);
    const read = jest.fn().mockRejectedValue(new Error('offline'));
    const store = createSidebarPlacementStore(snapshot(), {
      save,
      read,
      classifyFailure: () => 'uncertain',
    });
    await store.move(move('c', 'a'));
    await tick();
    for (const delay of [250, 1000, 2000]) {
      await jest.advanceTimersByTimeAsync(delay);
    }
    expect(read).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getState().pending[0]?.status).toBe('acknowledged');
    store.dispose();
    jest.useRealTimers();
  });
  it('does not publish a late read into a disposed context', async () => {
    const read = deferred<SidebarPlacementSnapshot>();
    const store = createSidebarPlacementStore(snapshot(), {
      save: () => Promise.resolve(),
      read: () => read.promise,
      classifyFailure: () => 'uncertain',
    });
    await store.move(move('c', 'a'));
    const listener = jest.fn();
    store.subscribe(listener);
    store.dispose();
    read.resolve(snapshot(['c', 'a', 'b']));
    await tick();
    expect(listener).not.toHaveBeenCalled();
  });
});

it('serializes metadata writes with drops and preserves a later collapse while replaying', async () => {
  const first = deferred<void>();
  const group: SidebarItemGroup = {
    id: 'one',
    name: 'One',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a'],
  };
  const save = jest
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  const editSave = jest.fn(() => Promise.resolve());
  const store = createSidebarPlacementStore(
    { ...snapshot(), groups: [group] },
    {
      save,
      read: () => new Promise<never>(() => undefined),
      classifyFailure: () => 'uncertain',
    },
  );
  const one = store.move({ ...move('c', 'a'), groupId: 'one' });
  const edit = store.changeGroups(
    (groups) => groups.map((current) => ({ ...current, collapsed: true })),
    editSave,
  );
  const two = store.move({ ...move('b', 'c'), groupId: 'one' });
  expect(store.getState().rendered.order).toEqual(['b', 'c', 'a']);
  expect(store.getState().rendered.groups[0]?.collapsed).toBe(true);
  expect(editSave).not.toHaveBeenCalled();
  first.resolve();
  await one;
  await edit;
  await two;
  expect(save).toHaveBeenCalledTimes(2);
  expect(editSave).toHaveBeenCalledTimes(1);
  expect(store.getState().rendered.groups[0]?.collapsed).toBe(true);
  store.dispose();
});

it('accepts a drop into an acknowledged new group while its projection read is held', async () => {
  const created: SidebarItemGroup = {
    id: 'created',
    name: 'New',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a'],
  };
  const store = createSidebarPlacementStore(snapshot(), {
    save: () => Promise.resolve(),
    read: () => new Promise<never>(() => undefined),
    classifyFailure: () => 'uncertain',
  });
  await store.changeGroups(
    (groups) => [...groups, { ...created, id: 'pending' }],
    () => Promise.resolve(created),
    (groups, result) =>
      groups.map((group) => (group.id === 'pending' ? result : group)),
  );
  const moving = store.move({ ...move('c', 'a'), groupId: created.id });
  expect(store.getState().rendered.order).toEqual(['c', 'a', 'b']);
  expect(store.getState().rendered.groups.map((group) => group.id)).toEqual([
    'created',
  ]);
  expect(store.getState().rendered.groups[0]?.memberIds).toEqual(['a', 'c']);
  await moving;
  store.dispose();
});

it('uses new inventory for additions and deletions without confirming pending placement', async () => {
  const first = deferred<void>();
  const store = createSidebarPlacementStore(snapshot(), {
    save: () => first.promise,
    read: () => new Promise<never>(() => undefined),
    classifyFailure: () => 'uncertain',
  });
  const moving = store.move(move('c', 'a'));
  store.updateInventory(snapshot(['new', 'a', 'c']));
  expect(store.getState().rendered.order).toEqual(['new', 'c', 'a']);
  expect(store.getState().pending).toHaveLength(1);
  first.resolve();
  await moving;
  store.dispose();
});

it('does not duplicate a provisional creation when an unsolicited snapshot arrives before its acknowledgement', async () => {
  const created: SidebarItemGroup = {
    id: 'created',
    name: 'New',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a'],
  };
  const saving = deferred<SidebarItemGroup>();
  const store = createSidebarPlacementStore(snapshot(), {
    save: () => Promise.resolve(),
    read: () => new Promise<never>(() => undefined),
    classifyFailure: () => 'uncertain',
  });
  const creating = store.changeGroups(
    (groups) => [...groups, { ...created, id: 'pending' }],
    () => saving.promise,
    (groups, result) =>
      groups.map((group) => (group.id === 'pending' ? result : group)),
  );
  store.updateInventory({ ...snapshot(), groups: [created] });
  expect(store.getState().rendered.groups.map((group) => group.id)).toEqual([
    'pending',
  ]);
  saving.resolve(created);
  await creating;
  expect(store.getState().rendered.groups.map((group) => group.id)).toEqual([
    'created',
  ]);
  store.dispose();
});
