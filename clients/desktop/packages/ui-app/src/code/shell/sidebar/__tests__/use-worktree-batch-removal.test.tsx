/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  orderWorktreeBatchTargets,
  runWorktreeBatchRemoval,
  useWorktreeBatchRemoval,
  type RemoveWorktreeInBatch,
  type WorktreeBatchRemoval,
  type WorktreeBatchTarget,
} from '../use-worktree-batch-removal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const target = (id: string): WorktreeBatchTarget => ({
  key: `ws/${id}`,
  workspaceLocalId: 'ws',
  worktreeLocalId: id,
});

const TARGETS = [target('a'), target('b'), target('c')];

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('orderWorktreeBatchTargets', () => {
  it('moves the navigated worktree last and keeps the rest in order', () => {
    expect(
      orderWorktreeBatchTargets(TARGETS, 'ws/a').map((t) => t.key),
    ).toEqual(['ws/b', 'ws/c', 'ws/a']);
    expect(
      orderWorktreeBatchTargets(TARGETS, undefined).map((t) => t.key),
    ).toEqual(['ws/a', 'ws/b', 'ws/c']);
  });
});

describe('runWorktreeBatchRemoval', () => {
  it('removes sequentially, navigated worktree last, with the batch options', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const remove: RemoveWorktreeInBatch = async (_ws, id, options) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      calls.push(`${id}:${options.mode}:${String(options.deleteBranch)}`);
      await Promise.resolve();
      inFlight -= 1;
    };
    const result = await runWorktreeBatchRemoval({
      targets: TARGETS,
      options: { mode: 'archive', deleteBranch: false },
      activeKey: 'ws/b',
      remove,
      blockedReasonFor: () => undefined,
      shouldStop: () => false,
    });
    expect(calls).toEqual([
      'a:archive:false',
      'c:archive:false',
      'b:archive:false',
    ]);
    expect(result.allSucceeded).toBe(true);
    expect(result.remainingKeys).toEqual([]);
  });

  it("passes each target's confirmed branch as the expected branch", async () => {
    const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
      () => Promise.resolve(),
    );
    await runWorktreeBatchRemoval({
      targets: [{ ...target('a'), branchName: 'feature/a' }, target('b')],
      options: { mode: 'delete', deleteBranch: true },
      remove,
      blockedReasonFor: () => undefined,
      shouldStop: () => false,
    });
    expect(remove.mock.calls).toEqual([
      [
        'ws',
        'a',
        { mode: 'delete', deleteBranch: true, expectedBranchName: 'feature/a' },
      ],
      ['ws', 'b', { mode: 'delete', deleteBranch: true }],
    ]);
  });

  it('records each failure and keeps going', async () => {
    const result = await runWorktreeBatchRemoval({
      targets: TARGETS,
      options: { mode: 'delete' },
      remove: (_ws, id) => {
        if (id === 'a') {
          return Promise.reject(new Error('Teardown script failed'));
        }
        // A host that rejects with something other than an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (id === 'b') return Promise.reject('not an error');
        return Promise.resolve();
      },
      blockedReasonFor: () => undefined,
      shouldStop: () => false,
    });
    expect(result.items.map((item) => [item.status, item.reason])).toEqual([
      ['failed', 'Teardown script failed'],
      ['failed', "Couldn't delete this worktree"],
      ['done', undefined],
    ]);
    expect(result.allSucceeded).toBe(false);
    expect(result.remainingKeys).toEqual(['ws/a', 'ws/b']);
  });

  it('skips a worktree that became blocked and never passes it to the host', async () => {
    const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
      () => Promise.resolve(),
    );
    const result = await runWorktreeBatchRemoval({
      targets: TARGETS,
      options: { mode: 'archive' },
      remove,
      blockedReasonFor: (t) =>
        t.key === 'ws/b' ? 'Stop all sessions before archiving' : undefined,
      shouldStop: () => false,
    });
    expect(remove.mock.calls.map((call) => call[1])).toEqual(['a', 'c']);
    expect(result.items[1]).toEqual({
      target: target('b'),
      status: 'skipped',
      reason: 'Stop all sessions before archiving',
    });
    expect(result.remainingKeys).toEqual(['ws/b']);
  });

  it('fails one item, not the batch, when its blocked check throws', async () => {
    const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
      () => Promise.resolve(),
    );
    const result = await runWorktreeBatchRemoval({
      targets: TARGETS,
      options: { mode: 'archive' },
      remove,
      blockedReasonFor: (t) => {
        if (t.key === 'ws/b') throw new Error('Session state is unavailable');
        return undefined;
      },
      shouldStop: () => false,
    });
    expect(remove.mock.calls.map((call) => call[1])).toEqual(['a', 'c']);
    expect(result.items[1]).toEqual({
      target: target('b'),
      status: 'failed',
      reason: 'Session state is unavailable',
    });
    expect(result.remainingKeys).toEqual(['ws/b']);
  });

  it('stops after the in-flight item and leaves the rest pending', async () => {
    let stop = false;
    const result = await runWorktreeBatchRemoval({
      targets: TARGETS,
      options: { mode: 'archive' },
      remove: (_ws, id) => {
        if (id === 'a') stop = true;
        return Promise.resolve();
      },
      blockedReasonFor: () => undefined,
      shouldStop: () => stop,
    });
    expect(result.items.map((item) => item.status)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
    expect(result.allSucceeded).toBe(false);
    expect(result.remainingKeys).toEqual(['ws/b', 'ws/c']);
  });

  it('reports every status change', async () => {
    const seen: string[] = [];
    await runWorktreeBatchRemoval({
      targets: [target('a')],
      options: { mode: 'archive' },
      remove: () => Promise.resolve(),
      blockedReasonFor: () => undefined,
      shouldStop: () => false,
      onItemsChange: (items) => seen.push(items[0]?.status ?? 'none'),
    });
    expect(seen).toEqual(['pending', 'running', 'done']);
  });
});

