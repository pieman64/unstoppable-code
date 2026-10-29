import type {
  AgentArtifactCarryByTurn,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import { buildPipelineRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  projectAgentArtifactsWithCarry,
  projectPipelineRunTurnLinks,
} from '@canopy/desktop-shared/lib/agent-artifact-projection';
import {
  PipelineRunChatLinksService,
  type PipelineRunChatLinksReader,
  type PipelineRunChatLinksScope,
} from '../pipeline-run-chat-links';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

const scope: PipelineRunChatLinksScope = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
};

function receipt(
  executionId: string,
  operation = 'pipeline.run',
  worktreeId = 'wt-1',
): ReturnType<typeof buildPipelineRunArtifactReceipt> {
  return buildPipelineRunArtifactReceipt({
    operation,
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Pipeline',
    initialStatus: 'running',
    queuedAt: '2026-05-06T00:00:00.000Z',
    createdAt: '2026-05-06T00:00:00.000Z',
    projectId: 'ws-1',
    worktreeId,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'ws-1',
      worktreeId,
    },
  });
}

function user(id: string, hidden = false): PersistedChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: `ask ${id}` }],
    timestamp: 1,
    ...(hidden ? { hidden: true } : {}),
  };
}

function call(
  id: string,
  toolUseId: string,
  toolName = 'DispatchAction',
  input = '{}',
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool_use', toolUseId, toolName, input }],
    timestamp: 2,
  };
}

function result(
  id: string,
  toolUseId: string,
  receipts: unknown[],
  options: {
    toolName?: string;
    fullOutputRef?: PersistedToolOutputReference;
  } = {},
): PersistedChatMessage {
  const output = JSON.stringify({
    ok: true,
    result: { agentArtifacts: receipts },
  });
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_result',
        toolUseId,
        toolName: options.toolName ?? 'DispatchAction',
        output: options.fullOutputRef ? output.slice(0, 20) : output,
        isError: false,
        ...(options.fullOutputRef
          ? { outputTruncated: true, fullOutputRef: options.fullOutputRef }
          : {}),
      },
    ],
    timestamp: 3,
  };
}

function text(id: string, value: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: value }],
    timestamp: 4,
  };
}

function ref(artifactId: string): PersistedToolOutputReference {
  return {
    version: 1,
    artifactId,
    byteLength: 1,
    sha256: 'sha',
    encoding: 'utf-8',
    mediaType: 'text/plain',
  };
}

interface FakeChat {
  messages: PersistedChatMessage[];
  carry?: AgentArtifactCarryByTurn;
  revision?: number;
}

function createReader(chats: Map<string, FakeChat>): {
  reader: PipelineRunChatLinksReader;
  listChatTabs: jest.Mock;
  readTranscript: jest.Mock;
} {
  const listChatTabs = jest.fn(
    (): Promise<PersistedChatTab[]> =>
      Promise.resolve(
        Array.from(chats.entries()).map(
          ([id, chat]) =>
            ({
              id,
              title: id,
              messages: [],
              createdAt: '2026-05-06T00:00:00.000Z',
              ...(chat.carry ? { agentArtifactCarryByTurn: chat.carry } : {}),
              ...(chat.revision === undefined
                ? {}
                : {
                    transcript: {
                      format: 'complete-message-jsonl-v1',
                      committedMessageCount: chat.messages.length,
                      committedByteLength: 0,
                      transcriptRevision: chat.revision,
                      hasActiveSidecar: false,
                    },
                  }),
            }) as PersistedChatTab,
        ),
      ),
  );
  const readTranscript = jest.fn(
    (
      _scope: PipelineRunChatLinksScope,
      chatId: string,
    ): Promise<readonly PersistedChatMessage[]> =>
      Promise.resolve(chats.get(chatId)?.messages ?? []),
  );
  return {
    reader: { listChatTabs, readTranscript },
    listChatTabs,
    readTranscript,
  };
}

