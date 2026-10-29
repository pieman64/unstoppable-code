import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { AgentDelegationBroker } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  baseTask,
  createBrokerHarness,
  emit,
  flushBroker,
  rootParent,
  waitForLaunch,
} from '@canopy/desktop-shared/node/delegation/__tests__/broker-harness';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import {
  createManagedDelegationSession,
  messageManagedDelegationForUser,
  readManagedDelegationRootsForUser,
  readManagedDelegationTranscriptForUser,
  readManagedDelegationTreeForUser,
  readManagedDelegationWorktreeSummaryForUser,
  shutdownManagedDelegations,
} from '../service';

let mockDataRoot = '';
jest.mock('../../../lib/paths', () => ({
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    path.join(mockDataRoot, projectId, worktreeId),
}));
jest.mock('../../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../../../services/chat-state-service', () => ({
  getChatStateService: (): { subscribe: () => () => void } => ({
    subscribe: (): (() => void) => () => undefined,
  }),
}));

const scope = {
  projectId: 'user-operation-project',
  worktreeId: 'user-operation-worktree',
  chatId: 'user-operation-chat',
  cwd: '/test/worktree',
};

describe('managed delegation viewer user operations', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'delegation-user-ops-'));
    mockDataRoot = directory;
  });

  afterAll(async () => {
    await shutdownManagedDelegations();
    await rm(directory, { recursive: true, force: true });
  });

  it('durably replays parent-unavailable, attributes live broker calls to the user, and rejects UUID argument changes', async () => {
    const retainedStorage = new FileDelegationStorage(
      path.join(
        mockDataRoot,
        scope.projectId,
        scope.worktreeId,
        'delegation',
        'runs',
      ),
    );
    const retainedBroker = createBrokerHarness({}, retainedStorage);
    await retainedBroker.broker.initialize();
    const retainedParent = {
      ...rootParent,
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: scope.chatId,
      sessionKey: `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`,
    };
    const retained = await retainedBroker.broker.spawn(
      retainedParent,
      baseTask,
    );
    if (!retained.ok) throw new Error('Expected a retained delegation');
    await flushBroker();
    await waitForLaunch(retainedBroker.runner, retained.value.delegationId);
    await emit(retainedBroker.runner, retained.value.delegationId, 1, {
      type: 'started',
      nativeSessionId: 'parent-unavailable-session',
    });
    await emit(retainedBroker.runner, retained.value.delegationId, 2, {
      type: 'terminal',
      status: 'completed',
    });
    await flushBroker();
    await retainedBroker.broker.close();

    const unavailableRequest = {
      ...scope,
      delegationId: retained.value.delegationId,
      operation: 'follow_up' as const,
      message: 'Please review the edge case.',
      operationId: randomUUID(),
    };
    const firstUnavailable =
      await messageManagedDelegationForUser(unavailableRequest);
    expect(firstUnavailable).toMatchObject({
      ok: false,
      code: 'parent_unavailable',
    });

    const options = { ...scope };
    const session = await createManagedDelegationSession({
      harness: 'claude',
      sessionKey: `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`,
      currentOptions: () => options,
      currentTurn: () => 'root-turn',
      getWindow: () => null,
    });
    const brokerMessage = jest.spyOn(
      AgentDelegationBroker.prototype,
      'message',
    );
    await expect(
      messageManagedDelegationForUser(unavailableRequest),
    ).resolves.toEqual(firstUnavailable);
    expect(brokerMessage).not.toHaveBeenCalled();

    const snapshot: AgentDelegationSnapshot = {
      delegationId: retained.value.delegationId,
      status: 'running',
      outputTruncated: false,
    };
    const inspect = jest
      .spyOn(AgentDelegationBroker.prototype, 'inspect')
      .mockReturnValue(snapshot);
    brokerMessage.mockResolvedValue({ ok: true, value: snapshot });
    const acceptedRequest = {
      ...unavailableRequest,
      operationId: randomUUID(),
    };
    const [accepted, concurrentReplay] = await Promise.all([
      messageManagedDelegationForUser(acceptedRequest),
      messageManagedDelegationForUser(acceptedRequest),
    ]);
    expect(accepted).toEqual({ ok: true, snapshot });
    expect(concurrentReplay).toEqual(accepted);
    expect(brokerMessage).toHaveBeenCalledTimes(1);
    expect(brokerMessage.mock.calls[0]?.[0]).toMatchObject({
      depth: 0,
      controlAuthor: 'user',
    });

    await expect(
      messageManagedDelegationForUser({
        ...acceptedRequest,
        message: 'Changed arguments.',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(brokerMessage).toHaveBeenCalledTimes(1);

    const invalidRequest = {
      ...acceptedRequest,
      operationId: randomUUID(),
      message: '   ',
    };
    await expect(
      messageManagedDelegationForUser(invalidRequest),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    await expect(
      messageManagedDelegationForUser({
        ...invalidRequest,
        message: 'Now valid.',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(brokerMessage).toHaveBeenCalledTimes(1);

    brokerMessage.mockRejectedValueOnce(new Error('/private/host/path'));
    const failedRequest = { ...acceptedRequest, operationId: randomUUID() };
    const firstFailure = await messageManagedDelegationForUser(failedRequest);
    expect(firstFailure).toEqual({
      ok: false,
      code: 'failed',
      error: 'The delegate message could not be delivered.',
    });
    await expect(
      messageManagedDelegationForUser(failedRequest),
    ).resolves.toEqual(firstFailure);
    expect(brokerMessage).toHaveBeenCalledTimes(2);

    inspect.mockRestore();
    brokerMessage.mockRestore();
    session.detach();
  });

  it('routes missing delegations through the broker and returns a viewer-safe not-found result', async () => {
    const session = await createManagedDelegationSession({
      harness: 'claude',
      sessionKey: `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`,
      currentOptions: () => scope,
      currentTurn: () => 'root-turn',
      getWindow: () => null,
    });
    const brokerMessage = jest.spyOn(
      AgentDelegationBroker.prototype,
      'message',
    );
    const result = await messageManagedDelegationForUser({
      ...scope,
      delegationId: 'missing-delegate',
      operation: 'steer',
      message: 'Continue.',
      operationId: randomUUID(),
    });
    expect(brokerMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.stringify(result)).not.toContain('/test/worktree');
    brokerMessage.mockRestore();
    session.detach();
  });

  it.each([
    {
      name: 'capacity errors',
      error: {
        code: 'capacity_exceeded' as const,
        message: 'The delegation limit was reached.',
        retryable: false,
      },
      workspaceDiscarded: false,
      expectedCode: 'busy',
    },
    {
      name: 'pending-command errors',
      error: {
        code: 'invalid_request' as const,
        message: 'Another command is already pending.',
        retryable: false,
      },
      workspaceDiscarded: false,
      expectedCode: 'busy',
    },
    {
      name: 'discarded workspace errors',
      error: {
        code: 'capability_unavailable' as const,
        message: 'Workspace unavailable.',
        retryable: false,
      },
      workspaceDiscarded: true,
      expectedCode: 'discarded',
    },
  ])('maps $name to a safe viewer result', async (scenario) => {
    const session = await createManagedDelegationSession({
      harness: 'claude',
      sessionKey: `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`,
      currentOptions: () => scope,
      currentTurn: () => 'root-turn',
      getWindow: () => null,
    });
    const inspect = jest
      .spyOn(AgentDelegationBroker.prototype, 'inspect')
      .mockReturnValue({
        delegationId: 'mapped-delegate',
        status: 'running',
        outputTruncated: false,
        ...(scenario.workspaceDiscarded ? { workspaceDiscarded: true } : {}),
      });
    const brokerMessage = jest
      .spyOn(AgentDelegationBroker.prototype, 'message')
      .mockResolvedValue({ ok: false, error: scenario.error });
    const result = await messageManagedDelegationForUser({
      ...scope,
      delegationId: 'mapped-delegate',
      operation: 'steer',
      message: 'Continue safely.',
      operationId: randomUUID(),
    });
    expect(result).toMatchObject({ ok: false, code: scenario.expectedCode });
    expect(JSON.stringify(result)).not.toContain('/test/worktree');
    inspect.mockRestore();
    brokerMessage.mockRestore();
    session.detach();
  });

  it('returns not-found for another chat and rejects invalid shared IDs', async () => {
    const wrongChat = {
      ...scope,
      chatId: 'some-other-chat',
      delegationId: 'existing-in-original-chat',
      operation: 'steer' as const,
      message: 'This is not addressed to the original chat.',
      operationId: randomUUID(),
    };
    await expect(
      messageManagedDelegationForUser(wrongChat),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(
      messageManagedDelegationForUser({
        ...wrongChat,
        projectId: 'Invalid Project',
        operationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('reads retained same-chat trees, authored transcript pages, and roots without a live actor', async () => {
    const readScope = {
      projectId: 'retained-reader-project',
      worktreeId: 'retained-reader-worktree',
      chatId: 'retained-reader-chat',
    };
    const directory = path.join(
      mockDataRoot,
      readScope.projectId,
      readScope.worktreeId,
      'delegation',
      'runs',
    );
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness({}, storage);
    await broker.initialize();
    let delegationId = '';
    try {
      const parent = {
        ...rootParent,
        projectId: readScope.projectId,
        worktreeId: readScope.worktreeId,
        chatId: readScope.chatId,
        sessionKey: `${readScope.projectId}/${readScope.worktreeId}/${readScope.chatId}`,
      };
      const spawned = await broker.spawn(parent, {
        ...baseTask,
        allowNestedDelegation: true,
      });
      if (!spawned.ok) throw new Error('Expected a retained delegation');
      delegationId = spawned.value.delegationId;
      await flushBroker();
      await waitForLaunch(runner, delegationId);
      await emit(runner, delegationId, 1, {
        type: 'started',
        nativeSessionId: 'retained-reader-session',
      });
      await emit(runner, delegationId, 2, {
        type: 'transcript',
        items: [
          {
            type: 'text',
            id: 'retained-provider-text',
            sequence: 1,
            occurredAt: Date.now(),
            text: 'Provider transcript before the user steer.',
          },
        ],
      });
      await flushBroker();
      const childParent = {
        ...parent,
        harnessId: 'third-harness',
        depth: 1,
        parentDelegationId: delegationId,
        parentRunGeneration: 1,
        parentDescription: baseTask.description,
        turnId: 'retained-child-turn',
        toolCallId: 'retained-child-spawn',
      };
      const child = await broker.spawn(childParent, baseTask);
      if (!child.ok) throw new Error('Expected a retained descendant');
      await flushBroker();
      await waitForLaunch(runner, child.value.delegationId);
      const userMessage = await broker.message(
        { ...parent, controlAuthor: 'user', turnId: 'viewer-turn' },
        {
          delegationId,
          operation: 'steer',
          message: 'Keep the stored history attributed to the user.',
        },
      );
      if (!userMessage.ok)
        throw new Error(
          `Expected authored message: ${JSON.stringify(userMessage.error)}`,
        );
    } finally {
      await broker.close();
    }

    const target = readScope;
    const tree = await readManagedDelegationTreeForUser(target);
    expect(tree).toHaveLength(2);
    expect(
      tree.find((entry) => entry.snapshot.delegationId === delegationId),
    ).toMatchObject({
      snapshot: { delegationId },
      description: baseTask.description,
      runGeneration: 1,
    });
    expect(
      tree.find((entry) => entry.snapshot.parentDelegationId === delegationId),
    ).toBeDefined();

    const page = await readManagedDelegationTranscriptForUser({
      ...target,
      delegationId,
      beforeSequence: 0,
    });
    expect(page).toMatchObject({ ok: true, runGeneration: 1, items: [] });
    const transcript = await readManagedDelegationTranscriptForUser({
      ...target,
      delegationId,
    });
    if (!transcript.ok) throw new Error('Expected a retained transcript');
    expect(
      transcript.items.some(
        (item) =>
          item.type === 'text' &&
          item.author?.kind === 'user' &&
          item.delivery === 'steer',
      ),
    ).toBe(true);
    await expect(
      readManagedDelegationTranscriptForUser({
        ...target,
        delegationId,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      hasMore: true,
      items: [{ sequence: 2 }],
    });
    await expect(
      readManagedDelegationTranscriptForUser({
        ...target,
        chatId: 'some-other-chat',
        delegationId,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(
      readManagedDelegationTranscriptForUser({
        ...target,
        delegationId,
        beforeSequence: -1,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    const rootsLoad = jest.spyOn(FileDelegationStorage.prototype, 'load');
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start);
    await expect(readManagedDelegationRootsForUser(readScope)).resolves.toEqual(
      [
        expect.objectContaining({
          chatId: readScope.chatId,
          total: 2,
          live: 0,
        }),
      ],
    );
    const loadsAfterFirstRead = rootsLoad.mock.calls.length;
    jest.spyOn(Date, 'now').mockReturnValue(start + 1_999);
    await readManagedDelegationRootsForUser(readScope);
    expect(rootsLoad).toHaveBeenCalledTimes(loadsAfterFirstRead);
    jest.spyOn(Date, 'now').mockReturnValue(start + 2_001);
    await readManagedDelegationRootsForUser(readScope);
    expect(rootsLoad).toHaveBeenCalledTimes(loadsAfterFirstRead + 1);
    jest.restoreAllMocks();
    await expect(
      readManagedDelegationWorktreeSummaryForUser(
        readScope,
        delegationId,
        'a'.repeat(40),
        new AbortController().signal,
      ),
    ).rejects.toThrow("The revision isn't this delegate's starting revision.");
    await expect(
      readManagedDelegationWorktreeSummaryForUser(
        { ...readScope, worktreeId: 'different-worktree' },
        delegationId,
        'a'.repeat(40),
        new AbortController().signal,
      ),
    ).rejects.toThrow("The revision isn't this delegate's starting revision.");
    await expect(
      readManagedDelegationTreeForUser({ ...target, chatId: 'Invalid Chat' }),
    ).resolves.toEqual([]);
  });

  it("does not count a previous run's running records as live before or during restart recovery", async () => {
    const staleScope = {
      projectId: 'stale-roots-project',
      worktreeId: 'stale-roots-worktree',
      chatId: 'stale-roots-chat',
      cwd: '/test/worktree',
    };
    const runsDirectory = path.join(
      mockDataRoot,
      staleScope.projectId,
      staleScope.worktreeId,
      'delegation',
      'runs',
    );
    const { broker, runner } = createBrokerHarness(
      {},
      new FileDelegationStorage(runsDirectory),
    );
    await broker.initialize();
    const parent = {
      ...rootParent,
      projectId: staleScope.projectId,
      worktreeId: staleScope.worktreeId,
      chatId: staleScope.chatId,
      sessionKey: `${staleScope.projectId}/${staleScope.worktreeId}/${staleScope.chatId}`,
    };
    const spawned = await broker.spawn(parent, baseTask);
    if (!spawned.ok) throw new Error('Expected a running delegation');
    await flushBroker();
    await waitForLaunch(runner, spawned.value.delegationId);
    await emit(runner, spawned.value.delegationId, 1, {
      type: 'started',
      nativeSessionId: 'stale-roots-session',
    });
    await flushBroker();
    // Keep the on-disk record a crashed previous run would leave behind.
    const files = (await readdir(runsDirectory)).filter((name) =>
      name.endsWith('.json'),
    );
    const running = await Promise.all(
      files.map(async (name) => ({
        name,
        content: await readFile(path.join(runsDirectory, name), 'utf8'),
      })),
    );
    await broker.close();
    await Promise.all(
      running.map(({ name, content }) =>
        writeFile(path.join(runsDirectory, name), content),
      ),
    );

    await expect(
      readManagedDelegationRootsForUser(staleScope),
    ).resolves.toEqual([
      expect.objectContaining({ chatId: staleScope.chatId, live: 0 }),
    ]);

    const options = { ...staleScope };
    const session = createManagedDelegationSession({
      harness: 'claude',
      sessionKey: parent.sessionKey,
      currentOptions: () => options,
      currentTurn: () => 'root-turn',
      getWindow: () => null,
    });
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 10_000);
    try {
      await expect(
        readManagedDelegationRootsForUser(staleScope),
      ).resolves.toEqual([
        expect.objectContaining({ chatId: staleScope.chatId, live: 0 }),
      ]);
    } finally {
      jest.restoreAllMocks();
    }
    await session;

    // With the scope's actor loaded, a chat without a live root has nothing
    // running in this process, whatever its retained record still says.
    await Promise.all(
      running.map(({ name, content }) => {
        const record: unknown = JSON.parse(content);
        const parentRecord: unknown =
          typeof record === 'object' && record !== null
            ? Reflect.get(record, 'parent')
            : undefined;
        if (typeof parentRecord !== 'object' || parentRecord === null)
          throw new Error('Expected a retained parent');
        Reflect.set(parentRecord, 'chatId', 'stale-roots-other-chat');
        return writeFile(
          path.join(runsDirectory, name),
          JSON.stringify(record),
        );
      }),
    );
    jest.spyOn(Date, 'now').mockReturnValue(start + 20_000);
    try {
      await expect(
        readManagedDelegationRootsForUser(staleScope),
      ).resolves.toEqual([
        expect.objectContaining({
          chatId: 'stale-roots-other-chat',
          live: 0,
        }),
      ]);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('reads every retained run of a delegate that took a follow-up', async () => {
    const historyScope = {
      projectId: 'history-reader-project',
      worktreeId: 'history-reader-worktree',
      chatId: 'history-reader-chat',
    };
    const storage = new FileDelegationStorage(
      path.join(
        mockDataRoot,
        historyScope.projectId,
        historyScope.worktreeId,
        'delegation',
        'runs',
      ),
    );
    const { broker, runner } = createBrokerHarness(
      {
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({
              capabilities: ['read', 'progress', 'resume'],
            }),
          }),
      },
      storage,
    );
    await broker.initialize();
    const parent = {
      ...rootParent,
      ...historyScope,
      sessionKey: `${historyScope.projectId}/${historyScope.worktreeId}/${historyScope.chatId}`,
    };
    let delegationId = '';
    try {
      const spawned = await broker.spawn(parent, baseTask);
      if (!spawned.ok) throw new Error('Expected a retained delegation');
      delegationId = spawned.value.delegationId;
      await flushBroker();
      await waitForLaunch(runner, delegationId);
      await emit(runner, delegationId, 1, {
        type: 'started',
        nativeSessionId: 'history-reader-session',
      });
      await emit(runner, delegationId, 2, {
        type: 'transcript',
        items: [
          {
            type: 'text',
            id: 'first-run-text',
            sequence: 1,
            occurredAt: Date.now(),
            text: 'The first run wrote one story.',
          },
        ],
      });
      await emit(runner, delegationId, 3, {
        type: 'terminal',
        status: 'completed',
        finalText: 'The first run wrote one story.',
      });
      await flushBroker();
      const followUp = await broker.message(
        { ...parent, controlAuthor: 'user', turnId: 'viewer-follow-up' },
        { delegationId, operation: 'follow_up', message: 'Write two more.' },
      );
      if (!followUp.ok)
        throw new Error(
          `Expected a follow-up: ${JSON.stringify(followUp.error)}`,
        );
      await flushBroker();
    } finally {
      await broker.close();
    }

    const entries = (await readManagedDelegationTreeForUser(historyScope))
      .filter((entry) => entry.snapshot.delegationId === delegationId)
      .map((entry) => [entry.runGeneration, entry.prompt]);
    expect(entries).toEqual([
      [1, baseTask.prompt],
      [2, 'Write two more.'],
    ]);

    const firstRun = await readManagedDelegationTranscriptForUser({
      ...historyScope,
      delegationId,
      runGeneration: 1,
    });
    if (!firstRun.ok) throw new Error('Expected the first run transcript');
    expect(firstRun).toMatchObject({
      runGeneration: 1,
      task: { prompt: baseTask.prompt },
    });
    expect(
      firstRun.items.some(
        (item) =>
          item.type === 'text' &&
          item.text === 'The first run wrote one story.',
      ),
    ).toBe(true);
    await expect(
      readManagedDelegationTranscriptForUser({ ...historyScope, delegationId }),
    ).resolves.toMatchObject({
      ok: true,
      runGeneration: 2,
      task: { prompt: 'Write two more.' },
    });
    // A re-read that already has the run's latest revision gets no items.
    await expect(
      readManagedDelegationTranscriptForUser({
        ...historyScope,
        delegationId,
        runGeneration: 1,
        sinceRevision: firstRun.revision,
      }),
    ).resolves.toMatchObject({
      ok: true,
      unchanged: true,
      revision: firstRun.revision,
      items: [],
    });
    await expect(
      readManagedDelegationTranscriptForUser({
        ...historyScope,
        delegationId,
        runGeneration: 1,
        sinceRevision: firstRun.revision - 1,
      }),
    ).resolves.toMatchObject({ ok: true, items: firstRun.items });
    await expect(
      readManagedDelegationTranscriptForUser({
        ...historyScope,
        delegationId,
        runGeneration: 9,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(
      readManagedDelegationTranscriptForUser({
        ...historyScope,
        delegationId,
        runGeneration: 0,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('keeps the newest delegations when a chat retains more than the tree limit', async () => {
    const treeScope = {
      projectId: 'tree-limit-project',
      worktreeId: 'tree-limit-worktree',
      chatId: 'tree-limit-chat',
    };
    const storage = new FileDelegationStorage(
      path.join(
        mockDataRoot,
        treeScope.projectId,
        treeScope.worktreeId,
        'delegation',
        'runs',
      ),
    );
    const { broker, runner } = createBrokerHarness({}, storage);
    await broker.initialize();
    const spawned = await broker.spawn(
      {
        ...rootParent,
        ...treeScope,
        sessionKey: `${treeScope.projectId}/${treeScope.worktreeId}/${treeScope.chatId}`,
      },
      baseTask,
    );
    if (!spawned.ok) throw new Error('Expected a retained delegation');
    await flushBroker();
    await waitForLaunch(runner, spawned.value.delegationId);
    await emit(runner, spawned.value.delegationId, 1, {
      type: 'terminal',
      status: 'completed',
    });
    await flushBroker();
    await broker.close();
    const [template] = await storage.load();
    if (!template) throw new Error('Expected a retained record');
    const records = Array.from({ length: 1001 }, (_, index) => ({
      ...template,
      createdAt: 1_000 + index,
      history: undefined,
      state: { ...template.state, delegationId: `tree-limit-${index}` },
    }));
    jest
      .spyOn(FileDelegationStorage.prototype, 'load')
      .mockResolvedValue(records);
    try {
      const entries = await readManagedDelegationTreeForUser(treeScope);
      expect(entries).toHaveLength(1000);
      expect(entries.at(-1)?.snapshot.delegationId).toBe('tree-limit-1000');
      expect(
        entries.some((entry) => entry.snapshot.delegationId === 'tree-limit-0'),
      ).toBe(false);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