describe('useWorktreeBatchRemoval', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: WorktreeBatchRemoval | undefined;
  let renders = 0;

  function Probe({
    remove,
  }: {
    remove: RemoveWorktreeInBatch | undefined;
  }): JSX.Element {
    renders += 1;
    latest = useWorktreeBatchRemoval({
      remove,
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

  it('tracks a run, honors Stop after this one, and refuses a second start', async () => {
    const first = deferred();
    const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
      () => first.promise,
    );
    act(() => root.render(<Probe remove={remove} />));
    let run: Promise<unknown> = Promise.resolve();
    act(() => {
      run =
        latest?.start({ targets: TARGETS, options: { mode: 'archive' } }) ??
        Promise.resolve();
    });
    expect(latest?.running).toBe(true);
    expect(latest?.items.map((item) => item.status)).toEqual([
      'running',
      'pending',
      'pending',
    ]);
    await expect(
      latest?.start({ targets: TARGETS, options: { mode: 'archive' } }),
    ).resolves.toBeUndefined();

    act(() => latest?.stop());
    expect(latest?.stopRequested).toBe(true);
    await act(async () => {
      first.resolve();
      await run;
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(latest?.running).toBe(false);
    expect(latest?.items.map((item) => item.status)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
    act(() => latest?.reset());
    expect(latest?.items).toEqual([]);
    act(() => root.unmount());
  });

  it('starts no further items once the host removal goes away', async () => {
    const first = deferred();
    const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
      () => first.promise,
    );
    act(() => root.render(<Probe remove={remove} />));
    let run: Promise<unknown> = Promise.resolve();
    act(() => {
      run =
        latest?.start({ targets: TARGETS, options: { mode: 'archive' } }) ??
        Promise.resolve();
    });
    // The host can no longer send commands (web: the desktop disconnected).
    act(() => root.render(<Probe remove={undefined} />));
    await act(async () => {
      first.resolve();
      await run;
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(latest?.items.map((item) => item.status)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
    act(() => root.unmount());
  });

  it('starts nothing without a host removal', async () => {
    act(() => root.render(<Probe remove={undefined} />));
    await expect(
      latest?.start({ targets: TARGETS, options: { mode: 'archive' } }),
    ).resolves.toBeUndefined();
    act(() => root.unmount());
  });

  it('sets no state and starts no further items after unmount', async () => {
    const first = deferred();
    const remove = jest.fn<Promise<void>, Parameters<RemoveWorktreeInBatch>>(
      () => first.promise,
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    act(() => root.render(<Probe remove={remove} />));
    let run: Promise<unknown> = Promise.resolve();
    act(() => {
      run =
        latest?.start({ targets: TARGETS, options: { mode: 'archive' } }) ??
        Promise.resolve();
    });
    act(() => root.unmount());
    const rendersAtUnmount = renders;
    first.resolve();
    await run;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(renders).toBe(rendersAtUnmount);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
