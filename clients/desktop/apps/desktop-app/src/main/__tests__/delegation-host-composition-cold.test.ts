import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  rename,
  mkdir,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AppAdvisorWindowState,
  ChatWindowCommand,
} from '@canopy/desktop-shared/types';
import type { WatcherChatDelivery } from '../services/watcher-chat-delivery';
import type { WindowAccessors } from '../ipc';
import type { AppAdvisorWatcherSurfaces } from '../app-advisor/watchers';
import type { openBacking } from './helpers/delegation-two-scope-backing';

jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual<object>('../services/background-execution-context'),
  backgroundExecutionContextEnabled: (): boolean => false,
}));

// Watcher deliveries go through the chat delivery service; record them as
// the window commands this test reads.
let mockWatcherDeliverySink: ((command: ChatWindowCommand) => void) | undefined;
jest.mock('../services/watcher-chat-delivery', () => ({
  ...jest.requireActual<object>('../services/watcher-chat-delivery'),
  deliverWatcherMessageToChat: (
    delivery: WatcherChatDelivery,
  ): Promise<'submitted'> => {
    const command: ChatWindowCommand = {
      ...delivery,
      type: 'send_watcher_message',
    };
    mockWatcherDeliverySink?.(command);
    return Promise.resolve('submitted');
  },
}));

let mockRoot = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockRoot, projectId, worktreeId),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));

function windowState(): AppAdvisorWindowState {
  return { open: false, focused: false };
}
function accessors(
  sendChatWindowCommand: (command: ChatWindowCommand) => boolean = () => true,
): WindowAccessors & AppAdvisorWatcherSurfaces {
  return {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: () => Promise.resolve(windowState()),
    ensureAppAdvisorWindow: () => Promise.resolve(windowState()),
    closeAppAdvisorWindow: () => Promise.resolve(windowState()),
    toggleAppAdvisorWindow: () => Promise.resolve(windowState()),
    getAppAdvisorWindowState: windowState,
    markAppAdvisorWindowRendererReady: windowState,
    setAppAdvisorFloatingSize: windowState,
    sendAppAdvisorWindowCommand: () => undefined,
    sendChatWindowCommand,
    deliverWatcherMessage: (
      delivery: Parameters<
        AppAdvisorWatcherSurfaces['deliverWatcherMessage']
      >[0],
    ): ReturnType<AppAdvisorWatcherSurfaces['deliverWatcherMessage']> =>
      import('../services/watcher-chat-delivery').then(
        ({ deliverWatcherMessageToChat }) =>
          deliverWatcherMessageToChat(delivery),
      ),
    notifyStartupUnlocked: () => undefined,
  };
}
async function coldBacking(): Promise<ReturnType<typeof openBacking>> {
  const previous = await import('../services/chat-state-service');
  await previous.getChatStateService().drain();
  previous.resetChatStateServiceForTests();
  jest.resetModules();
  const helper = await import('./helpers/delegation-two-scope-backing');
  const backing = helper.openBacking(mockRoot);
  const singleton = await import('../services/chat-state-service');
  singleton.resetChatStateServiceForTests(backing.service);
  return backing;
}
async function noActors(): Promise<() => void> {
  const { AgentDelegationBroker } =
    await import('@canopy/desktop-shared/node/delegation/broker');
  const sessions = await import('../agents/session-manager');
  const { AgentRunnerRegistry } =
    await import('@canopy/desktop-shared/node/delegation/runner-registry');
  const runners = jest
    .spyOn(AgentRunnerRegistry.prototype, 'register')
    .mockImplementation(() => {
      throw new Error('Cold read registered a runner');
    });
  const broker = jest
    .spyOn(AgentDelegationBroker.prototype, 'initialize')
    .mockImplementation(() => {
      throw new Error('Cold read created a broker');
    });
  const actor = jest
    .spyOn(sessions, 'getOrCreateSession')
    .mockImplementation(() => {
      throw new Error('Cold read created a session');
    });
  return (): void => {
    expect(broker).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
    expect(runners).not.toHaveBeenCalled();
  };
}

