import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { ChatDelegationLogs } from '../lib/chat-delegation-log';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { fsyncDirectory } from '../lib/fsync-directory';
import type * as FsyncDirectoryModule from '../lib/fsync-directory';
import { CreatedArtifacts } from '../lib/chat-transcript-artifacts';
import { ChatStorageV2, type ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

jest.mock('../lib/fsync-directory', () => {
  const actual = jest.requireActual<typeof FsyncDirectoryModule>(
    '../lib/fsync-directory',
  );
  return { fsyncDirectory: jest.fn(actual.fsyncDirectory) };
});

const RUN = { delegationId: 'delegation-1', runGeneration: 1 };

function text(
  id: string,
  sequence: number,
  value: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text: value };
}

function tool(
  id: string,
  sequence: number,
  output?: string,
): AgentDelegationTranscriptItem {
  return {
    id,
    sequence,
    occurredAt: sequence,
    type: 'tool',
    toolName: 'Bash',
    input: 'ls',
    ...(output === undefined ? {} : { output }),
  };
}

/** The card row a parent transcript keeps for a logged run. */
function cardMessage(): PersistedChatMessage {
  const [card] = delegationTranscriptMessages({
    delegationId: RUN.delegationId,
    runGeneration: RUN.runGeneration,
    sequence: 3,
    parentHarnessId: 'claude',
    parentTurnId: 'prompt',
    parentToolCallId: 'spawn',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Review it',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: RUN.delegationId,
      status: 'completed',
      outputTruncated: false,
      finalText: 'Done',
      routeSnapshot: projectAgentRoute(
        routeFixture({
          selectedModelId: 'model',
          runtimeModelId: 'model',
          harnessId: 'claude',
        }),
      ),
    },
    transcript: [],
    transcriptStore: 'chat-log-v1',
  });
  if (!card) throw new Error('Missing card row');
  return card;
}

const prompt: PersistedChatMessage = {
  id: 'prompt',
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text: 'Delegate it' }],
};

