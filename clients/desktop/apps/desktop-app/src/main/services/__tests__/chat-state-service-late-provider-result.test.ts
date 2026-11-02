import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import type {
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { ChatStateService } from '../chat-state-service';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import {
  attachProviderRunEvent,
  copyProviderRunProvenance,
  createProviderRunGeneration,
  observeProviderRunItem,
  registerProviderRun,
  retireProviderRunGeneration,
  settleProviderRun,
} from '../../lib/provider-run-reconciliation';

const scope = {
  projectId: 'project-late',
  worktreeId: 'worktree-late',
  chatId: 'chat-late',
};
const original: PersistedChatMessage = {
  id: 'codex-command',
  role: 'system',
  timestamp: 12,
  codexThreadId: 'thread',
  codexTurnId: 'native-old',
  blocks: [
    {
      type: 'tool_use',
      toolUseId: 'codex-command',
      toolName: 'command',
      input: 'echo exact',
    },
  ],
};
function ownedCompletion(aggregate = 'exact\naggregate\n'): {
  data: object;
  retire: () => void;
} {
  const generation = createProviderRunGeneration(scope);
  const run = registerProviderRun(generation, {
    threadId: 'thread',
    turnId: 'native-old',
    executionUserMessageId: 'prompt-old',
    origin: 'dispatched',
  });
  observeProviderRunItem(run, 'command', 'command_execution');
  settleProviderRun(run);
  const data = attachProviderRunEvent(
    {
      type: 'codex',
      canopy_turn_user_message_id: 'prompt-old',
      event: {
        type: 'item.completed',
        thread_id: 'thread',
        turn_id: 'native-old',
        item: {
          id: 'command',
          type: 'command_execution',
          command: 'echo exact',
          status: 'completed',
          exit_code: 0,
          aggregated_output: aggregate,
        },
      },
    },
    run,
    'late',
  );
  return { data, retire: (): void => retireProviderRunGeneration(generation) };
}

function runningTerminal(): { data: object; retire: () => void } {
  const generation = createProviderRunGeneration(scope);
  const run = registerProviderRun(generation, {
    threadId: 'thread',
    turnId: 'native-old',
    executionUserMessageId: 'prompt-old',
    origin: 'dispatched',
  });
  const data = attachProviderRunEvent(
    {
      type: 'codex',
      canopy_turn_user_message_id: 'prompt-old',
      event: {
        type: 'turn.completed',
        thread_id: 'thread',
        turn_id: 'native-old',
      },
    },
    run,
    'running',
  );
  return { data, retire: (): void => retireProviderRunGeneration(generation) };
}

describe('late provider command reconciliation', () => {
  let directory: string;
  let repository: ChatStateV2Repository;
  let service: ChatStateService;
  const recordDiagnostic = jest.fn();
  beforeEach(async () => {
    recordDiagnostic.mockClear();
    directory = mkdtempSync(join(tmpdir(), 'late-provider-result-'));
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    service = new ChatStateService({
      repository,
      now: (): number => 100,
      createId: (): string => 'generated',
      recordDiagnostic,
    });
    await service.command({
      schemaVersion: 1,
      commandId: 'create',
      ...scope,
      command: {
        type: 'chat.create_tab',
        tabId: scope.chatId,
        title: 'Late',
        providerType: 'codex',
      },
    });
  });
  afterEach(async () => {
    await repository.drainAll();
    rmSync(directory, { recursive: true, force: true });
  });
  async function seed(
    runtime: ChatRuntimeState,
    offpage = false,
    row = original,
  ): Promise<void> {
    const messages: PersistedChatMessage[] = [
      {
        id: 'prompt-old',
        role: 'user',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'Old prompt' }],
      },
      row,
      ...(offpage
        ? Array.from(
            { length: 510 },
            (_, i): PersistedChatMessage => ({
              id: `history-${i}`,
              role: 'assistant',
              timestamp: 20 + i,
              blocks: [{ type: 'text', text: `history ${i}` }],
            }),
          )
        : []),
    ];
    const mutations: ChatCoreMutation[] = [
      {
        type: 'messages.replaced',
        chatId: scope.chatId,
        messages,
        removedMessageIds: [],
      },
      { type: 'runtime.patched', chatId: scope.chatId, runtime },
    ];
    await repository.transact(scope, mutations, {
      source: 'import',
      mutationId: 'seed',
      fullTranscript: true,
    });
  }
  async function read(): Promise<
    Awaited<ReturnType<ChatStateV2Repository['getState']>>
  > {
    return repository.getState(scope, {
      chatIds: [scope.chatId],
      fullTranscript: true,
    });
  }
  it.each([false, true])(
    'updates only the original row, without revival (offpage %s)',
    async (offpage) => {
      const runtime: ChatRuntimeState = {
        status: 'completed',
        queuedMessageIds: ['queued'],
        lastActivityAt: 77,
      };
      await seed(runtime, offpage);
      const before = await read();
      const event = ownedCompletion();
      const transactions = jest.spyOn(repository, 'transactWith');
      const result = await service.ingestProviderEventWithResult({
        ...scope,
        data: event.data,
        turnUserMessageId: 'prompt-old',
        providerType: 'codex',
        mutationId: 'late-one',
      });
      expect(result.outcome).toBe('applied');
      const after = await read();
      expect(after.runtimeByChatId).toEqual(before.runtimeByChatId);
      const messages = after.tabsFile.tabs[0].messages;
      expect(messages.map(({ id }) => id)).toEqual(
        before.tabsFile.tabs[0].messages.map(({ id }) => id),
      );
      expect(messages.find(({ id }) => id === original.id)).toEqual({
        ...original,
        blocks: [
          ...original.blocks,
          {
            type: 'tool_result',
            toolUseId: 'codex-command',
            toolName: 'command',
            output: 'exact\naggregate\n',
            isError: false,
          },
        ],
      });
      expect(messages.filter(({ id }) => id !== original.id)).toEqual(
        before.tabsFile.tabs[0].messages.filter(({ id }) => id !== original.id),
      );
      expect(transactions.mock.calls[0]?.[2]).toMatchObject({
        fullTranscript: false,
        messageAnchor: {
          messageId: original.id,
          fallbackMessageId: 'prompt-old',
        },
      });
      await service.ingestProviderEventWithResult({
        ...scope,
        data: event.data,
        turnUserMessageId: 'prompt-old',
        providerType: 'codex',
        mutationId: 'late-repeat',
      });
      expect((await read()).tabsFile.tabs[0].messages).toEqual(messages);
    },
    15_000,
  );
  it('renders an empty aggregate as Done, like an ordinary completion', async () => {
    await seed({ status: 'completed', queuedMessageIds: [] });
    const result = await service.ingestProviderEventWithResult({
      ...scope,
      data: ownedCompletion('').data,
      turnUserMessageId: 'prompt-old',
      providerType: 'codex',
      mutationId: 'late-empty',
    });
    expect(result.outcome).toBe('applied');
    const row = (await read()).tabsFile.tabs[0].messages.find(
      ({ id }) => id === original.id,
    );
    expect(row?.blocks.at(-1)).toEqual({
      type: 'tool_result',
      toolUseId: 'codex-command',
      toolName: 'command',
      output: 'Done',
      isError: false,
    });
  });
  it('replaces only its result block and keeps unrelated row content', async () => {
    const runtime: ChatRuntimeState = {
      status: 'completed',
      queuedMessageIds: [],
    };
    const row: PersistedChatMessage = {
      ...original,
      blocks: [
        ...original.blocks,
        { type: 'text', text: 'unrelated retained block' },
        {
          type: 'tool_result',
          toolUseId: 'codex-command',
          toolName: 'command',
          output: 'partial',
          isError: false,
        },
      ],
    };
    await seed(runtime, false, row);
    const before = await read();
    const event = ownedCompletion();
    await service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      providerType: 'codex',
      mutationId: 'late-replacement',
    });
    const after = await read();
    expect(after.runtimeByChatId).toEqual(before.runtimeByChatId);
    expect(
      after.tabsFile.tabs[0].messages.find(({ id }) => id === row.id),
    ).toEqual({
      ...row,
      blocks: [
        ...original.blocks,
        { type: 'text', text: 'unrelated retained block' },
        {
          type: 'tool_result',
          toolUseId: 'codex-command',
          toolName: 'command',
          output: 'exact\naggregate\n',
          isError: false,
        },
      ],
    });
  });
  it('preserves a newer active root and refuses retired provenance', async () => {
    const runtime: ChatRuntimeState = {
      status: 'streaming',
      activeTurn: { userMessageId: 'prompt-new', startedAt: 50 },
      queuedMessageIds: ['queued'],
      lastActivityAt: 77,
    };
    await seed(runtime);
    const before = await read();
    const event = ownedCompletion();
    await service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      turnUserMessageId: 'prompt-new',
      providerType: 'codex',
      mutationId: 'late-newer',
    });
    const after = await read();
    expect(after.runtimeByChatId).toEqual(before.runtimeByChatId);
    expect(
      after.tabsFile.tabs[0].messages.find(({ id }) => id === original.id)
        ?.blocks,
    ).toHaveLength(2);
    event.retire();
    const rejected = await service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      providerType: 'codex',
      mutationId: 'late-retired',
    });
    expect(rejected.outcome).toBe('not-applied');
    expect((await read()).runtimeByChatId).toEqual(before.runtimeByChatId);
  });
  it('refuses an item-id collision from a different native owner', async () => {
    const runtime: ChatRuntimeState = {
      status: 'completed',
      queuedMessageIds: [],
    };
    await seed(runtime, false, { ...original, codexTurnId: 'another-turn' });
    const before = await read();
    const event = ownedCompletion();
    expect(
      (
        await service.ingestProviderEventWithResult({
          ...scope,
          data: event.data,
          providerType: 'codex',
          mutationId: 'late-collision',
        })
      ).outcome,
    ).toBe('not-applied');
    expect((await read()).tabsFile.tabs[0].messages).toEqual(
      before.tabsFile.tabs[0].messages,
    );
  });
  it.each(['missing-row', 'foreign-thread'] as const)(
    'rejects a %s without appending or changing runtime',
    async (scenario) => {
      const runtime: ChatRuntimeState = {
        status: 'completed',
        queuedMessageIds: ['queued'],
        lastActivityAt: 77,
      };
      const row =
        scenario === 'missing-row'
          ? { ...original, id: 'different-row' }
          : { ...original, codexThreadId: 'foreign-thread' };
      await seed(runtime, false, row);
      const before = await read();
      const event = ownedCompletion();
      const result = await service.ingestProviderEventWithResult({
        ...scope,
        data: event.data,
        providerType: 'codex',
        mutationId: `late-${scenario}`,
      });
      expect(result.outcome).toBe('not-applied');
      const after = await read();
      expect(after.runtimeByChatId).toEqual(before.runtimeByChatId);
      expect(after.tabsFile.tabs[0].messages).toEqual(
        before.tabsFile.tabs[0].messages,
      );
      expect(recordDiagnostic).toHaveBeenCalled();
    },
  );
  it('revalidates provenance after its transaction is held', async () => {
    const runtime: ChatRuntimeState = {
      status: 'completed',
      queuedMessageIds: [],
    };
    await seed(runtime);
    const before = await read();
    const event = ownedCompletion();
    const originalTransactWith = repository.transactWith.bind(repository);
    let markEntered: () => void = (): void => {};
    let releaseTransaction: () => void = (): void => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionSpy = jest
      .spyOn(repository, 'transactWith')
      .mockImplementation((transactionScope, build, options) =>
        originalTransactWith(
          transactionScope,
          async (current, revision, context) => {
            markEntered();
            await held;
            return build(current, revision, context);
          },
          options,
        ),
      );
    const pending = service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      providerType: 'codex',
      mutationId: 'late-retired-during-transaction',
    });
    try {
      await entered;
      event.retire();
      releaseTransaction();
      expect((await pending).outcome).toBe('not-applied');
    } finally {
      releaseTransaction();
      transactionSpy.mockRestore();
    }
    const after = await read();
    expect(after.runtimeByChatId).toEqual(before.runtimeByChatId);
    expect(after.tabsFile.tabs[0].messages).toEqual(
      before.tabsFile.tabs[0].messages,
    );
  });
  it('keeps a stamped running terminal on the canonical path after retirement', async () => {
    const runtime: ChatRuntimeState = {
      status: 'streaming',
      activeTurn: { userMessageId: 'prompt-old', startedAt: 10 },
      queuedMessageIds: [],
    };
    await seed(runtime);
    const event = runningTerminal();
    event.retire();
    const result = await service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      turnUserMessageId: 'prompt-old',
      providerType: 'codex',
      mutationId: 'running-retired-terminal',
    });
    expect(result.outcome).toBe('applied');
    expect((await read()).runtimeByChatId[scope.chatId]?.status).toBe('failed');
  });
  it('admits a copied-provenance Codex auth notice through canonical reduction', async () => {
    const runtime: ChatRuntimeState = {
      status: 'streaming',
      activeTurn: { userMessageId: 'prompt-old', startedAt: 10 },
      queuedMessageIds: [],
    };
    const mcpToolUseId = 'codex-mcp-query';
    const row: PersistedChatMessage = {
      ...original,
      blocks: [
        ...original.blocks,
        {
          type: 'tool_use',
          toolUseId: mcpToolUseId,
          toolName: 'mcp__prod__query',
          input: '{}',
        },
        {
          type: 'tool_result',
          toolUseId: mcpToolUseId,
          toolName: 'mcp__prod__query',
          output: 'MCP server authorization required',
          isError: true,
        },
      ],
    };
    await seed(runtime, false, row);
    const generation = createProviderRunGeneration(scope);
    const run = registerProviderRun(generation, {
      threadId: 'thread',
      turnId: 'native-old',
      executionUserMessageId: 'prompt-old',
      origin: 'dispatched',
    });
    const providerEvent = attachProviderRunEvent(
      {
        type: 'codex',
        canopy_turn_user_message_id: 'prompt-old',
        event: {
          type: 'item.completed',
          thread_id: 'thread',
          turn_id: 'native-old',
          item: {
            id: 'command',
            type: 'command_execution',
            command: 'echo exact',
            status: 'completed',
            aggregated_output: 'exact',
          },
        },
      },
      run,
      'running',
    );
    const failure: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'srv-1:cfg-1',
      displayName: 'Prod MCP server',
      failureClass: 'expired',
      recovery: {
        kind: 'mcp_oauth',
        serverId: 'srv-1',
        configId: 'cfg-1',
      },
    };
    const authNotice = copyProviderRunProvenance(providerEvent, {
      type: 'canopy_auth_failure',
      canopy_turn_user_message_id: 'prompt-old',
      toolUseId: mcpToolUseId,
      failure,
      failures: [failure],
    });
    const result = await service.ingestProviderEventWithResult({
      ...scope,
      data: authNotice,
      turnUserMessageId: 'prompt-old',
      providerType: 'codex',
      mutationId: 'auth-notice-after-provider-run',
    });
    expect(result.outcome).toBe('applied');
    const storedRow = (await read()).tabsFile.tabs[0]?.messages.find(
      (message) => message.id === original.id,
    );
    expect(
      storedRow?.blocks.find(
        (block) =>
          block.type === 'tool_result' && block.toolUseId === mcpToolUseId,
      ),
    ).toMatchObject({ authFailure: failure, authFailures: [failure] });
  });
  it('keeps a late result transcript-only behind a held terminal', async () => {
    const runtime: ChatRuntimeState = {
      status: 'streaming',
      activeTurn: { userMessageId: 'prompt-old', startedAt: 10 },
      queuedMessageIds: ['queued'],
      lastActivityAt: 77,
    };
    await seed(runtime);
    const originalTransactWith = repository.transactWith.bind(repository);
    let markTerminalEntered: () => void = (): void => {};
    let markLateQueued: () => void = (): void => {};
    let releaseTerminal: () => void = (): void => {};
    const terminalEntered = new Promise<void>((resolve) => {
      markTerminalEntered = resolve;
    });
    const lateQueued = new Promise<void>((resolve) => {
      markLateQueued = resolve;
    });
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const transactionSpy = jest
      .spyOn(repository, 'transactWith')
      .mockImplementation((transactionScope, build, options) => {
        if (options.mutationId === 'held-terminal')
          return originalTransactWith(
            transactionScope,
            async (current, revision, context) => {
              markTerminalEntered();
              await terminalGate;
              return build(current, revision, context);
            },
            options,
          );
        if (options.mutationId === 'late-behind-terminal') markLateQueued();
        return originalTransactWith(transactionScope, build, options);
      });
    const terminalPending = service.ingestProviderEventWithResult({
      ...scope,
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread',
          turn_id: 'native-old',
        },
      },
      turnUserMessageId: 'prompt-old',
      providerType: 'codex',
      mutationId: 'held-terminal',
    });
    try {
      await terminalEntered;
      const event = ownedCompletion();
      const latePending = service.ingestProviderEventWithResult({
        ...scope,
        data: event.data,
        providerType: 'codex',
        mutationId: 'late-behind-terminal',
      });
      await lateQueued;
      releaseTerminal();
      expect((await terminalPending).outcome).toBe('applied');
      expect((await latePending).outcome).toBe('applied');
      const after = await read();
      expect(after.runtimeByChatId[scope.chatId]?.status).toBe('failed');
      expect(
        after.tabsFile.tabs[0].messages.find(({ id }) => id === original.id)
          ?.blocks,
      ).toContainEqual({
        type: 'tool_result',
        toolUseId: 'codex-command',
        toolName: 'command',
        output: 'exact\naggregate\n',
        isError: false,
      });
    } finally {
      releaseTerminal();
      transactionSpy.mockRestore();
    }
  });
  it('patches an auto-archived origin without reviving it', async () => {
    const runtime: ChatRuntimeState = {
      status: 'completed',
      queuedMessageIds: ['queued'],
      lastActivityAt: 77,
    };
    await seed(runtime);
    const seeded = await read();
    const liveTab = seeded.tabsFile.tabs.find(
      (candidate) => candidate.id === scope.chatId,
    );
    if (!liveTab) throw new Error('Expected seeded live chat');
    const archiveEntry = {
      tab: { ...liveTab, autoArchive: true },
      archivedAt: '2026-01-02T03:04:05.000Z',
      turnCount: 1,
      unread: true,
    };
    await repository.transact(
      scope,
      [
        { type: 'tab.removed', tabId: scope.chatId },
        { type: 'archive.upserted', entry: archiveEntry },
      ],
      {
        source: 'import',
        mutationId: 'archive-origin',
        checkpoint: true,
        chatIds: [scope.chatId],
        fullTranscript: true,
      },
    );
    const before = await read();
    const beforeArchive = before.archivesFile.archived.find(
      (entry) => entry.tab.id === scope.chatId,
    );
    expect(beforeArchive).toBeDefined();
    const event = ownedCompletion();
    const result = await service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      providerType: 'codex',
      mutationId: 'late-archived',
    });
    expect(result.outcome).toBe('applied');
    const after = await read();
    expect(after.runtimeByChatId).toEqual(before.runtimeByChatId);
    expect(
      after.tabsFile.tabs.some((candidate) => candidate.id === scope.chatId),
    ).toBe(false);
    const afterArchive = after.archivesFile.archived.find(
      (entry) => entry.tab.id === scope.chatId,
    );
    expect(afterArchive).toBeDefined();
    if (!beforeArchive || !afterArchive)
      throw new Error('Expected archived chat');
    const { messages: beforeMessages, ...beforeTab } = beforeArchive.tab;
    const { messages: afterMessages, ...afterTab } = afterArchive.tab;
    const { transcript: beforeTranscript, ...beforeTabMetadata } = beforeTab;
    const { transcript: afterTranscript, ...afterTabMetadata } = afterTab;
    void beforeTranscript;
    void afterTranscript;
    expect(afterArchive.archivedAt).toBe(beforeArchive.archivedAt);
    expect(afterArchive.turnCount).toBe(beforeArchive.turnCount);
    expect(afterArchive.unread).toBe(beforeArchive.unread);
    expect(afterTabMetadata).toEqual(beforeTabMetadata);
    expect(afterMessages).toEqual(
      beforeMessages.map((message) =>
        message.id === original.id
          ? {
              ...original,
              blocks: [
                ...original.blocks,
                {
                  type: 'tool_result',
                  toolUseId: 'codex-command',
                  toolName: 'command',
                  output: 'exact\naggregate\n',
                  isError: false,
                },
              ],
            }
          : message,
      ),
    );
    await service.ingestProviderEventWithResult({
      ...scope,
      data: event.data,
      providerType: 'codex',
      mutationId: 'late-archived-repeat',
    });
    expect((await read()).archivesFile.archived).toEqual(
      after.archivesFile.archived,
    );
  });
});
