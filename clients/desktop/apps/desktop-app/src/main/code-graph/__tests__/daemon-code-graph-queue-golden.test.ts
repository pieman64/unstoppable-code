/**
 * CAN-5628 migration seam: one revisioned generation queue across Electron
 * main's scheduler and the daemon's, through the real merged queue, dispatcher
 * adapter and IPC registration, over a daemon session the test drives. The
 * daemon's own stream is covered by code-graph-conformance.
 */
const mockSends: Array<{ window: unknown; channel: string; payload: unknown }> =
  [];
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (window: unknown, channel: string, payload: unknown): void => {
    mockSends.push({ window, channel, payload });
  },
}));
jest.mock('../../lib/code-graph-feature-flag', () => ({
  isCodeGraphFeatureEnabled: (): boolean => true,
}));
// Electron main's scheduler, as an in-memory queue.
const mockLocal = {
  revision: 0,
  entries: [] as Array<Record<string, unknown>>,
  listener: null as (() => void) | null,
};
const mockLocalReorder = jest.fn();
const mockLocalCancel = jest.fn<Promise<string | null>, [string]>(() =>
  Promise.resolve(null),
);
jest.mock('../build-runner', () => ({
  getCodeGraphBuildQueueStatus: (): unknown => ({
    revision: mockLocal.revision,
    entries: mockLocal.entries,
  }),
  reorderCodeGraphGenerationQueue: (request: {
    revision: number;
    orderedQueuedEntryIds: string[];
  }): unknown => {
    mockLocalReorder(request);
    if (request.revision !== mockLocal.revision)
      return { ok: false, code: 'conflict', message: 'The queue changed.' };
    const byId = new Map(mockLocal.entries.map((entry) => [entry.id, entry]));
    mockLocal.entries = request.orderedQueuedEntryIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
    mockLocal.revision += 1;
    return { revision: mockLocal.revision, entries: mockLocal.entries };
  },
  cancelCodeGraphQueueItem: (id: string): Promise<string | null> =>
    mockLocalCancel(id),
  setCodeGraphGenerationQueueListener: (
    listener: (() => void) | null,
  ): void => {
    mockLocal.listener = listener;
  },
  getCodeGraphSourceBuildState: (): string => 'idle',
  isCodeGraphSummaryRepairActive: (): boolean => false,
  requestCodeGraphSummaryRepair: (): Promise<void> =>
    Promise.reject(new Error('Unexpected repair')),
}));
// Host dependencies of the IPC module, as the route golden replaces them.
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (): Promise<never> => Promise.reject(new Error('Unexpected session')),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local' }),
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => false,
    noteFallback: (): void => undefined,
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> => Promise.resolve({ items: [] }),
}));
jest.mock('../graph-builds', () => ({
  repairWorkspaceBaseCodeGraphSummary: (): Promise<void> =>
    Promise.reject(new Error('Unexpected base repair')),
}));
jest.mock('../../lib/code-graph-base-manager', () => ({
  describeCodeGraphBaseWorkspace: (): null => null,
}));
jest.mock('../../lib/code-graph-scheduler', () => ({
  isCodeGraphPerformanceSchedulerEnabled: (): boolean => false,
  runCodeGraphPerformanceBuild: (): Promise<void> =>
    Promise.reject(new Error('Unexpected scheduling')),
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): null => null,
}));
jest.mock('../../lib/slow-action-tracker', () => ({
  trackSlowAction: (result: unknown): unknown => result,
}));

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CanopyClientError } from '@canopy/core-client';
import type { CanopyClientStreamFrame } from '@canopy/core-client';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphBuildCancelResult,
  type WorkerCodeGraphBuildQueue,
  type WorkerCodeGraphBuildQueueEventsItem,
  type WorkerCodeGraphQueueItem,
} from '@canopy/protocol/canopy-core';
import { getDaemonCodeGraphQueue } from '../../canopy-runtime/daemon-code-graph-queue';
import { createWorkerCodeGraphAdapter } from '../../canopy-runtime/worker-code-graph-adapter';
import { registerCodeGraphHandlers } from '../../ipc/code-graph';
import { getDesktopGenerationQueue } from '../merged-generation-queue';