describe('ChatDelegationLogs', () => {
  let root: string;
  let logs: ChatDelegationLogs;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delegation-log-'));
    logs = new ChatDelegationLogs(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the newest version of each item, in delegate order', async () => {
    await logs.append('chat', RUN, [tool('b', 2), text('a', 1, 'first')]);
    await logs.append('chat', RUN, [tool('b', 2, 'output'), text('c', 3, 'x')]);
    expect(await logs.read('chat', RUN)).toEqual([
      text('a', 1, 'first'),
      tool('b', 2, 'output'),
      text('c', 3, 'x'),
    ]);
    expect(await logs.read('chat', { ...RUN, runGeneration: 2 })).toEqual([]);
  });

  it('rejects items that are not transcript items', async () => {
    await expect(
      logs.append('chat', RUN, [
        { id: 'bad' } as unknown as AgentDelegationTranscriptItem,
      ]),
    ).rejects.toThrow('Invalid delegation transcript item');
    await expect(logs.has('chat', RUN)).resolves.toBe(false);
  });

  it('skips a torn final line and keeps appending after it', async () => {
    await logs.append('chat', RUN, [text('a', 1, 'kept')]);
    await appendFile(logs.path('chat', RUN), '{"v":1,"item":{"id":"torn"');
    const reopened = new ChatDelegationLogs(root);
    expect(await reopened.read('chat', RUN)).toEqual([text('a', 1, 'kept')]);
    await reopened.append('chat', RUN, [text('b', 2, 'after')]);
    expect(await reopened.read('chat', RUN)).toEqual([
      text('a', 1, 'kept'),
      text('b', 2, 'after'),
    ]);
  });

  it('compacts a log that grew past twice its live content', async () => {
    const big = 'x'.repeat(256 * 1024);
    for (let version = 0; version < 12; version += 1)
      await logs.append('chat', RUN, [
        text('a', 1, `${big}${String(version)}`),
      ]);
    // Twelve versions would be 3 MiB; compaction at 1 MiB keeps it below.
    const { size } = await stat(logs.path('chat', RUN));
    expect(size).toBeLessThan(1024 * 1024);
    expect(await logs.read('chat', RUN)).toEqual([text('a', 1, `${big}11`)]);
  });

  it('copies a run to another chat and tracks the new file for rollback', async () => {
    await logs.append('source', RUN, [text('a', 1, 'copied')]);
    const target = new ChatDelegationLogs(join(root, 'other'));
    const created = new CreatedArtifacts();
    await logs.copyRun('source', 'target', RUN, target, created);
    expect(await target.read('target', RUN)).toEqual([text('a', 1, 'copied')]);
    expect(created.size).toBe(1);
    await created.discard();
    expect(await target.read('target', RUN)).toEqual([]);
  });

  it('syncs each directory a new log adds an entry to, up to the transcripts root', async () => {
    const synced = jest.mocked(fsyncDirectory);
    synced.mockClear();
    await logs.append('chat', RUN, [text('a', 1, 'x')]);
    const delegations = join(root, 'delegations');
    expect(synced.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([root, delegations, join(delegations, 'chat')]),
    );
    synced.mockClear();
    const target = new ChatDelegationLogs(join(root, 'other'));
    await logs.copyRun('chat', 'target', RUN, target);
    expect(synced.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        join(root, 'other'),
        join(root, 'other', 'delegations'),
        join(root, 'other', 'delegations', 'target'),
      ]),
    );
  });

  it('writes nothing for a removed chat, even an append already under way', async () => {
    const inFlight = logs.append('chat', RUN, [text('a', 1, 'x')]);
    const removal = logs.remove('chat');
    await Promise.all([inFlight, removal]);
    await logs.append('chat', RUN, [text('b', 2, 'late')]);
    await expect(stat(join(root, 'delegations', 'chat'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    // A run copied back (an archive restore) makes the chat writable again.
    await logs.append('source', RUN, [text('a', 1, 'restored')]);
    await logs.copyRun('source', 'chat', RUN, logs);
    await logs.append('chat', RUN, [text('b', 2, 'after')]);
    expect(await logs.read('chat', RUN)).toEqual([
      text('a', 1, 'restored'),
      text('b', 2, 'after'),
    ]);
  });

  it('removes every log of a chat and refuses writes when read-only', async () => {
    await logs.append('chat', RUN, [text('a', 1, 'x')]);
    await logs.remove('chat');
    expect(await logs.read('chat', RUN)).toEqual([]);
    await expect(
      new ChatDelegationLogs(root, true).append('chat', RUN, [
        text('a', 1, 'x'),
      ]),
    ).rejects.toThrow('read-only');
  });
});

describe('delegate logs in chat storage', () => {
  let root: string;
  let store: ChatStorageV2;
  let backend: ChatStateV2Backend;

  async function migrate(
    target: ChatStorageV2,
    chats: ChatMigrationEntry[],
  ): Promise<void> {
    await target.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: {
          activeTabId: chats[0]?.metadata.id ?? 'chat',
          runtimeByChatId: {},
        },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          for (const chat of chats) yield await Promise.resolve(chat);
        })(),
      }),
    );
  }

  function chat(id: string): ChatMigrationEntry {
    return {
      metadata: { id, title: id, createdAt: '2026-10-06' },
      messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
        for (const message of [prompt, cardMessage()])
          yield await Promise.resolve(message);
      })(),
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delegation-storage-'));
    store = new ChatStorageV2(root, 'scope');
    await migrate(store, [chat('chat')]);
    backend = new ChatStateV2Backend(store);
  });

  afterEach(async () => {
    await backend.disposeArtifactMaintenance();
    await rm(root, { recursive: true, force: true });
  });

  it('appends only for an indexed chat and reads the run back', async () => {
    await expect(
      backend.appendDelegationItems('chat', [
        { run: RUN, items: [text('a', 1, 'x')] },
      ]),
    ).resolves.toBe(true);
    await expect(
      backend.appendDelegationItems('gone', [
        { run: RUN, items: [text('a', 1, 'x')] },
      ]),
    ).resolves.toBe(false);
    expect(await backend.readDelegationItems('chat', RUN)).toEqual([
      text('a', 1, 'x'),
    ]);
    await expect(
      readdir(join(store.directory, 'transcripts', 'delegations')),
    ).resolves.toEqual(['chat']);
  });

  it('removes a deleted chat’s logs with its transcript', async () => {
    await backend.appendDelegationItems('chat', [
      { run: RUN, items: [text('a', 1, 'x')] },
    ]);
    const removal: ChatCoreMutation = { type: 'tab.removed', tabId: 'chat' };
    await backend.transact(() => [removal], { source: 'renderer-command' });
    await expect(
      stat(join(store.directory, 'transcripts', 'delegations', 'chat')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('captures the logs of indexed chats only', async () => {
    await backend.appendDelegationItems('chat', [
      { run: RUN, items: [text('a', 1, 'x')] },
    ]);
    // A deleted chat's directory left behind by a crash is not carried.
    await new ChatDelegationLogs(join(store.directory, 'transcripts')).append(
      'orphan',
      RUN,
      [text('a', 1, 'orphan')],
    );
    const destination = new ChatStorageV2(join(root, 'archive'), 'scope');
    await store.copyTo(destination);
    const captured = new ChatDelegationLogs(
      join(destination.directory, 'transcripts'),
      true,
    );
    expect(await captured.read('chat', RUN)).toEqual([text('a', 1, 'x')]);
    expect(await captured.read('orphan', RUN)).toEqual([]);
  });

  it('carries a card’s log into a fork of its chat', async () => {
    await backend.appendDelegationItems('chat', [
      { run: RUN, items: [text('a', 1, 'x')] },
    ]);
    const state = await backend.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const [source] = state.tabsFile.tabs;
    if (!source) throw new Error('Missing source chat');
    const fork: ChatCoreMutation = {
      type: 'tab.created',
      tab: { ...structuredClone(source), id: 'fork', title: 'Fork' },
      transcriptSourceChatId: 'chat',
    };
    await backend.transact(() => [fork], { source: 'renderer-command' });
    expect(await backend.readDelegationItems('fork', RUN)).toEqual([
      text('a', 1, 'x'),
    ]);
  });

  it('inlines a card’s children for a copy that leaves chat storage', async () => {
    await backend.appendDelegationItems('chat', [
      { run: RUN, items: [text('a', 1, 'x'), tool('b', 2, 'listed')] },
    ]);
    const read = (inline: boolean): Promise<PersistedChatMessage[]> =>
      backend.consumeTranscript(
        'chat',
        true,
        async (rows) => {
          const messages: PersistedChatMessage[] = [];
          for await (const message of rows) messages.push(message);
          return messages;
        },
        { inlineDelegationChildren: inline },
      );
    const card = cardMessage();
    // Chat storage keeps only the card; its children are in the log.
    expect((await read(false)).map((message) => message.id)).toEqual([
      'prompt',
      card.id,
    ]);
    const inlined = await read(true);
    expect(inlined.map((message) => message.id)).toEqual([
      'prompt',
      card.id,
      `${card.id}:a`,
      `${card.id}:b`,
    ]);
    // The copy has no delegate log: its card names none, as before logs.
    expect(inlined[1]?.blocks[0]).not.toHaveProperty('transcriptStore');
    expect(inlined[2]).toMatchObject({
      parentBlockId: card.id,
      blocks: [{ type: 'text', text: 'x' }],
    });
    expect(inlined[3]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_result', output: 'listed' }),
      ]),
    );
  });

  it('restores a card’s log with its chat', async () => {
    await backend.appendDelegationItems('chat', [
      { run: RUN, items: [text('a', 1, 'x')] },
    ]);
    const state = await backend.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const destination = new ChatStorageV2(join(root, 'restored'), 'scope');
    await migrate(destination, []);
    const restored = new ChatStateV2Backend(destination);
    try {
      await restored.importScope(store, {
        tabsFile: state.tabsFile,
        archivesFile: state.archivesFile,
      });
      expect(await restored.readDelegationItems('chat', RUN)).toEqual([
        text('a', 1, 'x'),
      ]);
    } finally {
      await restored.disposeArtifactMaintenance();
    }
  });
});

