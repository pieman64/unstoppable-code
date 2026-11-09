import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { createCoreCoworkStore } from '../create-core-cowork-store';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '../invoker';

// A fake web core shaped like the CAN-4185 contract: `core.workspace.list`,
// `core.chat.task.list` per cowork project, and one `core.chat.task.events`
// stream whose frames the test pushes.

const PROJECT = '11111111-1111-4111-8111-111111111111';
const EPOCH = 'feed';

interface FakeTask {
  worktreeId: string;
  title: string;
  updatedAt: string;
}

class FakeStream implements CoreCoworkStream {
  private readonly frames: unknown[] = [];
  private waiter: ((frame: unknown) => void) | null = null;
  closed = false;

  push(frame: unknown): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(frame);
    } else this.frames.push(frame);
  }

  item(sequence: number, item: unknown): void {
    this.push({
      kind: 'item',
      cursor: { daemonEpoch: EPOCH, sequence },
      item,
    });
  }

  next(): Promise<{ done: true } | { done: false; value: unknown }> {
    if (this.closed) return Promise.resolve({ done: true });
    const queued = this.frames.shift();
    if (queued !== undefined)
      return Promise.resolve({ done: false, value: queued });
    return new Promise((resolve) => {
      this.waiter = (value): void => resolve({ done: false, value });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeWebCore implements CoreCoworkInvoker {
  tasks: FakeTask[] = [
    { worktreeId: 'task-1', title: 'First', updatedAt: '2026-11-07T10:00:00Z' },
  ];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly streams: FakeStream[] = [];
  readonly streamParams: Record<string, unknown>[] = [];
  hold: Promise<void> | null = null;
  /** Each held `core.chat.task.list` answers with the tasks as of its call. */
  readonly taskListHolds: Promise<void>[] = [];
  /** Refusals for the next opens that resume from a cursor. */
  readonly resumeRefusals: CanopyErrorPayload[] = [];
  projectName = 'Research';

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply> {
    this.calls.push({ method, params });
    if (this.hold) await this.hold;
    if (method === 'core.workspace.list')
      return {
        ok: true,
        value: {
          items: [
            {
              workspaceId: PROJECT,
              name: this.projectName,
              kind: 'cowork',
              ownerOrganizationId: null,
              repositorySources: [],
              settings: {},
            },
            {
              workspaceId: '22222222-2222-4222-8222-222222222222',
              name: 'Repo',
              kind: 'git',
              ownerOrganizationId: null,
              repositorySources: [],
              settings: {},
            },
          ],
          nextCursor: null,
        },
      };
    if (method === 'core.chat.task.list') {
      const tasks = this.tasks;
      const held = this.taskListHolds.shift();
      if (held) await held;
      return {
        ok: true,
        value: {
          items: tasks.map((task) => ({
            workspaceId: PROJECT,
            worktreeId: task.worktreeId,
            title: task.title,
            state: 'idle',
            updatedAt: task.updatedAt,
            revision: 1,
          })),
          nextCursor: null,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: method,
        retry: { kind: 'never' },
      },
    };
  }

  openStream(
    _method: string,
    params: Record<string, unknown>,
  ): Promise<CoreCoworkStream> {
    const refusal = params.cursor ? this.resumeRefusals.shift() : undefined;
    if (refusal) return Promise.reject(new CoreCoworkRequestError(refusal));
    const stream = new FakeStream();
    this.streams.push(stream);
    this.streamParams.push(params);
    return Promise.resolve(stream);
  }

  get stream(): FakeStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('No stream is open.');
    return stream;
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

const taskTitles = (
  store: ReturnType<typeof createCoreCoworkStore>,
): string[] =>
  (store.getState().tasksByProject[`web-core:${PROJECT}`] ?? []).map(
    (task) => task.title,
  );

async function connected(
  core: FakeWebCore,
): Promise<ReturnType<typeof createCoreCoworkStore>> {
  const store = createCoreCoworkStore();
  await store.getState().connect(core);
  expect(store.getState().status).toBe('online');
  return store;
}

describe('core cowork store', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('going offline clears every project, task and thread', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    expect(store.getState().projects.map((p) => p.key)).toEqual([
      `web-core:${PROJECT}`,
    ]);
    expect(taskTitles(store)).toEqual(['First']);

    core.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 0 },
      outcome: 'error',
      error: { kind: 'unavailable', message: 'gone', retry: { kind: 'never' } },
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(store.getState()).toMatchObject({
      status: 'offline',
      projects: [],
      tasksByProject: {},
    });
    expect(core.stream.closed).toBe(true);
  });

  it('a reply from an earlier generation is dropped', async () => {
    const earlier = new FakeWebCore();
    let release = (): void => undefined;
    earlier.hold = new Promise((resolve) => {
      release = resolve;
    });
    earlier.projectName = 'Old account project';
    earlier.tasks = [
      {
        worktreeId: 'old',
        title: 'Old account',
        updatedAt: '2026-11-07T09:00:00Z',
      },
    ];
    const store = createCoreCoworkStore();
    const first = store.getState().connect(earlier);
    await jest.advanceTimersByTimeAsync(0);

    const current = new FakeWebCore();
    await store.getState().connect(current);
    release();
    await first;
    await jest.advanceTimersByTimeAsync(0);

    expect(store.getState().status).toBe('online');
    expect(store.getState().projects.map((p) => p.name)).toEqual(['Research']);
    expect(taskTitles(store)).toEqual(['First']);
    expect(earlier.stream.closed).toBe(true);
  });

  it('snapshotRequired re-lists the scope', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(3, { kind: 'resync' });
    core.tasks = [
      ...core.tasks,
      {
        worktreeId: 'task-2',
        title: 'Second',
        updatedAt: '2026-11-07T11:00:00Z',
      },
    ];

    core.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 3 },
      outcome: 'error',
      error: {
        kind: 'failed_precondition',
        code: 'core.chat.snapshotRequired',
        message: 'stale cursor',
        retry: { kind: 'after_refresh', resource: 'core.chat.task.list' },
      },
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(core.count('core.workspace.list')).toBe(2);
    expect(core.streamParams.at(-1)).toEqual({ scope: 'all', cursor: null });
    expect(taskTitles(store)).toEqual(['Second', 'First']);
    expect(store.getState().status).toBe('online');
  });

  it('a task item for a new task adds its sidebar row without a reload', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(1, { kind: 'resync' });
    await jest.advanceTimersByTimeAsync(0);

    core.tasks = [
      {
        worktreeId: 'task-2',
        title: 'From the web',
        updatedAt: '2026-11-07T12:00:00Z',
      },
      ...core.tasks,
    ];
    core.stream.item(2, {
      kind: 'task',
      workspaceId: PROJECT,
      worktreeId: 'task-2',
      batchId: '2',
    });
    await jest.advanceTimersByTimeAsync(250);

    expect(taskTitles(store)).toEqual(['From the web', 'First']);
    expect(core.count('core.workspace.list')).toBe(1);
    expect(core.streams).toHaveLength(1);
  });

  it('an item at or below the applied cursor is ignored', async () => {
    const core = new FakeWebCore();
    await connected(core);
    const item = {
      kind: 'task',
      workspaceId: PROJECT,
      worktreeId: 'task-1',
      batchId: '5',
    };
    core.stream.item(5, item);
    await jest.advanceTimersByTimeAsync(250);
    const reads = core.count('core.chat.task.list');

    core.stream.item(5, item);
    core.stream.item(4, { ...item, batchId: '4' });
    await jest.advanceTimersByTimeAsync(250);

    expect(core.count('core.chat.task.list')).toBe(reads);
  });
  it('an older task re-read never overwrites a newer one', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(1, { kind: 'resync' });
    const item = { kind: 'task', workspaceId: PROJECT, worktreeId: 'task-1' };

    let releaseOlder = (): void => undefined;
    core.taskListHolds.push(
      new Promise((resolve) => {
        releaseOlder = resolve;
      }),
    );
    core.tasks = [
      {
        worktreeId: 'task-1',
        title: 'Older',
        updatedAt: '2026-11-07T10:01:00Z',
      },
    ];
    core.stream.item(2, { ...item, batchId: '2' });
    await jest.advanceTimersByTimeAsync(250);

    core.tasks = [
      {
        worktreeId: 'task-1',
        title: 'Newer',
        updatedAt: '2026-11-07T10:02:00Z',
      },
    ];
    core.stream.item(3, { ...item, batchId: '3' });
    await jest.advanceTimersByTimeAsync(250);
    releaseOlder();
    await jest.advanceTimersByTimeAsync(0);

    expect(taskTitles(store)).toEqual(['Newer']);
  });

  it('a snapshotRequired reopen after a clean end re-lists instead of going offline', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(1, { kind: 'resync' });
    await jest.advanceTimersByTimeAsync(0);
    core.resumeRefusals.push({
      kind: 'failed_precondition',
      code: 'core.chat.snapshotRequired',
      message: 'stale cursor',
      retry: { kind: 'after_refresh', resource: 'core.chat.task.list' },
    });
    core.tasks = [
      ...core.tasks,
      {
        worktreeId: 'task-2',
        title: 'Second',
        updatedAt: '2026-11-07T11:00:00Z',
      },
    ];

    core.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 1 },
      outcome: 'completed',
      error: null,
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(store.getState().status).toBe('online');
    expect(core.streamParams.at(-1)).toEqual({ scope: 'all', cursor: null });
    expect(taskTitles(store)).toEqual(['Second', 'First']);
  });

  it('a disconnect during the first listing keeps the store offline', async () => {
    const core = new FakeWebCore();
    const store = createCoreCoworkStore();
    // A listener that leaves as soon as the first listing lands.
    const unsubscribe = store.subscribe((state) => {
      if (state.projects.length > 0) store.getState().disconnect('offline');
    });
    await store.getState().connect(core);
    unsubscribe();

    expect(store.getState()).toMatchObject({
      status: 'offline',
      projects: [],
      tasksByProject: {},
    });
  });
});