type Frame = CanopyClientStreamFrame<
  WorkerCodeGraphBuildQueueEventsItem,
  unknown
>;
type DaemonAnswer =
  | WorkerCodeGraphBuildQueue
  | WorkerCodeGraphBuildCancelResult;

const ANY_KEY: unknown = expect.any(String);
const ANY_REVISION: unknown = expect.any(Number);
const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
let windows: BrowserWindow[] = [];

const daemonInstruction = jest.fn<
  Promise<DaemonAnswer>,
  [string, unknown, unknown]
>();
/** The connection of the daemon session the current test drives. */
let daemon: {
  emit(frame: Frame): void;
  /** Drops the connection, as a closed socket does. */
  drop(): void;
  closed: boolean;
} | null = null;
let sequence = 0;

/** The daemon session attached last; read through a call so tests can reset it. */
function attachedDaemon(): typeof daemon {
  return daemon;
}

const cursor = (): { daemonEpoch: string; sequence: number } => ({
  daemonEpoch: 'epoch',
  sequence: (sequence += 1),
});

/** Attaches a new daemon session and waits until its stream is open. */
async function attachDaemon(): Promise<void> {
  const connection = new AbortController();
  const { signal } = connection;
  let listener: ((frame: Frame) => void) | null = null;
  const pending: Frame[] = [];
  const state = {
    emit: (frame: Frame): void => {
      if (listener) listener(frame);
      else pending.push(frame);
    },
    drop: (): void => connection.abort(),
    closed: false,
  };
  function instruction(
    name: 'worker.codeGraph.buildQueue.update',
    params: unknown,
    options: unknown,
  ): Promise<WorkerCodeGraphBuildQueue>;
  function instruction(
    name: 'worker.codeGraph.build.cancel',
    params: unknown,
    options: unknown,
  ): Promise<WorkerCodeGraphBuildCancelResult>;
  function instruction(
    name: string,
    params: unknown,
    options: unknown,
  ): Promise<DaemonAnswer> {
    return daemonInstruction(name, params, options);
  }
  let opened: (name: string) => void = () => undefined;
  const open = new Promise<string>((resolve) => {
    opened = resolve;
  });
  getDaemonCodeGraphQueue().observe({
    lease: { state: 'active' },
    client: {
      signal,
      instruction,
      openStream: (name) => {
        opened(name);
        return Promise.resolve({
          requestId: 'stream',
          openResult: { subscriptionId: 'subscription', acceptedCursor: null },
          frames: {
            [Symbol.asyncIterator]: (): AsyncIterator<Frame> => ({
              next: () => Promise.resolve({ done: true, value: undefined }),
            }),
          },
          onFrame: (next: (frame: Frame) => void): (() => void) => {
            listener = next;
            for (const frame of pending.splice(0)) next(frame);
            return () => {
              listener = null;
            };
          },
          close: (): void => {
            state.closed = true;
          },
        });
      },
    },
  });
  // The daemon half follows the daemon's queue stream, never a poll.
  expect(await open).toBe('worker.codeGraph.buildQueue.events');
  await flush();
  daemon = state;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function daemonQueue(
  revision: number,
  items: WorkerCodeGraphQueueItem[],
): void {
  daemon?.emit({
    kind: 'item',
    cursor: cursor(),
    item: { queue: { revision, items } },
  });
}

function daemonItem(
  queueItemId: string,
  state: 'queued' | 'running',
): WorkerCodeGraphQueueItem {
  return {
    queueItemId,
    graphScope: 'worktree',
    workspaceIds: ['project'],
    worktreeId: queueItemId,
    repositoryId: null,
    workspaceLabel: 'Project',
    label: null,
    trigger: 'refresh',
    priority: 'worktree',
    state,
    reorderable: state === 'queued',
    enqueuedAt: '2026-11-06T00:00:00.000Z',
    startedAt: state === 'running' ? '2026-11-06T00:00:01.000Z' : null,
    timing: { queueWaitMs: 0, runningMs: state === 'running' ? 0 : null },
  };
}

function localEntry(id: string): Record<string, unknown> {
  return {
    id,
    scope: 'workspace-shadow',
    workspaceIds: ['project'],
    repositoryId: 'repo',
    trigger: 'maintenance',
    queuedAt: Date.parse('2026-11-06T00:00:00.000Z'),
    startedAt: null,
    status: 'queued',
    reorderable: true,
    priority: 'maintenance',
  };
}

function setLocal(...ids: string[]): void {
  mockLocal.entries = ids.map(localEntry);
  mockLocal.revision += 1;
  mockLocal.listener?.();
}

function invoke(channel: string, request?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  const event: IpcMainInvokeEvent = {
    sender: new BrowserWindow().webContents,
    senderFrame: null,
    frameId: 1,
    processId: 1,
    type: 'frame',
    preventDefault: () => undefined,
    defaultPrevented: false,
  };
  return Promise.resolve().then((): unknown => handler(event, request));
}

const caller = (clientInstanceId: string): CanopyCallerDescriptor => ({
  principalId: clientInstanceId,
  clientInstanceId,
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
});

/** A renderer snapshot's entry ids, in order. */
function ids(snapshot: unknown): unknown {
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !('entries' in snapshot) ||
    !Array.isArray(snapshot.entries)
  )
    return snapshot;
  return snapshot.entries.map((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'id' in entry
      ? entry.id
      : entry,
  );
}

const dispatcher = createCanopyDispatcher({
  profile: 'worker',
  definitions: {
    queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
    instructions: WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    streams: {},
  },
  handlers: {
    ...createWorkerCodeGraphAdapter(
      () =>
        Promise.resolve({
          build: () => Promise.reject(new Error('Unexpected build')),
          queueStatus: () => ({ revision: 0, entries: [] }),
          reorderQueue: () => ({ revision: 0, entries: [] }),
          cancelQueueItem: () => Promise.resolve(null),
          cancelWorktree: () => Promise.resolve(0),
        }),
      () => Promise.resolve(getDesktopGenerationQueue()),
    ),
    streams: {},
  },
});

beforeAll(() => {
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler);
  });
  windows = [new BrowserWindow(), new BrowserWindow()];
  jest.spyOn(BrowserWindow, 'getAllWindows').mockImplementation(() => windows);
  registerCodeGraphHandlers({
    dispatcher,
    resolveCaller: () => caller('window'),
  });
});
afterAll(() => {
  jest.restoreAllMocks();
});
beforeEach(() => {
  setLocal();
  daemonInstruction.mockReset();
  mockLocalReorder.mockClear();
  mockLocalCancel.mockClear();
});
afterEach(async () => {
  // Each test follows its own daemon connection; end the last one.
  daemon?.emit({
    kind: 'end',
    cursor: cursor(),
    outcome: 'completed',
    error: null,
  });
  daemon = null;
  await flush();
  mockSends.length = 0;
});