describe('cold production-default delegation host composition', () => {
  let previousDataDir: string | undefined;
  beforeEach(async () => {
    jest.resetModules();
    mockRoot = await mkdtemp(join(tmpdir(), 'host-composition-cold-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(mockRoot, 'data');
    const { resetResolvedCanopyDataDirForTests } =
      await import('@canopy/desktop-shared/canopy-paths');
    resetResolvedCanopyDataDirForTests();
  });
  afterEach(async () => {
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    const watchers = getAppAdvisorWatcherService();
    watchers.shutdown();
    await watchers.drain();
    jest.restoreAllMocks();
    jest.useRealTimers();
    const singleton = await import('../services/chat-state-service');
    await singleton.getChatStateService().drain();
    singleton.resetChatStateServiceForTests();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    await rm(mockRoot, { recursive: true, force: true });
  });

  it.each(['A then B', 'B then A', 'concurrent'])(
    'cold reads isolate colliding scopes: %s',
    async (schedule) => {
      const writer = await import('./helpers/delegation-two-scope-backing');
      await writer.seedBacking(mockRoot);
      const backing = await coldBacking();
      const helper = await import('./helpers/delegation-two-scope-backing');
      const assertNoActors = await noActors();
      const service = await import('../agents/delegation/service');
      const advisor = await import('../app-advisor/delegation-read-actions');
      const { TranscriptStreamStore } =
        await import('../lib/chat-transcript-log');
      const sequenceRows = jest
        .spyOn(TranscriptStreamStore.prototype, 'childStreamSequenceEntries')
        .mockImplementation(() => {
          throw new Error('Metadata read child sequences');
        });
      const pointRows = jest
        .spyOn(TranscriptStreamStore.prototype, 'childStreamRowById')
        .mockImplementation(() => {
          throw new Error('Metadata read child row');
        });
      const childRows = jest
        .spyOn(backing.repository, 'childStreamCompatibilityPage')
        .mockImplementation(() => {
          throw new Error('Metadata hydrated child rows');
        });
      const answers = jest
        .spyOn(backing.repository, 'resultAnswerRange')
        .mockImplementation(() => {
          throw new Error('Metadata hydrated answer');
        });
      const order =
        schedule === 'B then A' ? [...helper.scopes].reverse() : helper.scopes;
      const read = async (
        scope: (typeof helper.scopes)[number],
      ): Promise<void> => {
        const name = helper.label(scope);
        const roots = await service.readManagedDelegationRootsForUser(scope);
        expect(roots).toEqual([
          expect.objectContaining({
            chatId: helper.chatId,
            total: 1,
            live: 0,
            lastActivityAt: name === 'A' ? 100_000 : 200_000,
          }),
        ]);
        const tree = await service.readManagedDelegationTreeForUser({
          ...scope,
          chatId: helper.chatId,
        });
        expect(tree).toHaveLength(3);
        expect(tree.find((entry) => entry.runGeneration === 3)).toMatchObject({
          runGeneration: 3,
          description: `${name} stored task 3`,
          prompt: `${name} stored prompt 3`,
          runSettledAt: (name === 'A' ? 10000 : 20000) + 3,
          snapshot: {
            status: name === 'A' ? 'completed' : 'failed',
            resultIndex: name === 'A' ? 2 : 3,
          },
        });
        expect(tree.find((entry) => entry.runGeneration === 4)).toMatchObject({
          runGeneration: 4,
          description: `${name} stored task 4`,
          prompt: `${name} stored prompt 4`,
          runSettledAt: (name === 'A' ? 10000 : 20000) + 4,
          snapshot: {
            status: name === 'A' ? 'completed' : 'failed',
            resultIndex: name === 'A' ? 3 : 4,
          },
        });
        const action = await advisor.dispatchDelegationReadAction({
          type: 'delegation.tree',
          ...scope,
          chatId: helper.chatId,
        });
        expect(action).toEqual({ ok: true, result: tree });
        expect(JSON.stringify(tree)).not.toContain(
          `${name === 'A' ? 'B' : 'A'} stored task`,
        );
        expect(
          JSON.stringify(tree.filter((entry) => entry.runGeneration > 2)),
        ).not.toContain('stale record task');
      };
      if (schedule === 'concurrent') await Promise.all(order.map(read));
      else for (const scope of order) await read(scope);
      expect(childRows).not.toHaveBeenCalled();
      expect(answers).not.toHaveBeenCalled();
      expect(sequenceRows).not.toHaveBeenCalled();
      expect(pointRows).not.toHaveBeenCalled();
      childRows.mockRestore();
      sequenceRows.mockRestore();
      pointRows.mockRestore();
      const transcript = async (
        scope: (typeof helper.scopes)[number],
      ): Promise<void> => {
        const page = await service.readManagedDelegationTranscriptForUser({
          ...scope,
          chatId: helper.chatId,
          delegationId: helper.delegationId,
          limit: 1,
        });
        expect(page).toMatchObject({
          ok: true,
          runGeneration: 4,
          hasMore: true,
          task: { description: `${helper.label(scope)} stored task 4` },
        });
        if (!page.ok) throw new Error('Expected stream page');
        expect(page.items).toHaveLength(1);
        expect(JSON.stringify(page.items)).toContain(
          `${helper.label(scope)} answer 3`,
        );
        const middle = await service.readManagedDelegationTranscriptForUser({
          ...scope,
          chatId: helper.chatId,
          delegationId: helper.delegationId,
          limit: 1,
          beforeSequence: page.items[0]?.sequence,
        });
        expect(middle).toMatchObject({
          ok: true,
          hasMore: true,
          items: [
            expect.objectContaining({
              text: `${helper.label(scope)} answer 2`,
            }),
          ],
        });
        if (!middle.ok) throw new Error('Missing middle page');
        const oldest = await service.readManagedDelegationTranscriptForUser({
          ...scope,
          chatId: helper.chatId,
          delegationId: helper.delegationId,
          limit: 1,
          beforeSequence: middle.items[0]?.sequence,
        });
        expect(oldest).toMatchObject({
          ok: true,
          hasMore: false,
          items: [
            expect.objectContaining({
              text: `${helper.label(scope)} answer 1`,
            }),
          ],
        });
        await expect(
          service.readManagedDelegationTranscriptForUser({
            ...scope,
            chatId: helper.chatId,
            delegationId: helper.delegationId,
            sinceRevision: page.revision,
          }),
        ).resolves.toMatchObject({ ok: true, unchanged: true, items: [] });
      };
      if (schedule === 'concurrent') await Promise.all(order.map(transcript));
      else for (const scope of order) await transcript(scope);
      assertNoActors();
      await backing.service.drain();
    },
    60_000,
  );

  it('an unavailable cold read in A does not affect B', async () => {
    const helper = await import('./helpers/delegation-two-scope-backing');
    await helper.seedBacking(mockRoot);
    const [first, second] = helper.scopes;
    if (!first || !second) throw new Error('Missing scopes');
    const manifest = join(
      helper.directory(mockRoot, first),
      'chat-storage-manifests',
      `${first.worktreeId}.json`,
    );
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    const backing = await coldBacking();
    const assertNoActors = await noActors();
    const service = await import('../agents/delegation/service');
    try {
      await expect(
        service.readManagedDelegationTreeForUser({
          ...first,
          chatId: helper.chatId,
        }),
      ).rejects.toThrow();
      const tree = await service.readManagedDelegationTreeForUser({
        ...second,
        chatId: helper.chatId,
      });
      expect(tree.find((entry) => entry.runGeneration === 4)).toMatchObject({
        runGeneration: 4,
        description: 'B stored task 4',
        snapshot: { status: 'failed', resultIndex: 4 },
      });
      const page = await service.readManagedDelegationTranscriptForUser({
        ...second,
        chatId: helper.chatId,
        delegationId: helper.delegationId,
        limit: 1,
      });
      expect(page).toMatchObject({
        ok: true,
        items: [expect.objectContaining({ text: 'B answer 3' })],
      });
      assertNoActors();
    } finally {
      await rmdir(manifest);
      await rename(`${manifest}.saved`, manifest);
      await backing.service.drain();
    }
  }, 60_000);

  async function coldWatchProof(
    mode: 'normal' | 'unavailable' | 'legacy',
  ): Promise<void> {
    const helper = await import('./helpers/delegation-two-scope-backing');
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    const writer = getAppAdvisorWatcherService();
    writer.configure(accessors(), { deferStartupRecovery: true });
    const capturedGeneration = mode === 'legacy' ? 2 : 3;
    await helper.seedBacking(mockRoot);
    const { getAppAdvisorWatchersFilePath } = await import('../lib/paths');
    const legacyRows = helper.scopes.map((scope) => ({
      id: `legacy-${helper.label(scope)}`,
      trigger: 'managed_delegation_completion',
      status: 'active',
      target: {
        kind: 'managed_delegation',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
      },
      runtimeState: {
        kind: 'managed_delegation',
        targets: [
          {
            delegationId: helper.delegationId,
            runGeneration: capturedGeneration,
            resultIndex: null,
          },
        ],
      },
    }));
    await mkdir(dirname(getAppAdvisorWatchersFilePath()), { recursive: true });
    await writeFile(
      getAppAdvisorWatchersFilePath(),
      JSON.stringify({ version: 1, watchers: legacyRows }),
    );
    writer.shutdown();
    await writer.drain();
    const first = helper.scopes[0];
    if (!first) throw new Error('Missing first scope');
    const manifest = join(
      helper.directory(mockRoot, first),
      'chat-storage-manifests',
      `${first.worktreeId}.json`,
    );
    if (mode === 'unavailable') {
      await rename(manifest, `${manifest}.saved`);
      await mkdir(manifest);
    }
    const backing = await coldBacking();
    const assertNoActors = await noActors();
    const { getAppAdvisorWatcherService: freshSingleton } =
      await import('../app-advisor/watchers');
    const { LocalWatcherScheduler } =
      await import('../app-advisor/local-watcher-scheduler');
    const rescans = jest.spyOn(LocalWatcherScheduler.prototype, 'rescan');
    const watcher = freshSingleton();
    const reconciliation = jest.spyOn(watcher, 'reconcileAtStartup');
    const generation = jest.spyOn(backing.service, 'generation');
    const result = jest.spyOn(backing.service, 'resultByGeneration');
    const { TranscriptStreamStore } =
      await import('../lib/chat-transcript-log');
    const sequenceRows = jest
      .spyOn(TranscriptStreamStore.prototype, 'childStreamSequenceEntries')
      .mockImplementation(() => {
        throw new Error('Watch hydrated descriptor rows');
      });
    const pointRows = jest
      .spyOn(TranscriptStreamStore.prototype, 'childStreamRowById')
      .mockImplementation(() => {
        throw new Error('Watch hydrated child row');
      });
    const rows = jest
      .spyOn(backing.repository, 'childStreamCompatibilityPage')
      .mockImplementation(() => {
        throw new Error('Watch hydrated child rows');
      });
    const answers = jest
      .spyOn(backing.repository, 'resultAnswerRange')
      .mockImplementation(() => {
        throw new Error('Watch hydrated answer');
      });
    const events: ChatWindowCommand[] = [];
    mockWatcherDeliverySink = (command): void => {
      events.push(command);
    };
    const { registerAppAdvisorWatcherHandlers } =
      await import('../ipc/app-advisor-watchers');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    registerAppAdvisorWatcherHandlers(
      accessors((command) => {
        events.push(command);
        if (command.type === 'send_watcher_message')
          watcher.acknowledgeWatcherMessageDelivery(
            command.watcherId,
            command.deliveryId,
            { ok: true },
          );
        return true;
      }),
    );
    expect(reconciliation).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    expect(rescans).not.toHaveBeenCalled();
    expect(await watcher.list()).toEqual([]);
    // Startup must not evaluate, deliver, or hydrate retired watcher rows.
    await watcher.reconcileAtStartup();
    await watcher.drain();
    expect(events).toEqual([]);
    expect(generation).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    const file: unknown = JSON.parse(
      await readFile(getAppAdvisorWatchersFilePath(), 'utf8'),
    );
    expect(file).toMatchObject({ watchers: legacyRows });
    for (const scope of helper.scopes)
      expect(await watcher.listLegacyDelegateWatchers(scope)).toEqual([
        {
          id: `legacy-${helper.label(scope)}`,
          delivered: false,
          targets: [
            {
              delegationId: helper.delegationId,
              runGeneration: capturedGeneration,
              resultIndex: null,
            },
          ],
        },
      ]);
    if (mode === 'unavailable') {
      await rmdir(manifest);
      await rename(`${manifest}.saved`, manifest);
    }
    expect(rows).not.toHaveBeenCalled();
    expect(answers).not.toHaveBeenCalled();
    expect(sequenceRows).not.toHaveBeenCalled();
    expect(pointRows).not.toHaveBeenCalled();
    expect(
      (await watcher.list()).filter((entry) => entry.status === 'active'),
    ).toHaveLength(0);
    assertNoActors();
    watcher.shutdown();
    await watcher.drain();
    await backing.service.drain();
  }

  it(
    'cold first-configure leaves raw legacy watches in colliding scopes migration-only',
    () => coldWatchProof('normal'),
    60_000,
  );
  it(
    'cold reconciliation retains raw watches without reading an unavailable scope',
    () => coldWatchProof('unavailable'),
    60_000,
  );
  it(
    'cold raw legacy-prefix watches bypass the stream reader',
    () => coldWatchProof('legacy'),
    60_000,
  );

  it('installing default composition leaves broker writes legacy and creates no registry entries', async () => {
    const helper = await import('./helpers/delegation-two-scope-backing');
    const first = helper.scopes[0];
    if (!first) throw new Error('Missing scope');
    const service = await import('../agents/delegation/service');
    const { FileDelegationStorage } =
      await import('@canopy/desktop-shared/node/delegation/storage');
    const storage = new FileDelegationStorage(
      join(helper.directory(mockRoot, first), 'delegation', 'runs'),
    );
    expect(await service.readManagedDelegationRootsForUser(first)).toEqual([]);
    expect(await storage.load()).toEqual([]);
    const commits = await helper.seedLegacyOnly(mockRoot, first);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((version) => version === 1 || version === 2)).toBe(
      true,
    );
    const backing = await coldBacking();
    const { registerAppAdvisorWatcherHandlers } =
      await import('../ipc/app-advisor-watchers');
    registerAppAdvisorWatcherHandlers(accessors());
    const records = await storage.load();
    expect(records).toHaveLength(1);
    for (const record of records) {
      const page = await backing.service.generationsPage(first, {
        chatId: helper.chatId,
        delegationId: record.state.delegationId,
        limit: 20,
      });
      expect(page.generations).toEqual([]);
    }
    expect((await storage.load()).every((record) => record.version !== 3)).toBe(
      true,
    );
    await backing.service.drain();
  }, 60_000);

  it('default repository opens a format 4 scope', async () => {
    const helper = await import('./helpers/delegation-two-scope-backing');
    await helper.seedBacking(mockRoot);
    jest.resetModules();
    const { ChatStateV2Repository } =
      await import('../services/chat-state-v2-repository');
    const repository = new ChatStateV2Repository({
      resolvePaths: (scope): ReturnType<typeof helper.paths> =>
        helper.paths(mockRoot, scope),
    });
    const first = helper.scopes[0];
    if (!first) throw new Error('Missing scope');
    // Production reads format 4 since phase 14; version 5 is refused elsewhere.
    await expect(repository.getState(first)).resolves.toMatchObject({
      tabsFile: { activeTabId: 'colliding-chat' },
    });
    await repository.drainAll().catch(() => undefined);
  }, 60_000);
});
