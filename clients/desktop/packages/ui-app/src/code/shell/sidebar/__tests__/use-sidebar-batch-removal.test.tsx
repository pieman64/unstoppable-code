/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createSidebarRemovalQueue,
  orderSidebarBatchTargets,
  sidebarBatchFailureReason,
  useSidebarBatchRemoval,
  type RemoveRowInBatch,
  type SidebarBatchRemoval,
  type WorktreeBatchItem,
  type WorktreeBatchTarget,
} from '../use-sidebar-batch-removal';

type RemoveWorktreeInBatch = RemoveRowInBatch<WorktreeBatchTarget>;
const WORKTREES = { singular: 'worktree', plural: 'worktrees' };

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const target = (id: string): WorktreeBatchTarget => ({
  key: `ws/${id}`,
  workspaceLocalId: 'ws',
  worktreeLocalId: id,
  branchName: id,
});

const TARGETS = [target('a'), target('b'), target('c')];

interface DeferredRemove {
  readonly remove: jest.Mock<Promise<void>, Parameters<RemoveWorktreeInBatch>>;
  readonly calls: string[];
  readonly settle: (id: string, error?: unknown) => Promise<void>;
}

/** A remove whose settlement the test controls per worktree id. */
function deferredRemove(): DeferredRemove {
  const pending = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  const calls: string[] = [];
  const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
    ({ worktreeLocalId: id }) =>
      new Promise<void>((resolve, reject) => {
        calls.push(id);
        pending.set(id, { resolve, reject });
      }),
  );
  return {
    remove,
    calls,
    settle: async (id: string, error?: unknown): Promise<void> => {
      const entry = pending.get(id);
      if (!entry) throw new Error(`no pending removal for ${id}`);
      if (error !== undefined) entry.reject(error);
      else entry.resolve();
      pending.delete(id);
      // Let the drain observe the settlement and start the next item.
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    },
  };
}

const statuses = (items: readonly WorktreeBatchItem[]): string[] =>
  items.map((item) => `${item.target.worktreeLocalId}:${item.status}`);

describe('orderSidebarBatchTargets', () => {
  it('moves the navigated worktree last and keeps the rest in order', () => {
    expect(orderSidebarBatchTargets(TARGETS, 'ws/a').map((t) => t.key)).toEqual(
      ['ws/b', 'ws/c', 'ws/a'],
    );
    expect(
      orderSidebarBatchTargets(TARGETS, undefined).map((t) => t.key),
    ).toEqual(['ws/a', 'ws/b', 'ws/c']);
  });
});