describe('merged code-graph generation queue (CAN-5628)', () => {
  it('merges local and daemon generations into one revisioned queue', async () => {
    setLocal('l1');
    await attachDaemon();
    daemonQueue(5, [
      daemonItem('d-run', 'running'),
      daemonItem('d1', 'queued'),
    ]);
    await expect(
      invoke(IPC_CHANNELS.codeGraphGetGenerationQueue).then(ids),
    ).resolves.toEqual(['d-run', 'd1', 'l1']);
    const [first, second] = await Promise.all([
      dispatcher.query(
        'worker.codeGraph.buildQueue.get',
        {},
        { caller: caller('a') },
      ),
      dispatcher.query(
        'worker.codeGraph.buildQueue.get',
        {},
        { caller: caller('b') },
      ),
    ]);
    expect(second.revision).toBe(first.revision);
    expect(second.items.map((item) => item.queueItemId)).toEqual(
      first.items.map((item) => item.queueItemId),
    );
    expect(first.items.map((item) => item.queueItemId)).toEqual([
      'd-run',
      'd1',
      'l1',
    ]);
  });

  it('broadcasts a daemon queue change to every window', async () => {
    await attachDaemon();
    daemonQueue(1, [daemonItem('d1', 'queued')]);
    await flush();
    mockSends.length = 0;
    daemonQueue(2, [daemonItem('d1', 'queued'), daemonItem('d2', 'queued')]);
    await flush();
    expect(mockSends.map((send) => send.window)).toEqual(windows);
    for (const send of mockSends) {
      expect(send.channel).toBe(IPC_CHANNELS.codeGraphGenerationQueueChanged);
      expect(ids(send.payload)).toEqual(['d1', 'd2']);
    }
    expect(mockSends.at(0)?.payload).toBe(mockSends.at(1)?.payload);
    mockSends.length = 0;
    daemonQueue(2, [daemonItem('d2', 'queued'), daemonItem('d1', 'queued')]);
    await flush();
    expect(mockSends).toEqual([]);
  });

  it("reorders each host's generations and refuses a stale revision", async () => {
    setLocal('l1');
    await attachDaemon();
    daemonQueue(7, [daemonItem('d1', 'queued'), daemonItem('d2', 'queued')]);
    const { revision } = getDesktopGenerationQueue().queue();
    daemonInstruction.mockImplementation(() =>
      Promise.resolve({
        revision: 8,
        items: [daemonItem('d2', 'queued'), daemonItem('d1', 'queued')],
      }),
    );
    const reordered = await invoke(
      IPC_CHANNELS.codeGraphReorderGenerationQueue,
      {
        revision,
        orderedQueuedEntryIds: ['d2', 'l1', 'd1'],
      },
    );
    expect(daemonInstruction).toHaveBeenCalledTimes(1);
    expect(daemonInstruction).toHaveBeenCalledWith(
      'worker.codeGraph.buildQueue.update',
      { expectedRevision: 7, orderedQueueItemIds: ['d2', 'd1'] },
      { metadata: { idempotencyKey: ANY_KEY } },
    );
    expect(mockLocalReorder).not.toHaveBeenCalled();
    expect(ids(reordered)).toEqual(['d2', 'd1', 'l1']);

    daemonInstruction.mockClear();
    await expect(
      invoke(IPC_CHANNELS.codeGraphReorderGenerationQueue, {
        revision,
        orderedQueuedEntryIds: ['d1', 'd2', 'l1'],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'conflict',
      snapshot: { revision: getDesktopGenerationQueue().queue().revision },
    });
    expect(daemonInstruction).not.toHaveBeenCalled();

    daemonInstruction.mockRejectedValue(
      new CanopyClientError({
        kind: 'conflict',
        code: 'worker.codeGraph.queueChanged',
        message: 'The generation queue changed.',
        retry: {
          kind: 'after_refresh',
          resource: 'worker.codeGraph.buildQueue',
        },
      }),
    );
    await expect(
      invoke(IPC_CHANNELS.codeGraphReorderGenerationQueue, {
        revision: getDesktopGenerationQueue().queue().revision,
        orderedQueuedEntryIds: ['d1', 'd2', 'l1'],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'conflict' });
  });

  it('answers a conflict when the daemon drops during a reorder', async () => {
    // Review fix: the reorder must not report success or a generic failure
    // when the daemon half goes away while its instruction is pending.
    setLocal('l1', 'l2');
    await attachDaemon();
    daemonQueue(9, [daemonItem('d1', 'queued'), daemonItem('d2', 'queued')]);
    const dropped = attachedDaemon();
    daemonInstruction.mockImplementation(() => {
      dropped?.drop();
      return Promise.reject(
        new CanopyClientError({
          kind: 'unavailable',
          message: 'The connection closed.',
          retry: { kind: 'same_request' },
        }),
      );
    });
    await expect(
      invoke(IPC_CHANNELS.codeGraphReorderGenerationQueue, {
        revision: getDesktopGenerationQueue().queue().revision,
        orderedQueuedEntryIds: ['d2', 'd1', 'l2', 'l1'],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'conflict' });
    expect(mockLocalReorder).not.toHaveBeenCalled();
    daemon = null;

    await attachDaemon();
    daemonQueue(1, [daemonItem('d1', 'queued'), daemonItem('d2', 'queued')]);
    const ending = attachedDaemon();
    daemonInstruction.mockImplementation(() => {
      ending?.emit({
        kind: 'end',
        cursor: cursor(),
        outcome: 'completed',
        error: null,
      });
      return Promise.resolve({
        revision: 2,
        items: [daemonItem('d2', 'queued'), daemonItem('d1', 'queued')],
      });
    });
    await expect(
      invoke(IPC_CHANNELS.codeGraphReorderGenerationQueue, {
        revision: getDesktopGenerationQueue().queue().revision,
        orderedQueuedEntryIds: ['d2', 'd1', 'l2', 'l1'],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'conflict' });
    expect(mockLocalReorder).not.toHaveBeenCalled();
    daemon = null;
  });

  it('cancels a daemon generation on the daemon', async () => {
    await attachDaemon();
    daemonQueue(3, [daemonItem('d1', 'queued')]);
    daemonInstruction.mockResolvedValue({
      queueItemId: 'd1',
      canceledState: 'queued',
    });
    await expect(
      dispatcher.instruction(
        'worker.codeGraph.build.cancel',
        { queueItemId: 'd1' },
        { caller: caller('portal'), metadata: { idempotencyKey: 'cancel-1' } },
      ),
    ).resolves.toEqual({ queueItemId: 'd1', canceledState: 'queued' });
    expect(daemonInstruction).toHaveBeenCalledWith(
      'worker.codeGraph.build.cancel',
      { queueItemId: 'd1' },
      { metadata: { idempotencyKey: ANY_KEY } },
    );
    expect(mockLocalCancel).not.toHaveBeenCalled();
    await expect(
      dispatcher.instruction(
        'worker.codeGraph.build.cancel',
        { queueItemId: 'unknown' },
        { caller: caller('portal'), metadata: { idempotencyKey: 'cancel-2' } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.codeGraph.queueItemNotFound' },
    });
  });

  it("shows Electron main's queue alone once the daemon stream ends", async () => {
    setLocal('l1', 'l2');
    await attachDaemon();
    daemonQueue(4, [daemonItem('d1', 'queued')]);
    const attached = getDesktopGenerationQueue().queue();
    expect(attached.items.map((item) => item.queueItemId)).toEqual([
      'd1',
      'l1',
      'l2',
    ]);
    daemon?.emit({
      kind: 'end',
      cursor: cursor(),
      outcome: 'completed',
      error: null,
    });
    daemon = null;
    await flush();
    const detached = await invoke(IPC_CHANNELS.codeGraphGetGenerationQueue);
    expect(ids(detached)).toEqual(['l1', 'l2']);
    expect(detached).toMatchObject({
      revision: ANY_REVISION,
    });
    const { revision } = getDesktopGenerationQueue().queue();
    expect(revision).toBeGreaterThan(attached.revision);
    // Review fix: a daemon item a stale view still shows answers
    // queueUnavailable while the daemon half is detached, not not-found.
    await expect(
      dispatcher.instruction(
        'worker.codeGraph.build.cancel',
        { queueItemId: 'd1' },
        { caller: caller('portal'), metadata: { idempotencyKey: 'cancel-3' } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.codeGraph.queueUnavailable' },
    });
    expect(mockLocalCancel).not.toHaveBeenCalled();
    expect(daemonInstruction).not.toHaveBeenCalled();
    await expect(
      invoke(IPC_CHANNELS.codeGraphReorderGenerationQueue, {
        revision,
        orderedQueuedEntryIds: ['l2', 'l1'],
      }).then(ids),
    ).resolves.toEqual(['l2', 'l1']);
    expect(mockLocalReorder).toHaveBeenCalledTimes(1);
  });
});
