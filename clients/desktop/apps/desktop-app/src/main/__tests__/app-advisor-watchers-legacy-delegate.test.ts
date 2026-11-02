import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  StoredDelegation,
  StoredDelegateOutput,
} from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { createDelegationRunState } from '@canopy/desktop-shared/node/delegation/lifecycle';
import { DelegationNoticeAckStore } from '../agents/delegation/notice-acks';
import type { LegacyDelegateWatcher } from '../agents/delegation/notice-migration';
import { migrateDelegateWatchersToNotices } from '../agents/delegation/notice-migration';
import { DelegationNoticeDelivery } from '../agents/delegation/notice-delivery';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { readCanonicalWatcherStore } from '../app-advisor/chat-watcher-storage';
import type { deliverGeneratedWatcherMessageToChat } from '../services/watcher-chat-delivery';

let mockDirectory = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getDataDir: (): string => mockDirectory,
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockDirectory, projectId, worktreeId),
  getAppAdvisorWatchersFilePath: (): string =>
    join(mockDirectory, 'watchers.json'),
}));
jest.mock('../agents/session-manager', () => ({
  getSessionManager: jest.fn(),
  getProviderAuthGeneration: (): number => 1,
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => false,
}));
jest.mock('../pipelines/pipeline-service', () => ({}));
jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual<object>('../services/background-execution-context'),
  backgroundExecutionContextEnabled: (): boolean => false,
}));
const mockDeliver = jest.fn<
  ReturnType<typeof deliverGeneratedWatcherMessageToChat>,
  Parameters<typeof deliverGeneratedWatcherMessageToChat>
>(() => Promise.resolve('submitted'));
jest.mock('../services/watcher-chat-delivery', () => ({
  deliverGeneratedWatcherMessageToChat: (
    ...args: Parameters<typeof deliverGeneratedWatcherMessageToChat>
  ): ReturnType<typeof deliverGeneratedWatcherMessageToChat> =>
    mockDeliver(...args),
}));

const scope = { projectId: 'project', worktreeId: 'worktree' };
const parent = { ...scope, chatId: 'chat' };
const result: StoredDelegateOutput = {
  runGeneration: 2,
  resultIndex: 1,
  status: 'completed',
  settledAt: 100,
  outputTruncated: false,
};
const record: StoredDelegation = {
  version: 2,
  parent: {
    ...parent,
    harnessId: 'claude',
    sessionKey: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    runtimeGeneration: 1,
    depth: 0,
  },
  task: {
    modelId: 'model',
    description: 'Upgrade delegate',
    prompt: 'Task',
    executionMode: 'background',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  },
  state: {
    ...createDelegationRunState('00000000-0000-4000-8000-000000000001', 2),
    status: 'completed',
  },
  callKey: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
  createdAt: 1,
  launch: {
    version: 1,
    delegationId: '00000000-0000-4000-8000-000000000001',
    launchKey: 'a'.repeat(64),
    runGeneration: 2,
    phase: 'settled',
    terminalStatus: 'completed',
  },
  results: [result],
  delivery: { status: 'unclaimed' },
};

