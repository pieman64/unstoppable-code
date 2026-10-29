import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  readdir,
} from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatStorageV2,
  type ChatMigrationSource,
  type ChatMigrationCheckpoint,
} from '../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import * as directorySync from '../lib/fsync-directory';
import { enforceWindowsFileSync } from './helpers/windows-file-sync';

async function* values<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('v2 migration authority', () => {
  let root: string;
  let store: ChatStorageV2;
  const human: PersistedChatMessage = {
    id: 'human',
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Preserve me\n🌲' }],
  };
  const output = 'lossless output 🌲\n'.repeat(9000);
  const tool: PersistedChatMessage = {
    id: 'tool',
    role: 'assistant',
    timestamp: 2,
    blocks: [
      {
        type: 'tool_result',
        toolName: 'shell',
        toolUseId: 'call-1',
        output,
        isError: false,
      },
    ],
  };
  function source(): Promise<ChatMigrationSource> {
    return Promise.resolve({
      revision: 5,
      index: { activeTabId: 'live-chat', runtimeByChatId: {} },
      recovery: {
        receipts: [{ commandId: 'command-1', revision: 5, outcome: 'applied' }],
        mutationIds: ['mutation-1'],
        removedTabIds: ['deleted-chat'],
        removedArchiveEntryIds: ['deleted-archive'],
        removedMessageIds: ['deleted-message'],
      },
      chats: values([
        {
          metadata: {
            id: 'archive-chat',
            title: 'Archived',
            createdAt: '2026-01-01',
          },
          archive: { archivedAt: '2026-09-01', turnCount: 1 },
          messages: values([human, tool]),
        },
        {
          metadata: { id: 'live-chat', title: 'Live', createdAt: '2026-01-02' },
          messages: values([human]),
        },
      ]),
    });
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-v2-'));
    store = new ChatStorageV2(root, 'scope-1');
    for (const [folder, ext] of [
      ['chats', 'json'],
      ['chat-archives', 'json'],
      ['chat-journals', 'jsonl'],
    ]) {
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(
        join(root, folder, `scope-1.${ext}`),
        'legacy source sentinel',
      );
      await writeFile(
        join(root, folder, `scope-1.${ext}.bak`),
        'legacy backup sentinel',
      );
      await writeFile(join(root, folder, `scope-2.${ext}`), 'sibling sentinel');
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('preserves legacy data when the new namespace parent cannot be synced', async () => {
    const sync = directorySync.fsyncDirectory;
    const spy = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (directory === root) throw new Error('namespace parent sync failed');
        await sync(directory);
      });
    await expect(store.migrate(source)).rejects.toThrow(
      'namespace parent sync failed',
    );
    expect(await readFile(join(root, 'chats', 'scope-1.json'), 'utf8')).toBe(
      'legacy source sentinel',
    );
    spy.mockRestore();
    await new ChatStorageV2(root, 'scope-1').migrate(source);
    expect(
      (
        await new ChatTranscriptLog(join(store.directory, 'transcripts')).page(
          'live-chat',
        )
      ).messages,
    ).toEqual([human]);
  });

  it('rejects capture when the destination namespace parent cannot be synced and permits retry', async () => {
    await store.migrate(source);
    const destinationRoot = join(root, 'capture');
    const destination = new ChatStorageV2(destinationRoot, 'scope-1');
    const sync = directorySync.fsyncDirectory;
    const spy = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (directory === destinationRoot)
          throw new Error('capture parent sync failed');
        await sync(directory);
      });
    await expect(store.copyTo(destination)).rejects.toThrow(
      'capture parent sync failed',
    );
    expect(await store.authority()).toBe('v2');
    spy.mockRestore();
    await store.copyTo(destination);
    expect(
      (
        await new ChatTranscriptLog(
          join(destination.directory, 'transcripts'),
        ).page('archive-chat')
      ).messages,
    ).toHaveLength(2);
  });

  it('migrates mixed live/archive input without an intermediate release or v1 mirror', async () => {
    await store.migrate(source);
    expect(await store.authority()).toBe('v2');
    const indexes = await store.indexes();
    expect(indexes.recovery).toEqual({
      version: 2,
      ...(await source()).recovery,
    });
    expect(indexes.live.tabs[0]).not.toHaveProperty('messages');
    expect(indexes.archive.archived[0]?.tab).not.toHaveProperty('messages');
    const transcript = new ChatTranscriptLog(
      join(store.directory, 'transcripts'),
    );
    const page = await transcript.page('archive-chat');
    expect(page.messages[0]).toEqual(human);
    const block = page.messages[1]?.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing full tool result');
    await transcript.artifacts.verify('archive-chat', block.fullOutputRef);
    expect(
      (
        await transcript.artifacts.readRange(
          'archive-chat',
          block.fullOutputRef,
        )
      ).byteLength,
    ).toBe(Buffer.byteLength(output));
    for (const folder of ['chats', 'chat-archives', 'chat-journals']) {
      expect(await readdir(join(root, folder))).toEqual([
        expect.stringContaining('scope-2.'),
      ]);
    }
  });

  it('validates externalized migration output without reconstructing artifacts in memory', async () => {
    const readRange = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'readRange')
      .mockRejectedValue(new Error('artifact reconstruction is forbidden'));
    try {
      await expect(store.migrate(source)).resolves.toBeUndefined();
      expect(readRange).not.toHaveBeenCalled();
    } finally {
      readRange.mockRestore();
    }
  });

  it.each<ChatMigrationCheckpoint>([
    'staged',
    'validated',
    'promoted',
    'manifest',
  ])(
    'recovers an interruption at %s without duplicate messages or choosing stale v1',
    async (point) => {
      await expect(
        store.migrate(source, (at) => {
          if (at === point)
            return Promise.reject(new Error('simulated interruption'));
          return Promise.resolve();
        }),
      ).rejects.toThrow('simulated interruption');
      expect(await readFile(join(root, 'chats', 'scope-1.json'), 'utf8')).toBe(
        'legacy source sentinel',
      );
      expect(await store.authority()).toBe(point === 'manifest' ? 'v2' : 'v1');
      const createSource = jest.fn(source);
      await new ChatStorageV2(root, 'scope-1').migrate(createSource);
      expect(createSource).toHaveBeenCalledTimes(point === 'manifest' ? 0 : 1);
      const log = new ChatTranscriptLog(join(store.directory, 'transcripts'));
      expect((await log.page('archive-chat')).messages).toHaveLength(2);
    },
  );

  it('defers migration until active turns settle and preserves source files', async () => {
    await expect(
      store.migrate(async () => {
        const input = await source();
        input.index.runtimeByChatId['live-chat'] = {
          status: 'streaming',
          queuedMessageIds: [],
        };
        return input;
      }),
    ).rejects.toThrow('settle');
    expect(await store.authority()).toBe('v1');
    expect(await readFile(join(root, 'chats', 'scope-1.json'), 'utf8')).toBe(
      'legacy source sentinel',
    );
  });

  it('preserves legacy sources if a promoted artifact is damaged before cleanup', async () => {
    await expect(
      store.migrate(source, async (point) => {
        if (point !== 'manifest') return;
        const directory = join(
          store.directory,
          'transcripts',
          'tool-output',
          'archive-chat',
        );
        const names = await readdir(directory);
        await writeFile(join(directory, names[0]), 'corrupt');
      }),
    ).rejects.toThrow('integrity');
    expect(await store.authority()).toBe('v2');
    const createSource = jest.fn(source);
    await expect(
      new ChatStorageV2(root, 'scope-1').migrate(createSource),
    ).rejects.toThrow('integrity');
    expect(createSource).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'chats', 'scope-1.json'), 'utf8')).toBe(
      'legacy source sentinel',
    );
  });

  it('captures current live and archived logs byte-for-byte with their artifact closure', async () => {
    await store.migrate(source);
    const log = new ChatTranscriptLog(join(store.directory, 'transcripts'));
    await log.append('live-chat', [{ ...human, id: 'later', timestamp: 3 }], 6);
    const indexes = await store.indexes();
    indexes.live.tabs[0].transcript = await log.descriptor('live-chat');
    indexes.live.revision = indexes.archive.revision = 6;
    await writeFile(
      join(store.directory, 'live-index.json'),
      JSON.stringify(indexes.live),
    );
    await writeFile(
      join(store.directory, 'archive-index.json'),
      JSON.stringify(indexes.archive),
    );
    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    const syncedFiles = enforceWindowsFileSync();
    await store.copyTo(destination);
    expect(syncedFiles.some((path) => path.endsWith('live-chat.jsonl'))).toBe(
      true,
    );
    for (const id of ['live-chat', 'archive-chat']) {
      expect(
        await readFile(
          join(destination.directory, 'transcripts', `${id}.jsonl`),
        ),
      ).toEqual(
        await readFile(join(store.directory, 'transcripts', `${id}.jsonl`)),
      );
    }
    await rm(store.directory, { recursive: true });
    const captured = new ChatTranscriptLog(
      join(destination.directory, 'transcripts'),
    );
    const block = (await captured.page('archive-chat')).messages[1].blocks[0];
    if (block.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing reference');
    await captured.artifacts.verify('archive-chat', block.fullOutputRef);
    expect((await destination.indexes()).live.revision).toBe(6);
  });

  it('migrates recovery evidence with Windows-compatible flushing and preserves its bytes', async () => {
    const evidence = join(root, 'unreadable-legacy.json');
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
    await writeFile(evidence, bytes);
    const syncedFiles = enforceWindowsFileSync();
    await store.migrate(async () => ({
      ...(await source()),
      evidence: [evidence],
    }));
    const retained = (await store.indexes()).recovery.legacyEvidence;
    expect(retained).toHaveLength(1);
    if (!retained?.[0]) throw new Error('Missing retained recovery evidence');
    expect(
      await readFile(join(store.directory, retained[0].relativePath)),
    ).toEqual(bytes);
    expect(syncedFiles.some((path) => path.endsWith('0.bin'))).toBe(true);
  });

  it('copies recovery evidence with Windows-compatible flushing and preserves its digest', async () => {
    const evidence = join(root, 'unreadable-legacy.json');
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
    await writeFile(evidence, bytes);
    await store.migrate(async () => ({
      ...(await source()),
      evidence: [evidence],
    }));
    const destination = new ChatStorageV2(join(root, 'recovered'), 'scope-2');
    const syncedFiles = enforceWindowsFileSync();
    const retained = await store.copyRecoveryEvidenceTo(destination, []);
    expect(retained).toEqual((await store.indexes()).recovery.legacyEvidence);
    expect(
      await readFile(join(destination.directory, retained[0].relativePath)),
    ).toEqual(bytes);
    expect(syncedFiles.some((path) => path.endsWith('0.bin'))).toBe(true);
  });

  it('does not publish a capture after a file flush fails and permits retry', async () => {
    await store.migrate(source);
    const destination = new ChatStorageV2(
      join(root, 'failed-capture'),
      'scope-2',
    );
    const open = fs.open;
    let failed = false;
    let closed = false;
    const spy = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (
          String(path).includes('failed-capture') &&
          (await handle.stat()).isFile()
        ) {
          const close = handle.close.bind(handle);
          handle.close = async (): Promise<void> => {
            await close();
            closed = true;
          };
          handle.sync = (): Promise<void> => {
            failed = true;
            return Promise.reject(
              Object.assign(new Error('file flush failed'), {
                code: 'EIO',
              }),
            );
          };
        }
        return handle;
      });
    await expect(store.copyTo(destination)).rejects.toThrow(
      'file flush failed',
    );
    expect(failed).toBe(true);
    expect(closed).toBe(true);
    expect(await store.authority()).toBe('v2');
    await expect(readFile(destination.manifestPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    spy.mockRestore();
    await store.copyTo(destination);
    expect(await destination.authority()).toBe('v2');
    expect(
      await readFile(
        join(destination.directory, 'transcripts', 'live-chat.jsonl'),
      ),
    ).toEqual(
      await readFile(join(store.directory, 'transcripts', 'live-chat.jsonl')),
    );
  });

  it('excludes tool-output artifacts no longer reachable after transcript replacement', async () => {
    await store.migrate(source);
    const log = new ChatTranscriptLog(join(store.directory, 'transcripts'));
    const original = await log.page('archive-chat');
    const block = original.messages[1]?.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing original artifact reference');
    await log.replace('archive-chat', [human], 6);
    const indexes = await store.indexes();
    indexes.archive.archived[0].tab.transcript =
      await log.descriptor('archive-chat');
    indexes.live.revision = indexes.archive.revision = 6;
    await writeFile(
      join(store.directory, 'live-index.json'),
      JSON.stringify(indexes.live),
    );
    await writeFile(
      join(store.directory, 'archive-index.json'),
      JSON.stringify(indexes.archive),
    );

    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    await store.copyTo(destination);
    await expect(
      readFile(
        join(
          destination.directory,
          'transcripts',
          'tool-output',
          'archive-chat',
          `${block.fullOutputRef.artifactId}.txt`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('excludes orphaned pending transcripts from portable captures', async () => {
    await store.migrate(source);
    const pendingDirectory = join(
      store.directory,
      'pending-transcripts',
      'aborted-transaction',
    );
    await mkdir(pendingDirectory, { recursive: true });
    await writeFile(
      join(pendingDirectory, '0.jsonl'),
      JSON.stringify({ ...human, id: 'never-committed' }) + '\n',
    );

    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    await store.copyTo(destination);

    await expect(
      readFile(
        join(
          destination.directory,
          'pending-transcripts',
          'aborted-transaction',
          '0.jsonl',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(store.copyTo(destination)).resolves.toBeUndefined();
  });

  it('excludes visual staging documents, sidecars, and temporary files from portable captures', async () => {
    await store.migrate(source);
    const stagingDirectory = join(store.directory, 'visual-staging');
    await mkdir(stagingDirectory, { recursive: true });
    await writeFile(
      join(stagingDirectory, 'visual.html'),
      '<html>staged</html>',
    );
    await writeFile(
      join(stagingDirectory, 'visual.json'),
      JSON.stringify({ visualId: 'vis_123' }),
    );
    await writeFile(
      join(stagingDirectory, '.visual.tmp'),
      '<html>partial</html>',
    );

    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    await store.copyTo(destination);

    for (const name of ['visual.html', 'visual.json', '.visual.tmp'])
      await expect(
        readFile(join(destination.directory, 'visual-staging', name)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves scoped removal fences across storage reopen and capture', async () => {
    await store.migrate(async () => {
      const original = await source();
      return {
        ...original,
        recovery: {
          ...original.recovery,
          removedMessageKeys: [JSON.stringify(['live-chat', 'removed'])],
        },
      };
    });
    const reopened = new ChatStorageV2(root, 'scope-1');
    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    await reopened.copyTo(destination);
    expect((await destination.indexes()).recovery.removedMessageKeys).toEqual([
      JSON.stringify(['live-chat', 'removed']),
    ]);
  });

  it('rejects malformed scoped removal fences without overwriting evidence', async () => {
    await store.migrate(source);
    const indexes = await store.indexes();
    const recoveryPath = join(store.directory, 'recovery-index.json');
    const malformed = JSON.stringify({
      ...indexes.recovery,
      removedMessageKeys: [42],
    });
    await writeFile(recoveryPath, malformed);
    await expect(
      new ChatStorageV2(root, 'scope-1').indexes(),
    ).rejects.toThrow();
    expect(await readFile(recoveryPath, 'utf8')).toBe(malformed);
  });

  it('treats a malformed visual owner ledger as unknown rather than corrupt storage', async () => {
    await store.migrate(source);
    const indexes = await store.indexes();
    await writeFile(
      join(store.directory, 'recovery-index.json'),
      JSON.stringify({
        ...indexes.recovery,
        visualOwnersByChatId: {
          'archive-chat': {
            vis_bad: { messageId: 42, toolUseId: 'call', claimedAt: 'now' },
          },
        },
      }),
    );

    await expect(store.indexes()).resolves.toHaveProperty('recovery');
  });

  it('excludes orphaned transcript temporary files from portable captures', async () => {
    await store.migrate(source);
    const rewriteTemporary = join(
      store.directory,
      'transcripts',
      'archive-chat.abandoned.rewrite.tmp',
    );
    const appendTemporary = join(
      store.directory,
      'transcripts',
      'archive-chat.abandoned.append.tmp',
    );
    await writeFile(rewriteTemporary, JSON.stringify(human) + '\n');
    await writeFile(appendTemporary, JSON.stringify(human) + '\n');

    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    await store.copyTo(destination);

    await expect(
      readFile(
        rewriteTemporary.replace(store.directory, destination.directory),
      ),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(appendTemporary.replace(store.directory, destination.directory)),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('never publishes a capture with corrupt output or an unsettled turn', async () => {
    await store.migrate(source);
    const destination = new ChatStorageV2(join(root, 'captured'), 'scope-2');
    const indexes = await store.indexes();
    indexes.live.runtimeByChatId['live-chat'] = {
      status: 'streaming',
      queuedMessageIds: [],
    };
    await writeFile(
      join(store.directory, 'live-index.json'),
      JSON.stringify(indexes.live),
    );
    await expect(store.copyTo(destination)).rejects.toThrow('settle');
    expect(await destination.authority()).toBe('v1');
    indexes.live.runtimeByChatId = {};
    await writeFile(
      join(store.directory, 'live-index.json'),
      JSON.stringify(indexes.live),
    );
    const artifacts = join(
      store.directory,
      'transcripts',
      'tool-output',
      'archive-chat',
    );
    await writeFile(join(artifacts, (await readdir(artifacts))[0]), 'damaged');
    await expect(store.copyTo(destination)).rejects.toThrow('integrity');
    expect(await destination.authority()).toBe('v1');
    expect(await store.authority()).toBe('v2');
  });

  it('serializes migration admission across instances', async () => {
    const createSource = jest.fn(source);
    await Promise.all([
      store.migrate(createSource),
      new ChatStorageV2(root, 'scope-1').migrate(createSource),
    ]);
    expect(createSource).toHaveBeenCalledTimes(1);
    const log = new ChatTranscriptLog(join(store.directory, 'transcripts'));
    expect((await log.page('archive-chat')).messages).toHaveLength(2);
  });

  it('does not read a completed migration or its source again at startup', async () => {
    await store.migrate(source);
    // Transcript damage belongs to this chat's read/recovery path. It must not
    // turn reopening the whole scope into an implicit remigration or v1 read.
    await writeFile(
      join(store.directory, 'transcripts', 'archive-chat.jsonl'),
      'damage',
    );
    const createSource = jest.fn(source);
    await new ChatStorageV2(root, 'scope-1').migrate(createSource);
    expect(createSource).not.toHaveBeenCalled();
    expect((await store.indexes()).live.tabs[0]?.id).toBe('live-chat');
    const log = new ChatTranscriptLog(join(store.directory, 'transcripts'));
    expect((await log.page('live-chat')).messages).toEqual([human]);
    await expect(log.page('archive-chat')).rejects.toThrow();
  });
});