describe('delegate log appends and the scope lease', () => {
  const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
  let dir: string;
  let repository: ChatStateV2Repository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-delegation-lease-'));
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(dir, 'chats.json'),
        archives: join(dir, 'archives.json'),
        journal: join(dir, 'journal.jsonl'),
      }),
    });
    await repository.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-10-07T00:00:00Z',
            messages: [],
          },
        },
      ],
      { source: 'renderer-command' },
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await repository.drainAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not hold the scope lease while a delegate log is written', async () => {
    let release = (): void => undefined;
    const writing = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(ChatDelegationLogs.prototype, 'append')
      .mockImplementation((): Promise<void> => writing);
    const append = repository.appendDelegationItems(SCOPE, 'chat', [
      { run: RUN, items: [text('a', 1, 'x')] },
    ]);
    // A chat commit queued behind the write would wait for it.
    const read = repository.hasMessage(SCOPE, 'chat', 'missing');
    const outcome = await Promise.race([
      read.then(() => 'read'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 2_000)),
    ]);
    release();
    await append;
    expect(outcome).toBe('read');
  });
});

describe('deleting a chat that owns format-4 streams', () => {
  it('fences later appends while the checkpoint keeps the tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-delegation-fence-'));
    try {
      const log = new ChatTranscriptLog(root);
      const chat = join(root, 'delegations', 'chat');
      await mkdir(join(chat, 'v2'), { recursive: true });
      await log.remove('chat');
      await log.delegations.append('chat', RUN, [text('a', 1, 'late')]);
      // The tree stays for the checkpoint to remove; no legacy log appears.
      await expect(readdir(chat)).resolves.toEqual(['v2']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