/** Intentionally raw: no active watcher DTO can represent a retired kind. */
function legacy(
  id: string,
  options: {
    status?: string;
    resultIndex?: number | null;
    projectId?: string;
    worktreeId?: string;
  } = {},
): Record<string, unknown> & { target: Record<string, unknown> } {
  return {
    version: 1,
    id,
    trigger: 'managed_delegation_completion',
    status: options.status ?? 'firing',
    label: 'Delegate completion',
    target: {
      kind: 'managed_delegation',
      ...scope,
      projectId: options.projectId ?? scope.projectId,
      worktreeId: options.worktreeId ?? scope.worktreeId,
      mode: 'all',
      deadlineAt: 100,
      targetCount: 1,
      recipient: 'root',
    },
    destination: parent,
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    dedupeKey: id,
    runtimeState: {
      kind: 'managed_delegation',
      nextAttemptAt: '2000-01-01T00:00:00.000Z',
      requestHash: 'hash',
      invocationKey: id,
      recipient: { kind: 'root' },
      targets: [
        {
          delegationId: '00000000-0000-4000-8000-000000000001',
          runGeneration: 2,
          resultIndex:
            options.resultIndex === undefined ? 1 : options.resultIndex,
          status: 'completed',
        },
      ],
      pendingDelivery: {
        eventId: `event-${id}`,
        attempts: 0,
        event: {
          watcherId: id,
          outcome: 'completed',
          mode: 'all',
          deadlineAt: 100,
          targets: [
            {
              delegationId: '00000000-0000-4000-8000-000000000001',
              runGeneration: 2,
              status: 'completed',
              resultIndex: 1,
            },
          ],
        },
      },
    },
  };
}
function v1Path(): string {
  return join(mockDirectory, 'watchers.json');
}
function sidecarPath(): string {
  return join(mockDirectory, 'app-advisor-watchers-canonical.json');
}
async function seed(
  v1: readonly unknown[],
  sidecar: readonly unknown[] = [],
): Promise<void> {
  await writeFile(
    v1Path(),
    JSON.stringify({
      version: 1,
      updatedAt: '2000-01-01T00:00:00.000Z',
      watchers: v1,
    }),
  );
  await writeFile(
    sidecarPath(),
    JSON.stringify({
      version: 1,
      updatedAt: '2000-01-01T00:00:00.000Z',
      watchers: sidecar,
    }),
  );
}
async function rawV1(): Promise<{ watchers: unknown[] }> {
  const raw: unknown = JSON.parse(await readFile(v1Path(), 'utf8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('watchers' in raw) ||
    !Array.isArray(raw.watchers)
  )
    throw new Error('Expected a watcher store');
  return { watchers: raw.watchers };
}
async function unrelatedWrite(id: string): Promise<void> {
  await getAppAdvisorWatcherService().createLocalWatcher(
    {
      kind: 'scheduled_wakeup',
      delaySeconds: id === 'write-two' ? 61 : 60,
      scheduledFor: '',
    },
    { projectId: 'unrelated', worktreeId: 'unrelated', chatId: 'unrelated' },
    id,
  );
}
async function startActor(
  unavailable = false,
): Promise<DelegationNoticeAckStore> {
  // Same composition as actor startup: durable evidence -> migration -> notice delivery.
  const store = new DelegationNoticeAckStore(join(mockDirectory, 'actor'));
  await store.load();
  const watchers = getAppAdvisorWatcherService();
  await migrateDelegateWatchersToNotices({
    store,
    records: [
      {
        delegationId: '00000000-0000-4000-8000-000000000001',
        latestResultIndex: 1,
        ...(unavailable ? { resultsUnavailable: true } : { results: [result] }),
      },
    ],
    watchers: {
      list: (): Promise<LegacyDelegateWatcher[]> =>
        watchers.listLegacyDelegateWatchers(scope),
      remove: (ids): Promise<void> =>
        watchers.removeLegacyDelegateWatchers(ids),
    },
  });
  const errors: unknown[] = [];
  const delivery = new DelegationNoticeDelivery({
    store,
    records: (): Promise<readonly StoredDelegation[]> =>
      Promise.resolve([record]),
    results: (): Promise<readonly StoredDelegateOutput[]> =>
      Promise.resolve([result]),
    childMessages: {
      deliver: (): Promise<{ ok: true; value: undefined }> =>
        Promise.resolve({ ok: true, value: undefined }),
    },
    onError: (error): void => {
      errors.push(error);
    },
  });
  await delivery.start();
  const deadline = Date.now() + 2000;
  while (
    store.owed().length > 0 &&
    errors.length === 0 &&
    Date.now() < deadline
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  await delivery.close();
  expect(store.owed()).toEqual([]);
  expect(errors).toEqual([]);
  return store;
}

beforeEach(async () => {
  getAppAdvisorWatcherService().shutdown();
  await getAppAdvisorWatcherService().drain();
  mockDirectory = await mkdtemp(join(tmpdir(), 'legacy-delegate-upgrade-'));
  mockDeliver.mockClear();
});
afterEach(async () => {
  getAppAdvisorWatcherService().shutdown();
  await getAppAdvisorWatcherService().drain();
  await rm(mockDirectory, { recursive: true, force: true });
});

it('upgrades raw v1 and sidecar rows without notice-acks: one notice, physical removal, no repeat after restart', async () => {
  await seed(
    [legacy('v1')],
    [legacy('sidecar'), { kind: 'future-row', value: 'keep' }],
  );
  await expect(
    readFile(join(mockDirectory, 'actor', 'notice-acks.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await getAppAdvisorWatcherService().list()).toEqual([]);
  await expect(
    getAppAdvisorWatcherService().checkDeliveryIngress('event-v1', null),
  ).resolves.toEqual({ allowed: true });
  await startActor();
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(await rawV1()).toMatchObject({ watchers: [] });
  expect(await readCanonicalWatcherStore(sidecarPath())).toEqual([
    { kind: 'future-row', value: 'keep' },
  ]);
  getAppAdvisorWatcherService().shutdown();
  await startActor();
  expect(mockDeliver).toHaveBeenCalledTimes(1);
});
it('fired with pending delivery owes nothing', async () => {
  await seed([legacy('fired', { status: 'fired' })]);
  await startActor();
  expect(mockDeliver).not.toHaveBeenCalled();
  expect(await rawV1()).toMatchObject({ watchers: [] });
});
it('resolves a null index by generation and retries unreadable results without deleting rows', async () => {
  const raw = legacy('null', { resultIndex: null });
  await seed([raw]);
  await expect(startActor(true)).rejects.toThrow('results are unavailable');
  expect(await rawV1()).toMatchObject({ watchers: [raw] });
  await startActor();
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(mockDeliver.mock.calls[0]?.[0].hiddenContextText).toContain(
    '"resultIndex": 1',
  );
  expect(await rawV1()).toMatchObject({ watchers: [] });
});
it('retains an unstarted scope across repeated unrelated writes and completed retention overflow', async () => {
  const raw = legacy('unstarted', {
    projectId: 'not-started',
    status: 'delivery_failed',
  });
  const completed = Array.from({ length: 205 }, (_, index) => ({
    version: 1,
    id: `history-${index}`,
    trigger: 'scheduled_wakeup',
    status: 'fired',
    label: 'Wake',
    target: {
      kind: 'scheduled_wakeup',
      delaySeconds: 60,
      scheduledFor: '2020-01-01T00:00:00.000Z',
    },
    destination: parent,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    firedAt: '2020-01-01T00:00:00.000Z',
    dedupeKey: `history-${index}`,
    runtimeState: {
      kind: 'local_watcher',
      attempts: 0,
      nextAttemptAt: '2020-01-01T00:00:00.000Z',
    },
  }));
  await seed(
    [raw, ...completed],
    [legacy('sidecar-unstarted', { projectId: 'not-started' })],
  );
  await unrelatedWrite('write-one');
  await unrelatedWrite('write-two');
  expect(
    await getAppAdvisorWatcherService().listLegacyDelegateWatchers({
      ...scope,
      projectId: 'not-started',
    }),
  ).toHaveLength(2);
  expect((await rawV1()).watchers).toContainEqual(raw);
  expect(await getAppAdvisorWatcherService().list()).toHaveLength(2);
  const persisted = await rawV1();
  if (
    typeof persisted !== 'object' ||
    persisted === null ||
    !('watchers' in persisted)
  )
    throw new Error('Expected a watcher store');
  expect(persisted.watchers).toHaveLength(203);
  await startActor();
  expect(mockDeliver).not.toHaveBeenCalled();
  expect(
    await getAppAdvisorWatcherService().listLegacyDelegateWatchers({
      ...scope,
      projectId: 'not-started',
    }),
  ).toHaveLength(2);
});
it.each(['worktree', 'workspace'])(
  'removes raw rows when their %s is deleted, retaining other scopes',
  async (kind) => {
    await seed(
      [
        legacy('deleted'),
        legacy('keep', { projectId: 'other' }),
        legacy('sibling', { worktreeId: 'sibling' }),
      ],
      [legacy('deleted-sidecar')],
    );
    const watchers = getAppAdvisorWatcherService();
    if (kind === 'worktree')
      await watchers.commitLocalScopeCancellation(
        scope.projectId,
        scope.worktreeId,
      );
    else await watchers.commitLocalWorkspaceCancellation(scope.projectId);
    expect(await watchers.listLegacyDelegateWatchers(scope)).toEqual([]);
    expect(await rawV1()).toEqual(
      expect.objectContaining({
        watchers: [
          legacy('keep', { projectId: 'other' }),
          ...(kind === 'worktree'
            ? [legacy('sibling', { worktreeId: 'sibling' })]
            : []),
        ],
      }),
    );
    expect(await readCanonicalWatcherStore(sidecarPath())).toEqual([]);
  },
);

it('SearchWatchers omits delegate completion', async () => {
  const service = getAppAdvisorWatcherService();
  const search = await service.search({}, parent);
  expect(search.catalog.map((row) => row.trigger)).not.toContain(
    'managed_delegation_completion',
  );
});
it('SetupWatchers rejects the raw legacy trigger as unsupported', async () => {
  const service = getAppAdvisorWatcherService();
  const setup: unknown = Reflect.get(service, 'setup');
  if (typeof setup !== 'function') throw new Error('Missing setup');
  const response: unknown = await Reflect.apply(setup, service, [
    {
      watchers: [
        {
          trigger: 'managed_delegation_completion',
          target: legacy('request').target,
        },
      ],
    },
    parent,
  ]);
  expect(response).toMatchObject({
    ok: false,
    error: 'Unsupported watcher trigger: managed_delegation_completion',
  });
});

it('real actor startup migrates a pre-feature catalog once, without eagerly starting other scopes', async () => {
  const { createManagedDelegationSession } =
    await import('../agents/delegation/service');
  const { closeDelegationScope } =
    await import('../agents/delegation/lifecycle');
  const directory = join(
    mockDirectory,
    scope.projectId,
    scope.worktreeId,
    'delegation',
  );
  const storage = new FileDelegationStorage(join(directory, 'runs'));
  await storage.commit(record);
  expect(await storage.load()).toHaveLength(1);
  await seed(
    [legacy('actor-v1'), legacy('unstarted', { projectId: 'not-started' })],
    [legacy('actor-sidecar')],
  );
  await expect(
    readFile(join(directory, 'notice-acks.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const start = (): ReturnType<typeof createManagedDelegationSession> =>
    createManagedDelegationSession({
      harness: 'claude',
      sessionKey: 'project/worktree/chat',
      currentOptions: () => ({
        ...parent,
        cwd: mockDirectory,
        approvalMode: 'full-access',
      }),
      currentTurn: () => 'turn',
      getWindow: () => null,
    });
  const first = await start();
  try {
    const deadline = Date.now() + 2000;
    while (mockDeliver.mock.calls.length === 0 && Date.now() < deadline)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect((await rawV1()).watchers).toEqual([
      legacy('unstarted', { projectId: 'not-started' }),
    ]);
    expect(await readCanonicalWatcherStore(sidecarPath())).toEqual([]);
  } finally {
    first.detach();
    await closeDelegationScope(scope);
  }
  const second = await start();
  second.detach();
  await closeDelegationScope(scope);
  expect(mockDeliver).toHaveBeenCalledTimes(1);
});