describe('createSidebarRemovalQueue', () => {
  it('runs a batch serially, navigated worktree last, with the batch options', async () => {
    const { remove, calls, settle } = deferredRemove();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: () => undefined,
    });
    const result = queue.enqueue({
      batchId: 'b1',
      targets: TARGETS,
      options: { mode: 'delete', deleteBranch: true },
      unit: WORKTREES,
      activeKey: 'ws/a',
    });
    await Promise.resolve();
    expect(calls).toEqual(['b']);
    expect(remove).toHaveBeenCalledWith(target('b'), {
      mode: 'delete',
      deleteBranch: true,
      expectedBranchName: 'b',
    });
    expect(queue.state().running).toBe(true);
    await settle('b');
    await settle('c');
    await settle('a');
    expect(calls).toEqual(['b', 'c', 'a']);
    await expect(result).resolves.toMatchObject({
      allSucceeded: true,
      remainingKeys: [],
    });
    expect(queue.state().running).toBe(false);
  });

  it('appends a second batch to the running queue, runs it after the first, and settles each batch on its own', async () => {
    const { remove, calls, settle } = deferredRemove();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: () => undefined,
    });
    const first = queue.enqueue({
      batchId: 'b1',
      targets: [target('a'), target('b')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    const second = queue.enqueue({
      batchId: 'b2',
      targets: [target('c')],
      options: { mode: 'archive' },
      unit: WORKTREES,
    });
    expect(queue.state().items.map((item) => item.batchId)).toEqual([
      'b1',
      'b1',
      'b2',
    ]);
    expect(queue.state().items[2]).toMatchObject({
      mode: 'archive',
      status: 'pending',
    });
    await settle('a');
    await settle('b');
    // The first batch is done while the second still runs.
    await expect(first).resolves.toMatchObject({ allSucceeded: true });
    expect(queue.state().running).toBe(true);
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(remove).toHaveBeenLastCalledWith(target('c'), {
      mode: 'archive',
      expectedBranchName: 'c',
    });
    await settle('c');
    await expect(second).resolves.toMatchObject({ allSucceeded: true });
  });

  it('queues a key once while it is pending or running, but again after it settled', async () => {
    const { remove, calls, settle } = deferredRemove();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: () => undefined,
    });
    const first = queue.enqueue({
      batchId: 'b1',
      targets: [target('a'), target('b')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    // Duplicate of b while it is pending: nothing new, resolves at once.
    await expect(
      queue.enqueue({
        batchId: 'b2',
        targets: [target('b')],
        options: { mode: 'delete' },
        unit: WORKTREES,
      }),
    ).resolves.toMatchObject({ items: [], allSucceeded: true });
    await settle('a', new Error('Teardown script failed.'));
    await settle('b');
    await first;
    // a failed: a later batch may retry it, tracked as its own item.
    const retry = queue.enqueue({
      batchId: 'b3',
      targets: [target('a')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    expect(calls).toEqual(['a', 'b', 'a']);
    await settle('a');
    await expect(retry).resolves.toMatchObject({ allSucceeded: true });
    expect(statuses(queue.state().items)).toEqual([
      'a:failed',
      'b:done',
      'a:done',
    ]);
  });

  it('records a failure, a non-Error rejection, a late block, and a throwing block check, and keeps going', async () => {
    const { remove, settle } = deferredRemove();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: (t) => {
        if (t.worktreeLocalId === 'b') return 'Agent is working';
        if (t.worktreeLocalId === 'd') {
          throw new Error('Session state is unavailable');
        }
        return undefined;
      },
    });
    const result = queue.enqueue({
      batchId: 'b1',
      targets: [
        target('a'),
        target('b'),
        target('c'),
        target('d'),
        target('e'),
      ],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    await settle('a', new Error('Teardown script failed.'));
    await settle('c', 'not an error');
    await settle('e');
    const settled = await result;
    expect(statuses(settled.items)).toEqual([
      'a:failed',
      'b:skipped',
      'c:failed',
      'd:failed',
      'e:done',
    ]);
    expect(settled.items.map((item) => item.reason)).toEqual([
      'Teardown script failed.',
      'Agent is working',
      "Couldn't delete this worktree",
      'Session state is unavailable',
      undefined,
    ]);
    expect(settled.allSucceeded).toBe(false);
    expect(settled.remainingKeys).toEqual(['ws/a', 'ws/b', 'ws/c', 'ws/d']);
    // A skipped worktree is never passed to the host.
    expect(remove).not.toHaveBeenCalledWith(target('b'), expect.anything());
  });

  it('Stop drops every not-started item across batches after the in-flight one, including items enqueued after Stop', async () => {
    const { remove, calls, settle } = deferredRemove();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: () => undefined,
    });
    const first = queue.enqueue({
      batchId: 'b1',
      targets: [target('a'), target('b')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    const second = queue.enqueue({
      batchId: 'b2',
      targets: [target('c')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    queue.stop();
    expect(queue.state().stopRequested).toBe(true);
    // Enqueued after Stop: appended, never started, resolved at drain end.
    const late = queue.enqueue({
      batchId: 'b3',
      targets: [target('d')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await settle('a');
    expect(calls).toEqual(['a']);
    await expect(first).resolves.toMatchObject({
      allSucceeded: false,
      remainingKeys: ['ws/b'],
    });
    await expect(second).resolves.toMatchObject({
      allSucceeded: false,
      remainingKeys: ['ws/c'],
    });
    await expect(late).resolves.toMatchObject({
      allSucceeded: false,
      remainingKeys: ['ws/d'],
    });
    expect(statuses(queue.state().items)).toEqual([
      'a:done',
      'b:pending',
      'c:pending',
      'd:pending',
    ]);
    expect(queue.state()).toMatchObject({
      running: false,
      stopRequested: false,
    });
    // Stop while idle is a no-op.
    queue.stop();
    expect(queue.state().stopRequested).toBe(false);
  });

  it('stops after the in-flight item once the host removal goes away', async () => {
    const { remove, calls, settle } = deferredRemove();
    let hostRemove: RemoveWorktreeInBatch | undefined = remove;
    const queue = createSidebarRemovalQueue({
      remove: () => hostRemove,
      blockedReasonFor: () => undefined,
    });
    const result = queue.enqueue({
      batchId: 'b1',
      targets: [target('a'), target('b')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    hostRemove = undefined;
    await settle('a');
    expect(calls).toEqual(['a']);
    await expect(result).resolves.toMatchObject({ remainingKeys: ['ws/b'] });
    expect(queue.state().running).toBe(false);
  });

  it('queues a key Stop left not started again, and never runs or fails the dropped item', async () => {
    const { remove, calls, settle } = deferredRemove();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: () => undefined,
    });
    void queue.enqueue({
      batchId: 'b1',
      targets: [target('a'), target('b'), target('c')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    queue.stop();
    await settle('a');
    expect(queue.state().running).toBe(false);
    expect(
      queue.state().items.filter((item) => item.dropped === true),
    ).toHaveLength(2);

    const again = queue.enqueue({
      batchId: 'b2',
      targets: [target('c'), target('d')],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    await settle('c');
    await settle('d');
    await expect(again).resolves.toMatchObject({
      allSucceeded: true,
      remainingKeys: [],
    });
    expect(calls).toEqual(['a', 'c', 'd']);
    expect(statuses(queue.state().items)).toEqual([
      'a:done',
      'b:pending',
      'c:pending',
      'c:done',
      'd:done',
    ]);
  });

  it('reports every change and forgets settled items on reset, but not while running', async () => {
    const { remove, settle } = deferredRemove();
    const onChange = jest.fn();
    const queue = createSidebarRemovalQueue({
      remove: () => remove,
      blockedReasonFor: () => undefined,
      onChange,
    });
    const result = queue.enqueue({
      batchId: 'b1',
      targets: [target('a')],
      options: { mode: 'archive' },
      unit: WORKTREES,
    });
    await Promise.resolve();
    queue.reset();
    expect(queue.state().items).toHaveLength(1);
    await settle('a');
    await result;
    const seen = onChange.mock.calls.map(
      ([state]: [{ items: readonly WorktreeBatchItem[] }]) =>
        statuses(state.items)[0] ?? 'none',
    );
    expect(seen).toEqual(
      expect.arrayContaining(['a:pending', 'a:running', 'a:done']),
    );
    queue.reset();
    expect(queue.state().items).toEqual([]);
    expect(onChange).toHaveBeenLastCalledWith({
      items: [],
      running: false,
      stopRequested: false,
    });
  });
});

describe('sidebar batch rows of any kind', () => {
  it('names the unit in a bare failure reason', () => {
    const chats = { singular: 'chat', plural: 'chats' };
    expect(sidebarBatchFailureReason(new Error(''), 'delete', chats)).toBe(
      "Couldn't delete this chat",
    );
    expect(sidebarBatchFailureReason(new Error('boom'), 'delete', chats)).toBe(
      'boom',
    );
  });

  it('queues any target shape that carries a key, naming its unit in a bare failure', async () => {
    const removed: string[] = [];
    const queue = createSidebarRemovalQueue<{
      readonly key: string;
      readonly entryId: string;
    }>({
      remove:
        () =>
        async (entry): Promise<void> => {
          removed.push(entry.entryId);
          await Promise.resolve();
          if (entry.entryId === 'b') throw new Error('');
        },
      blockedReasonFor: () => undefined,
    });
    const result = await queue.enqueue({
      batchId: 'b1',
      targets: [
        { key: 'work-entry:ws/a', entryId: 'a' },
        { key: 'work-entry:ws/b', entryId: 'b' },
      ],
      options: { mode: 'archive' },
      unit: { singular: 'chat', plural: 'chats' },
    });
    expect(removed).toEqual(['a', 'b']);
    expect(result.items.map((item) => [item.status, item.reason])).toEqual([
      ['done', undefined],
      ['failed', "Couldn't archive this chat"],
    ]);
  });

  it('asks for the removal per item, so one row kind withdrawing stops the drain', async () => {
    const removed: string[] = [];
    const queue = createSidebarRemovalQueue<{ readonly key: string }>({
      remove: (row) =>
        row.key === 'b'
          ? undefined
          : async (target): Promise<void> => {
              removed.push(target.key);
              await Promise.resolve();
            },
      blockedReasonFor: () => undefined,
    });
    const result = await queue.enqueue({
      batchId: 'b1',
      targets: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      options: { mode: 'delete' },
      unit: WORKTREES,
    });
    expect(removed).toEqual(['a']);
    expect(result.remainingKeys).toEqual(['b', 'c']);
    expect(queue.state().items.map((item) => item.dropped)).toEqual([
      undefined,
      true,
      true,
    ]);
  });
});

describe('useSidebarBatchRemoval', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: SidebarBatchRemoval<WorktreeBatchTarget> | undefined;
  let renders = 0;

  function Probe({
    remove,
  }: {
    remove: RemoveWorktreeInBatch | undefined;
  }): JSX.Element {
    renders += 1;
    latest = useSidebarBatchRemoval({
      removeFor: () => remove,
      canRemove: remove !== undefined,
      blockedReasonFor: () => undefined,
    });
    return <span>{latest.items.length}</span>;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    renders = 0;
  });

  afterEach(() => {
    container.remove();
    latest = undefined;
  });

  it('mirrors queue state, enqueues while running, and honors Stop and reset', async () => {
    const { remove, settle } = deferredRemove();
    act(() => root.render(<Probe remove={remove} />));
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first =
        latest?.enqueue({
          batchId: 'b1',
          targets: [target('a')],
          options: { mode: 'delete' },
          unit: WORKTREES,
        }) ?? Promise.resolve();
    });
    expect(latest?.running).toBe(true);
    act(() => {
      void latest?.enqueue({
        batchId: 'b2',
        targets: [target('b'), target('c')],
        options: { mode: 'delete' },
        unit: WORKTREES,
      });
    });
    expect(statuses(latest?.items ?? [])).toEqual([
      'a:running',
      'b:pending',
      'c:pending',
    ]);
    await act(async () => settle('a'));
    await first;
    act(() => latest?.stop());
    expect(latest?.stopRequested).toBe(true);
    await act(async () => settle('b'));
    expect(latest?.running).toBe(false);
    expect(latest?.stopRequested).toBe(false);
    expect(statuses(latest?.items ?? [])).toEqual([
      'a:done',
      'b:done',
      'c:pending',
    ]);
    act(() => latest?.reset());
    expect(latest?.items).toEqual([]);
    act(() => root.unmount());
  });

  it('starts no further items once the host removal goes away', async () => {
    const { remove, settle } = deferredRemove();
    act(() => root.render(<Probe remove={remove} />));
    let run: Promise<unknown> = Promise.resolve();
    act(() => {
      run =
        latest?.enqueue({
          batchId: 'b1',
          targets: TARGETS,
          options: { mode: 'archive' },
          unit: WORKTREES,
        }) ?? Promise.resolve();
    });
    // The host can no longer send commands (web: the desktop disconnected).
    act(() => root.render(<Probe remove={undefined} />));
    await act(async () => {
      await settle('a');
      await run;
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(statuses(latest?.items ?? [])).toEqual([
      'a:done',
      'b:pending',
      'c:pending',
    ]);
    act(() => root.unmount());
  });

  it('enqueues nothing without a host removal', async () => {
    act(() => root.render(<Probe remove={undefined} />));
    await expect(
      latest?.enqueue({
        batchId: 'b1',
        targets: TARGETS,
        options: { mode: 'archive' },
        unit: WORKTREES,
      }),
    ).resolves.toBeUndefined();
    expect(latest?.items).toEqual([]);
    act(() => root.unmount());
  });

  it('stops after the in-flight item on unmount and sets no state after', async () => {
    const { remove, calls, settle } = deferredRemove();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    act(() => root.render(<Probe remove={remove} />));
    let run: Promise<unknown> = Promise.resolve();
    act(() => {
      run =
        latest?.enqueue({
          batchId: 'b1',
          targets: TARGETS,
          options: { mode: 'archive' },
          unit: WORKTREES,
        }) ?? Promise.resolve();
    });
    act(() => root.unmount());
    const rendersAtUnmount = renders;
    await settle('a');
    await run;
    expect(calls).toEqual(['a']);
    expect(renders).toBe(rendersAtUnmount);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