describe('PipelineRunChatLinksService', () => {
  it('matches the shared projection on a canonical transcript', async () => {
    const carry: AgentArtifactCarryByTurn = {
      'u-3': [receipt('exec-watch', 'pipeline.watch')],
      'u-missing': [receipt('exec-ghost', 'pipeline.watch')],
    };
    const messages: PersistedChatMessage[] = [
      user('u-1'),
      call('c-1', 't-1'),
      // An unrelated tool with a large body never participates.
      call('c-bash', 't-bash', 'Bash', 'x'.repeat(10_000)),
      result('r-bash', 't-bash', [receipt('exec-bash')], { toolName: 'Bash' }),
      result('r-1', 't-1', [receipt('exec-run')]),
      call('c-2', 't-2'),
      user('hidden-1', true),
      result('r-2', 't-2', [receipt('exec-run', 'pipeline.execution_resume')]),
      user('u-2'),
      call('c-3', 't-3'),
      user('u-3'),
      // Late result for the u-2 call lands after u-3 began.
      result('r-3', 't-3', [receipt('exec-retry', 'pipeline.execution_retry')]),
      call('c-4', 't-4'),
      result('r-4', 't-4', [receipt('exec-foreign', 'pipeline.run', 'wt-2')]),
      text('t-final', 'done'),
    ];
    const { reader } = createReader(new Map([['chat-1', { messages, carry }]]));
    const service = new PipelineRunChatLinksService(reader);

    const expected = projectPipelineRunTurnLinks(
      projectAgentArtifactsWithCarry(messages, carry),
      ['u-1', 'u-2', 'u-3'],
      scope,
    );
    expect(expected).toEqual([
      { executionId: 'exec-run', userMessageId: 'u-1', relation: 'launched' },
      {
        executionId: 'exec-retry',
        userMessageId: 'u-2',
        relation: 'launched',
      },
      {
        executionId: 'exec-watch',
        userMessageId: 'u-3',
        relation: 'watching',
      },
    ]);
    for (const link of expected) {
      await expect(
        service.chatTurnsFor(scope, link.executionId),
      ).resolves.toEqual([
        {
          chatId: 'chat-1',
          userMessageId: link.userMessageId,
          relation: link.relation,
        },
      ]);
    }
    for (const unlinked of ['exec-bash', 'exec-foreign', 'exec-ghost']) {
      await expect(service.chatTurnsFor(scope, unlinked)).resolves.toEqual([]);
    }
  });

  it('builds once and answers status-only lookups without re-reading chats', async () => {
    const chats = new Map<string, FakeChat>(
      Array.from({ length: 25 }, (_, index) => [
        `chat-${index}`,
        {
          messages: [
            user(`u-${index}`),
            call(`c-${index}`, `t-${index}`),
            result(`r-${index}`, `t-${index}`, [receipt(`exec-${index}`)]),
          ],
        },
      ]),
    );
    const { reader, listChatTabs, readTranscript } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        service.chatTurnsFor(scope, `exec-${index}`),
      ),
    );
    // Many live status/step updates for running executions.
    for (let update = 0; update < 200; update += 1) {
      await service.chatTurnsFor(scope, `exec-${update % 25}`);
    }

    expect(listChatTabs).toHaveBeenCalledTimes(1);
    expect(readTranscript).toHaveBeenCalledTimes(25);
  });

  it('recomputes only changed chats and publishes changed executions', async () => {
    const chats = new Map<string, FakeChat>([
      ['chat-a', { messages: [user('a-1')], revision: 1 }],
      [
        'chat-b',
        {
          messages: [
            user('b-1'),
            call('b-c', 'b-t'),
            result('b-r', 'b-t', [receipt('exec-b')]),
          ],
          revision: 1,
        },
      ],
    ]);
    const { reader, readTranscript } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);
    const changes: string[][] = [];
    service.subscribe((_scope, executionIds) => {
      changes.push([...executionIds]);
    });
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([]);
    readTranscript.mockClear();

    // Metadata-only commit (same transcript revision): no transcript read.
    service.noteChatsMaterialized(scope, {
      changedTabIds: ['chat-a'],
      removedTabIds: [],
    });
    await service.refresh(scope);
    expect(readTranscript).not.toHaveBeenCalled();
    expect(changes).toEqual([]);

    // A launch receipt commits to chat-a only.
    chats.set('chat-a', {
      messages: [
        user('a-1'),
        call('a-c', 'a-t'),
        result('a-r', 'a-t', [receipt('exec-a')]),
      ],
      revision: 2,
    });
    service.noteChatsMaterialized(scope, {
      changedTabIds: ['chat-a'],
      removedTabIds: [],
    });
    await service.refresh(scope);
    expect(readTranscript).toHaveBeenCalledTimes(1);
    expect(readTranscript).toHaveBeenCalledWith(scope, 'chat-a');
    expect(changes).toEqual([['exec-a']]);
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([
      { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
    ]);

    // Streaming text into chat-a leaves links unchanged: nothing published.
    chats.set('chat-a', {
      messages: [...(chats.get('chat-a')?.messages ?? []), text('a-x', 'ok')],
      revision: 3,
    });
    service.noteChatsMaterialized(scope, {
      changedTabIds: ['chat-a'],
      removedTabIds: [],
    });
    await service.refresh(scope);
    expect(changes).toEqual([['exec-a']]);

    // Closing chat-b removes its link with a change notification.
    chats.delete('chat-b');
    service.noteChatsMaterialized(scope, {
      changedTabIds: [],
      removedTabIds: ['chat-b'],
    });
    await service.refresh(scope);
    expect(changes).toEqual([['exec-a'], ['exec-b']]);
    await expect(service.chatTurnsFor(scope, 'exec-b')).resolves.toEqual([]);
  });

  it('applies pending commits on lookup even when no portal refresh ran', async () => {
    const chats = new Map<string, FakeChat>([
      ['chat-a', { messages: [user('a-1')] }],
    ]);
    const { reader } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([]);

    chats.set('chat-a', {
      messages: [
        user('a-1'),
        call('a-c', 'a-t'),
        result('a-r', 'a-t', [receipt('exec-a', 'pipeline.execution_retry')]),
      ],
    });
    service.noteChatsMaterialized(scope, undefined);

    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([
      { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
    ]);
  });

  it('ignores commits for scopes that were never indexed', async () => {
    const { reader, listChatTabs } = createReader(new Map());
    const service = new PipelineRunChatLinksService(reader);

    service.noteChatsMaterialized(scope, {
      changedTabIds: ['chat-a'],
      removedTabIds: [],
    });
    await service.refresh(scope);

    expect(listChatTabs).not.toHaveBeenCalled();
  });

  it('reads externalized dispatch output as persisted, like the renderer', async () => {
    // The renderer projects the persisted preview of an externalized tool
    // result and cannot parse its receipts; main must not show a run there
    // that the desktop panel does not.
    const messages = [
      user('a-1'),
      call('a-c', 'a-t'),
      result('a-r', 'a-t', [receipt('exec-ext')], {
        fullOutputRef: ref('dispatch-body'),
      }),
      call('a-c2', 'a-t2'),
      result('a-r2', 'a-t2', [receipt('exec-inline')]),
    ];
    const { reader } = createReader(new Map([['chat-a', { messages }]]));
    const service = new PipelineRunChatLinksService(reader);

    expect(
      projectPipelineRunTurnLinks(
        projectAgentArtifactsWithCarry(messages),
        ['a-1'],
        scope,
      ).map((link) => link.executionId),
    ).toEqual(['exec-inline']);
    await expect(service.chatTurnsFor(scope, 'exec-ext')).resolves.toEqual([]);
    await expect(service.chatTurnsFor(scope, 'exec-inline')).resolves.toEqual([
      { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
    ]);
  });

  it('keeps the last good links when one chat cannot be read', async () => {
    const chats = new Map<string, FakeChat>([
      [
        'chat-a',
        {
          messages: [
            user('a-1'),
            call('a-c', 'a-t'),
            result('a-r', 'a-t', [receipt('exec-a')]),
          ],
        },
      ],
    ]);
    const { reader, readTranscript } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);
    const changes: string[][] = [];
    service.subscribe((_scope, ids) => changes.push([...ids]));
    await service.chatTurnsFor(scope, 'exec-a');

    readTranscript.mockImplementationOnce(() =>
      Promise.reject(new Error('recovery_error')),
    );
    service.noteChatsMaterialized(scope, {
      changedTabIds: ['chat-a'],
      removedTabIds: [],
    });
    await expect(service.refresh(scope)).resolves.toBeUndefined();

    expect(changes).toEqual([]);
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([
      { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
    ]);
  });

  it('keeps other chats publishing while a failed re-read keeps its links', async () => {
    const chats = new Map<string, FakeChat>([
      [
        'chat-a',
        {
          messages: [
            user('a-1'),
            call('a-c', 'a-t'),
            result('a-r', 'a-t', [receipt('exec-a')]),
          ],
          revision: 1,
        },
      ],
      ['chat-b', { messages: [user('b-1')], revision: 1 }],
    ]);
    const { reader, readTranscript } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);
    const changes: string[][] = [];
    service.subscribe((_scope, ids) => changes.push([...ids]));
    await service.chatTurnsFor(scope, 'exec-a');

    // chat-a's new revision drops its link but cannot be read; chat-b gains
    // one in the same commit burst.
    chats.set('chat-a', { messages: [user('a-1')], revision: 2 });
    chats.set('chat-b', {
      messages: [
        user('b-1'),
        call('b-c', 'b-t'),
        result('b-r', 'b-t', [receipt('exec-b')]),
      ],
      revision: 2,
    });
    readTranscript.mockImplementation(
      (_scope: PipelineRunChatLinksScope, chatId: string) =>
        chatId === 'chat-a'
          ? Promise.reject(new Error('recovery_error'))
          : Promise.resolve(chats.get(chatId)?.messages ?? []),
    );
    service.noteChatsMaterialized(scope, undefined);
    await service.refresh(scope);

    expect(changes).toEqual([['exec-b']]);
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([
      { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
    ]);

    // The failed chat stays dirty and publishes its real change on retry.
    readTranscript.mockImplementation(
      (_scope: PipelineRunChatLinksScope, chatId: string) =>
        Promise.resolve(chats.get(chatId)?.messages ?? []),
    );
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([]);
    expect(changes).toEqual([['exec-b'], ['exec-a']]);
  });

  it('withholds links until every chat has been read once', async () => {
    const chats = new Map<string, FakeChat>([
      [
        'chat-a',
        {
          messages: [
            user('a-1'),
            call('a-c', 'a-t'),
            result('a-r', 'a-t', [receipt('exec-a')]),
          ],
        },
      ],
      [
        'chat-b',
        {
          messages: [
            user('b-1'),
            call('b-c', 'b-t'),
            result('b-r', 'b-t', [receipt('exec-b')]),
          ],
        },
      ],
    ]);
    const { reader, readTranscript } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);
    const changes: string[][] = [];
    service.subscribe((_scope, ids) => changes.push([...ids]));
    readTranscript.mockImplementationOnce(() =>
      Promise.reject(new Error('recovery_error')),
    );

    // An index missing chat-a would answer exec-a with an explicit empty
    // list, which clients apply as "clear the links they hold".
    await expect(service.chatTurnsFor(scope, 'exec-a')).rejects.toThrow(
      'Pipeline run chat links are unavailable',
    );
    await expect(service.chatTurnsFor(scope, 'exec-b')).resolves.toEqual([
      { chatId: 'chat-b', userMessageId: 'b-1', relation: 'launched' },
    ]);
    // Runs answered while links were withheld are republished, and chat-b
    // was not read again.
    expect(changes).toEqual([['exec-a', 'exec-b']]);
    expect(readTranscript).toHaveBeenCalledTimes(3);
    expect(readTranscript).toHaveBeenLastCalledWith(scope, 'chat-a');
  });

  it('rejects lookups when chat metadata cannot be listed', async () => {
    const { reader, listChatTabs } = createReader(new Map());
    listChatTabs.mockImplementationOnce(() =>
      Promise.reject(new Error('unavailable')),
    );
    const service = new PipelineRunChatLinksService(reader);

    await expect(service.chatTurnsFor(scope, 'exec-a')).rejects.toThrow(
      'unavailable',
    );
    await expect(service.chatTurnsFor(scope, 'exec-a')).resolves.toEqual([]);
  });

  it('drops a scope after its last chat is removed and publishes removals', async () => {
    const chats = new Map<string, FakeChat>([
      [
        'chat-a',
        {
          messages: [
            user('a-1'),
            call('a-c', 'a-t'),
            result('a-r', 'a-t', [receipt('exec-a')]),
          ],
        },
      ],
    ]);
    const { reader, listChatTabs } = createReader(chats);
    const service = new PipelineRunChatLinksService(reader);
    const changes: string[][] = [];
    service.subscribe((_scope, ids) => changes.push([...ids]));
    await service.chatTurnsFor(scope, 'exec-a');

    chats.clear();
    service.noteChatsMaterialized(scope, {
      changedTabIds: [],
      removedTabIds: ['chat-a'],
    });
    await service.refresh(scope);

    expect(changes).toEqual([['exec-a']]);
    listChatTabs.mockClear();
    // Dropped: commits no longer cost anything until the next lookup.
    service.noteChatsMaterialized(scope, undefined);
    await service.refresh(scope);
    expect(listChatTabs).not.toHaveBeenCalled();
  });
});
