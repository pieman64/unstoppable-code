import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  appendFile,
  writeFile,
  readdir,
  utimes,
  rename,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type {
  PersistedChatMessage,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import { isHumanAuthoredUserMessage } from '@canopy/agent-transcript/transcript-storage';
import {
  ChatTranscriptLog,
  readCompleteTranscriptMessages,
} from '../lib/chat-transcript-log';
import { isPersistedChatMessage } from '../lib/chat-tabs-reader';
import { isRecord } from '../lib/type-guards';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

function message(
  id: number,
  role: PersistedChatMessage['role'] = 'assistant',
): PersistedChatMessage {
  return {
    id: `m-${id}`,
    role,
    timestamp: id,
    blocks: [{ type: 'text', text: `message ${id}\n🌲` }],
  };
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('complete-message transcript log', () => {
  let root: string;
  let log: ChatTranscriptLog;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-log-'));
    log = new ChatTranscriptLog(root);
    await log.initialize('chat-1');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('preserves unknown user sources and extra fields in committed JSONL through rewrite and reopen', async () => {
    const futureMessage = {
      ...message(1, 'user'),
      userMessageSource: 'future-agent-source',
      futureAttribution: { senderId: 'future-sender', version: 42 },
    };
    // Exercise the current reader's permissive validation without a type cast.
    expect(isPersistedChatMessage(futureMessage)).toBe(true);
    if (!isPersistedChatMessage(futureMessage))
      throw new Error('Invalid fixture');
    expect(isHumanAuthoredUserMessage(futureMessage)).toBe(false);
    await log.append('chat-1', [futureMessage]);
    expect(await log.readMessage('chat-1', futureMessage.id)).toEqual(
      futureMessage,
    );
    expect((await log.page('chat-1')).messages).toEqual([futureMessage]);
    expect(await readFile(join(root, 'chat-1.jsonl'), 'utf8')).toContain(
      'future-agent-source',
    );
    await log.replace('chat-1', (await log.page('chat-1')).messages, 1);
    const reopened = new ChatTranscriptLog(root);
    expect((await reopened.page('chat-1')).messages).toEqual([futureMessage]);
    expect(await reopened.readMessage('chat-1', futureMessage.id)).toEqual(
      futureMessage,
    );
  });

  it('preserves unknown user sources and extra fields in the active sidecar through rewrite and reopen', async () => {
    const futureMessage = {
      ...message(2, 'user'),
      userMessageSource: 'future-agent-source',
      futureAttribution: { senderId: 'future-active-sender', version: 42 },
    };
    if (!isPersistedChatMessage(futureMessage))
      throw new Error('Invalid fixture');
    expect(isHumanAuthoredUserMessage(futureMessage)).toBe(false);
    await log.writeActive('chat-1', [futureMessage]);
    expect(await readFile(join(root, 'chat-1.active.json'), 'utf8')).toContain(
      'future-active-sender',
    );
    const reopened = new ChatTranscriptLog(root);
    expect(await reopened.activeMessages('chat-1')).toEqual([futureMessage]);
    expect(await reopened.readMessage('chat-1', futureMessage.id)).toEqual(
      futureMessage,
    );
    await reopened.replace(
      'chat-1',
      await reopened.activeMessages('chat-1'),
      1,
    );
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [futureMessage],
    );
  });

  it.each([{ version: 2, activationId: 'future' }, null])(
    'reads opaque unsupported MCP records without rewriting transcript bytes (%j)',
    async (record: unknown) => {
      const row = {
        ...message(1),
        blocks: [...message(1).blocks, { type: 'mcp_activation', record }],
      };
      const bytes = JSON.stringify(row) + '\n';
      const file = join(root, 'chat-1.jsonl');
      await writeFile(file, bytes);
      await rm(join(root, 'chat-1.index.json'), { force: true });
      const loaded: PersistedChatMessage[] = [];
      for await (const entry of readCompleteTranscriptMessages(file))
        loaded.push(entry);
      expect(loaded).toEqual([row]);
      const reopened = new ChatTranscriptLog(root);
      expect(await reopened.readMessage('chat-1', row.id)).toEqual(row);
      expect(await readFile(file, 'utf8')).toBe(bytes);
      // A locator reload must retain its raw-row digest, too.
      expect(
        await new ChatTranscriptLog(root).readMessage('chat-1', row.id),
      ).toEqual(row);
    },
  );

  it('projects the newest conversational role across append, sidecar, reload, rebuild and replacement', async () => {
    expect(await log.descriptor('chat-1')).not.toHaveProperty(
      'lastMessageRole',
    );
    await log.append('chat-1', [message(1, 'user'), message(2, 'system')]);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'user',
    });
    await log.writeActive('chat-1', [
      message(3, 'assistant'),
      message(4, 'system'),
    ]);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'assistant',
    });
    await log.append('chat-1', [message(3, 'assistant'), message(4, 'system')]);
    log = new ChatTranscriptLog(root);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'assistant',
    });
    await rm(join(root, 'chat-1.index.json'), { force: true });
    log = new ChatTranscriptLog(root);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'assistant',
    });
    await log.replace('chat-1', [message(1, 'user')], 10);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'user',
    });
    await log.replaceActive('chat-1', [message(5, 'assistant')]);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'assistant',
    });
    await log.replaceActive('chat-1', [message(6, 'system')]);
    expect(await log.descriptor('chat-1')).toMatchObject({
      lastMessageRole: 'user',
    });
    await log.replace('chat-1', [message(7, 'system')], 20);
    expect(await log.descriptor('chat-1')).not.toHaveProperty(
      'lastMessageRole',
    );
    await log.replace('chat-1', [], 21);
    expect(await log.descriptor('chat-1')).not.toHaveProperty(
      'lastMessageRole',
    );
  });

  it('requires every visual reference field and the exact message and tool owner', async () => {
    // Appends verify referenced artifacts, so store the document first.
    const stored = await log.artifacts.putVisual('chat-1', '<p>visual</p>');
    const reference: PersistedVisualReference = {
      version: 1,
      visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
      artifactId: stored.artifactId,
      byteLength: stored.byteLength,
      sha256: stored.sha256,
      mediaType: 'text/html',
      title: 'Visual',
      maxHeight: 400,
      heights: [[100, 200]],
    };
    await log.append('chat-1', [
      {
        id: 'result',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'call',
            toolName: 'ShowVisual',
            output: '',
            isError: false,
            visualRef: reference,
          },
        ],
      },
    ]);
    expect(
      await log.ownsVisualReference('chat-1', 'result', 'call', reference),
    ).toBe(true);
    const mismatches: PersistedVisualReference[] = [
      { ...reference, title: 'Other' },
      { ...reference, maxHeight: 401 },
      { ...reference, visualId: 'vis_123e4567-e89b-42d3-a456-426614174001' },
      { ...reference, heights: undefined },
      { ...reference, heights: [] },
      { ...reference, heights: [[100, 201]] },
    ];
    for (const mismatch of mismatches)
      expect(
        await log.ownsVisualReference('chat-1', 'result', 'call', mismatch),
      ).toBe(false);
    expect(
      await log.ownsVisualReference('chat-1', 'other', 'call', reference),
    ).toBe(false);
    expect(
      await log.ownsVisualReference('chat-1', 'result', 'other', reference),
    ).toBe(false);
    await log.writeActive('chat-1', [
      {
        id: 'active',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'active-call',
            toolName: 'ShowVisual',
            output: '',
            isError: false,
            visualRef: reference,
          },
        ],
      },
    ]);
    expect(
      await log.ownsVisualReference(
        'chat-1',
        'active',
        'active-call',
        reference,
      ),
    ).toBe(true);
  });

  it('reads an old message by locator without scanning surrounding history', async () => {
    await log.append(
      'chat-1',
      Array.from({ length: 1600 }, (_, i) => message(i)),
    );
    await log.writeActive('chat-1', [message(1600)]);
    const scan = jest.spyOn(fs, 'createReadStream');
    expect(await log.readMessage('chat-1', 'm-0')).toEqual(message(0));
    expect(await log.readMessage('chat-1', 'm-1600')).toEqual(message(1600));
    expect(await log.readMessage('chat-1', 'absent')).toBeUndefined();
    expect(scan.mock.calls.map(([file]) => String(file))).not.toContain(
      join(root, 'chat-1.jsonl'),
    );
    scan.mockRestore();
    await log.replace('chat-1', [message(1601)]);
    expect(await log.readMessage('chat-1', 'm-0')).toBeUndefined();
    expect(await log.readMessage('chat-1', 'm-1600')).toBeUndefined();
    expect(await log.readMessage('chat-1', 'm-1601')).toEqual(message(1601));
  });

  it('publishes derived message locators without syncing each locator file', async () => {
    const open = fsPromises.open;
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    let locatorFileSyncs = 0;
    jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (String(path).startsWith(`${locatorDirectory}/`)) {
          const sync = handle.sync.bind(handle);
          handle.sync = async (): Promise<void> => {
            locatorFileSyncs += 1;
            await sync();
          };
        }
        return handle;
      });

    await log.append('chat-1', [message(1), message(2), message(3)]);

    expect(locatorFileSyncs).toBe(0);
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1), message(2), message(3)],
    );
  });

  it('invalidates an active-tail snapshot after same-size replacement and in-place edits', async () => {
    await log.writeActive('chat-1', [message(1)]);
    const first = await log.activeMessages('chat-1');
    expect(first).toEqual([message(1)]);
    first.push(message(99));
    if (first[0].blocks[0].type !== 'text')
      throw new Error('Missing active text');
    first[0].blocks[0].text = 'caller mutation';
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
    const path = join(root, 'chat-1.active.json');
    const original = await readFile(path, 'utf8');
    const second = original
      .replaceAll('m-1', 'm-2')
      .replaceAll('message 1', 'message 2')
      .replace('"timestamp":1', '"timestamp":2');
    expect(Buffer.byteLength(second)).toBe(Buffer.byteLength(original));
    const temporary = `${path}.replacement`;
    await writeFile(temporary, second);
    await rename(temporary, path);
    expect(await log.activeMessages('chat-1')).toEqual([message(2)]);

    const before = await stat(path);
    const third = second
      .replaceAll('m-2', 'm-3')
      .replaceAll('message 2', 'message 3')
      .replace('"timestamp":2', '"timestamp":3');
    await writeFile(path, third);
    await utimes(path, before.atime, before.mtime);
    expect(await log.activeMessages('chat-1')).toEqual([message(3)]);
  });

  it('does not serve a cached active tail through a read error and retries when the file returns', async () => {
    await log.writeActive('chat-1', [message(1)]);
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
    const path = join(root, 'chat-1.active.json');
    const backup = `${path}.backup`;
    await rename(path, backup);
    await fsPromises.mkdir(path);

    await expect(log.activeMessages('chat-1')).rejects.toThrow();

    await rm(path, { recursive: true });
    await rename(backup, path);
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
  });

  it('does not serve a cached active tail when its identity check fails', async () => {
    await log.writeActive('chat-1', [message(1)]);
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
    const sidecarPath = join(root, 'chat-1.active.json');
    const statFile = fsPromises.stat;
    const statSpy = jest
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (path, options) => {
        if (path === sidecarPath)
          throw Object.assign(new Error('active stat failed'), { code: 'EIO' });
        return statFile(path, options);
      });

    await expect(log.activeMessages('chat-1')).rejects.toThrow(
      'active stat failed',
    );
    statSpy.mockRestore();
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
  });

  it('propagates a stable active read failure without repeated opens', async () => {
    await log.writeActive('chat-1', [message(1)]);
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
    const sidecarPath = join(root, 'chat-1.active.json');
    const openFile = fsPromises.open;
    let failedOpens = 0;
    const openSpy = jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (path, flags, mode) => {
        if (path === sidecarPath) {
          failedOpens += 1;
          throw Object.assign(new Error('active open failed'), {
            code: 'EIO',
          });
        }
        return openFile(path, flags, mode);
      });
    // A warm cache would avoid open altogether, so first change the sidecar
    // identity without changing its logical content.
    const original = await readFile(sidecarPath);
    const replacement = `${sidecarPath}.replacement`;
    await writeFile(replacement, original);
    await rename(replacement, sidecarPath);

    await expect(log.activeMessages('chat-1')).rejects.toThrow(
      'active open failed',
    );
    expect(failedOpens).toBe(1);
    openSpy.mockRestore();
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
  });

  it('reads a coherent active sidecar when it is atomically replaced during the read', async () => {
    await log.writeActive('chat-1', [message(1)]);
    const sidecarPath = join(root, 'chat-1.active.json');
    const first = await readFile(sidecarPath, 'utf8');
    const second = first
      .replaceAll('m-1', 'm-2')
      .replaceAll('message 1', 'message 2')
      .replace('"timestamp":1', '"timestamp":2');
    expect(Buffer.byteLength(second)).toBe(Buffer.byteLength(first));
    const openFile = fsPromises.open;
    let replaced = false;
    const openSpy = jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const handle = await openFile(path, flags, mode);
        if (path === sidecarPath && !replaced) {
          replaced = true;
          const temporary = `${sidecarPath}.replacement`;
          await writeFile(temporary, second);
          await rename(temporary, sidecarPath);
        }
        return handle;
      });

    const reader = new ChatTranscriptLog(root);
    expect(await reader.activeMessages('chat-1')).toEqual([message(2)]);
    expect(replaced).toBe(true);
    openSpy.mockRestore();
    expect(await reader.activeMessages('chat-1')).toEqual([message(2)]);
  });

  it('invalidates an active tail after a failed publication and successful retry', async () => {
    await log.writeActive('chat-1', [message(1)]);
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
    const updated = {
      ...message(1),
      blocks: [{ type: 'text' as const, text: 'updated message 1\n🌲' }],
    };
    const sidecarPath = join(root, 'chat-1.active.json');
    const renameFile = fsPromises.rename;
    let injected = false;
    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        await renameFile(source, destination);
        if (!injected && destination === sidecarPath) {
          injected = true;
          throw new Error('active publication interrupted');
        }
      });
    await expect(log.writeActive('chat-1', [updated])).rejects.toThrow(
      'active publication interrupted',
    );
    renameSpy.mockRestore();

    expect(await log.activeMessages('chat-1')).toEqual([updated]);
    await log.writeActive('chat-1', [updated]);
    expect(await new ChatTranscriptLog(root).activeMessages('chat-1')).toEqual([
      updated,
    ]);
  });

  it('drops an active snapshot when a chat is removed and recreated', async () => {
    await log.writeActive('chat-1', [message(1)]);
    expect(await log.activeMessages('chat-1')).toEqual([message(1)]);
    await log.remove('chat-1');
    await log.initialize('chat-1');
    await log.writeActive('chat-1', [message(2)]);
    expect(await log.activeMessages('chat-1')).toEqual([message(2)]);
  });

  it('removes stored artifacts from every family with the chat', async () => {
    const artifactId = `sha256-v1-${'a'.repeat(64)}`;
    const toolOutputDirectory = join(root, 'tool-output', 'chat-1');
    const visualDirectory = join(root, 'visuals', 'chat-1');
    await mkdir(toolOutputDirectory, { recursive: true });
    await mkdir(visualDirectory, { recursive: true });
    await writeFile(join(toolOutputDirectory, `${artifactId}.txt`), 'output');
    await writeFile(
      join(visualDirectory, `${artifactId}.html`),
      '<p>visual</p>',
    );

    await log.remove('chat-1');

    await expect(readdir(toolOutputDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readdir(visualDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('evicts active snapshots across log instances under the global byte cap', async () => {
    const logs: ChatTranscriptLog[] = [];
    for (let i = 0; i < 6; i++) {
      const instance = new ChatTranscriptLog(root);
      const chatId = `global-cache-${i}`;
      await instance.initialize(chatId);
      await instance.writeActive(chatId, [
        {
          ...message(i),
          blocks: [{ type: 'text', text: 'x'.repeat(768 * 1024) }],
        },
      ]);
      await instance.activeMessages(chatId);
      logs.push(instance);
    }
    const open = jest.spyOn(fsPromises, 'open');
    await logs[0].activeMessages('global-cache-0');
    expect(
      open.mock.calls.filter(([path]) =>
        String(path).endsWith('global-cache-0.active.json'),
      ).length,
    ).toBeGreaterThan(0);
  }, 30_000);

  it('evicts least-recent active snapshots across log instances by chat count', async () => {
    const logs: ChatTranscriptLog[] = [];
    for (let i = 0; i < 9; i++) {
      const instance = new ChatTranscriptLog(root);
      const chatId = `count-cache-${i}`;
      await instance.initialize(chatId);
      await instance.writeActive(chatId, [message(i)]);
      await instance.activeMessages(chatId);
      logs.push(instance);
    }
    const open = jest.spyOn(fsPromises, 'open');
    await logs[0].activeMessages('count-cache-0');
    expect(
      open.mock.calls.filter(([path]) =>
        String(path).endsWith('count-cache-0.active.json'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('keeps the indexes of more than eight concurrently active chats loaded', async () => {
    const chatIds = Array.from({ length: 16 }, (_, i) => `busy-${i}`);
    for (const chatId of chatIds) {
      await log.initialize(chatId);
      await log.writeActive(chatId, [message(1)]);
      await log.descriptor(chatId);
    }
    const read = jest.spyOn(fsPromises, 'readFile');
    for (const chatId of chatIds) await log.descriptor(chatId);
    expect(
      read.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.endsWith('.index.json'),
      ),
    ).toEqual([]);
  });

  it('probes each active row for a committed copy once per committed history', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    const active = Array.from({ length: 20 }, (_, i) => message(i + 1));
    await log.writeActive('chat-1', active);
    await log.page('chat-1');
    const read = jest.spyOn(fsPromises, 'readFile');
    await log.page('chat-1');
    expect(
      read.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.includes('message-index'),
      ),
    ).toEqual([]);
  });

  it('rewrites journaled active rows probing only rows it has not seen', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    const active = Array.from({ length: 20 }, (_, i) => message(i + 1));
    await log.writeActiveAtRevision('chat-1', active, 5);
    const read = jest.spyOn(fsPromises, 'readFile');
    await log.writeActiveAtRevision('chat-1', [...active, message(21)], 6);
    expect(
      read.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.includes('message-index'),
      ),
    ).toHaveLength(1);
    expect((await log.page('chat-1')).messages).toEqual([
      message(0, 'user'),
      ...active,
      message(21),
    ]);
  });

  it('drops an active row committed after an earlier read found it uncommitted', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    log.setActiveProjection((chatId) =>
      chatId === 'chat-1'
        ? { messages: [message(1), message(2)], transcriptRevision: 9 }
        : undefined,
    );
    const expected = [message(0, 'user'), message(1), message(2)];
    expect((await log.page('chat-1')).messages).toEqual(expected);
    await log.append('chat-1', [message(1)]);
    expect((await log.page('chat-1')).messages).toEqual(expected);
  });

  it('does not retain an oversized active snapshot in memory', async () => {
    await log.writeActive('chat-1', [
      {
        ...message(1),
        blocks: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }],
      },
    ]);
    await log.activeMessages('chat-1');
    const open = jest.spyOn(fsPromises, 'open');
    await log.activeMessages('chat-1');
    expect(
      open.mock.calls.filter(([path]) =>
        String(path).endsWith('chat-1.active.json'),
      ).length,
    ).toBeGreaterThan(0);
  }, 30_000);

  it('invalidates a cached committed page on same-size history edits, page boundaries, and recreation', async () => {
    const history = Array.from({ length: 600 }, (_, id) => message(id));
    await log.replace('chat-1', history, 1);
    const recent = await log.page('chat-1');
    expect(recent.messages).toEqual(history.slice(100));
    const older = await log.page('chat-1', recent.before);
    expect(older.messages).toEqual(history.slice(0, 100));

    const path = join(root, 'chat-1.jsonl');
    const before = await stat(path);
    const original = await readFile(path, 'utf8');
    const edited = original.replace('message 599', 'message 598');
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(original));
    await writeFile(path, edited);
    await utimes(path, before.atime, before.mtime);
    const changed = await log.page('chat-1');
    expect(changed.messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'message 598\n🌲' },
    ]);

    await log.remove('chat-1');
    await log.initialize('chat-1');
    await log.append('chat-1', [message(999)]);
    expect((await log.page('chat-1')).messages).toEqual([message(999)]);
  }, 30_000);

  it('reads complete UTF-8 rows across multiple stream chunks and newline boundaries', async () => {
    const rows = [1, 2, 3].map((id) => ({
      ...message(id),
      blocks: [{ type: 'text' as const, text: '🌲\n'.repeat(40000) }],
    }));
    const path = join(root, 'chunked.jsonl');
    await writeFile(
      path,
      rows.map((row) => JSON.stringify(row) + '\n').join(''),
    );
    const actual: PersistedChatMessage[] = [];
    for await (const row of readCompleteTranscriptMessages(path))
      actual.push(row);
    expect(actual).toEqual(rows);
  });

  it('rejects an oversized unterminated row before treating it as an incomplete tail', async () => {
    const path = join(root, 'oversized-incomplete.jsonl');
    await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));

    await expect(
      (async (): Promise<void> => {
        for await (const _row of readCompleteTranscriptMessages(path)) {
          void _row;
        }
      })(),
    ).rejects.toThrow('Transcript row exceeds maximum size');
  });

  it('pages 500 complete messages and preserves the latest human beyond watcher and internal continuation rows', async () => {
    const messages = Array.from({ length: 610 }, (_, i) => message(i));
    messages[0] = message(0, 'user');
    messages[580] = { ...message(580, 'user'), userMessageSource: 'watcher' };
    messages[581] = {
      ...message(581, 'user'),
      userMessageSource: 'deferred_tools_reload',
    };
    messages[582] = {
      ...message(582, 'user'),
      userMessageSource: 'immediate_turn_restart',
    };
    await log.append('chat-1', messages);
    const sparse: unknown = JSON.parse(
      await readFile(join(root, 'chat-1.index.json'), 'utf8'),
    );
    if (!isRecord(sparse) || !isUnknownArray(sparse.offsets))
      throw new Error('Invalid sparse index fixture');
    expect(
      sparse.offsets.map((entry) =>
        isRecord(entry) ? entry.ordinal : undefined,
      ),
    ).toEqual([0, 500]);
    const restarted = new ChatTranscriptLog(root);
    const recent = await restarted.page('chat-1');
    expect(recent.messages).toEqual(messages.slice(110));
    expect(recent.latestHumanMessage).toEqual(messages[0]);
    expect(recent.before).toBe(110);
    const older = await restarted.page('chat-1', recent.before);
    expect(older.messages).toEqual(messages.slice(0, 110));
    expect(older.before).toBeUndefined();
    const rows = (await readFile(join(root, 'chat-1.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n');
    const parsedRows: unknown[] = [];
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row);
      parsedRows.push(parsed);
    }
    expect(parsedRows.every(isPersistedChatMessage)).toBe(true);
    expect(parsedRows).toEqual(messages);
  }, 30_000);

  it.each([1, 2, 3, 4])(
    'rebuilds a v%s turn cache without inventing a working timer for a standalone historical prompt',
    async (version) => {
      await log.replace('chat-1', [message(0, 'user')], 1);
      const first = await log.page('chat-1', undefined, { view: 'turns' });
      expect(first.turns?.[0].frameTimer).toBeUndefined();
      const cachePath = join(root, 'chat-1.turns.json');
      const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
      if (!isRecord(cached)) throw new Error('Expected turn-index cache');
      const { checksum: oldChecksum, ...legacyBody } = cached;
      void oldChecksum;
      legacyBody.version = version;
      await writeFile(
        cachePath,
        JSON.stringify({
          ...legacyBody,
          checksum: createHash('sha256')
            .update(JSON.stringify(legacyBody))
            .digest('hex'),
        }),
      );
      await new ChatTranscriptLog(root).page('chat-1', undefined, {
        view: 'turns',
      });
      expect(await readFile(cachePath, 'utf8')).toContain('"version":5');
      await log.replace(
        'chat-1',
        [
          message(0, 'user'),
          message(1, 'user'),
          {
            ...message(2, 'system'),
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
          },
          message(3),
        ],
        2,
      );
      const after = await new ChatTranscriptLog(root).page(
        'chat-1',
        undefined,
        {
          view: 'turns',
        },
      );
      expect(after.turns?.[0].frameTimer).toBeUndefined();
    },
  );

  it('rebuilds a v3 turn cache that hid an account proxy switch in a finished turn', async () => {
    await log.replace(
      'chat-1',
      [
        message(0, 'user'),
        { ...message(1), blocks: [{ type: 'thinking', text: 'Working' }] },
        {
          ...message(2, 'system'),
          blocks: [
            {
              type: 'account_proxy_switch',
              timestamp: 2,
              account: 'sam@example.com',
              previousAccount: 'ops@example.com',
              previousAtLimit: true,
            },
          ],
        },
        message(3),
        {
          ...message(4, 'system'),
          blocks: [{ type: 'turn_timer', startedAt: 0, completedAt: 4 }],
        },
      ],
      1,
    );
    const first = await log.page('chat-1', undefined, { view: 'turns' });
    // The switch stays beside the final answer of the collapsed turn.
    expect(first.turns?.[0].finalMessageIds).toEqual(['m-2', 'm-3']);

    // A cache written before that rule kept only the final answer.
    const cachePath = join(root, 'chat-1.turns.json');
    const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
    if (!isRecord(cached) || !isUnknownArray(cached.turns))
      throw new Error('Expected turn-index cache');
    const { checksum: oldChecksum, ...legacyBody } = cached;
    void oldChecksum;
    legacyBody.version = 3;
    legacyBody.turns = cached.turns.map((turn) =>
      isRecord(turn) &&
      isUnknownArray(turn.retained) &&
      isUnknownArray(turn.finalMessageIds)
        ? {
            ...turn,
            retained: turn.retained.filter((ordinal) => ordinal !== 2),
            finalMessageIds: turn.finalMessageIds.filter((id) => id !== 'm-2'),
          }
        : turn,
    );
    await writeFile(
      cachePath,
      JSON.stringify({
        ...legacyBody,
        checksum: createHash('sha256')
          .update(JSON.stringify(legacyBody))
          .digest('hex'),
      }),
    );

    const after = await new ChatTranscriptLog(root).page('chat-1', undefined, {
      view: 'turns',
    });
    expect(after.turns?.[0].finalMessageIds).toEqual(['m-2', 'm-3']);
    expect(await readFile(cachePath, 'utf8')).toContain('"version":5');
  });

  it('keeps created files when their tool calls are outside a historical turn window', async () => {
    const rows: PersistedChatMessage[] = [
      message(0, 'user'),
      {
        ...message(1),
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'write-report',
            toolName: 'Write',
            input: JSON.stringify({
              file_path: '/project/report.md',
              content: '# Report',
            }),
          },
        ],
      },
      {
        ...message(2, 'system'),
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'write-report',
            toolName: 'Write',
            output: 'File created successfully',
            isError: false,
          },
        ],
      },
      ...Array.from({ length: 30 }, (_, i) => message(i + 3)),
      {
        ...message(33, 'system'),
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
      },
      message(34, 'user'),
      message(35),
      {
        ...message(36, 'system'),
        blocks: [{ type: 'turn_timer', startedAt: 3, completedAt: 4 }],
      },
    ];
    await log.replace('chat-1', rows, 1);
    const page = await new ChatTranscriptLog(root).page('chat-1', undefined, {
      view: 'turns',
    });
    expect(page.messages.some((row) => row.id === rows[1].id)).toBe(false);
    expect(page.turns?.[0]).toMatchObject({
      files: [{ path: '/project/report.md', state: 'ready' }],
    });
    expect(page.turns?.[1]).toMatchObject({ files: [] });
  });

  it('reads an older turn by id without a cursor after newer turns', async () => {
    const rows = [0, 3].flatMap((start) => [
      message(start, 'user'),
      message(start + 1),
      {
        ...message(start + 2, 'system'),
        blocks: [{ type: 'turn_timer' as const, startedAt: 1, completedAt: 2 }],
      },
    ]);
    await log.replace('chat-1', rows, 1);

    const page = await log.page('chat-1', undefined, {
      view: 'turns',
      turnId: 'm-0',
    });

    expect(page.turns?.map((turn) => turn.id)).toEqual(['m-0']);
    expect(page.messages.map((row) => row.id)).toEqual(['m-0', 'm-1', 'm-2']);
  });

  it('projects oversized turns with their sticky frame and exact condensed tool counts', async () => {
    const rows = Array.from({ length: 3 }, (_, turn) => [
      message(turn * 2000, 'user'),
      {
        ...message(turn * 2000 + 1, 'system'),
        blocks: [{ type: 'turn_timer' as const, startedAt: 1, completedAt: 2 }],
      },
      ...Array.from({ length: 1250 }, (_, index) => ({
        ...message(turn * 2000 + index + 2),
        blocks: [
          {
            type: 'tool_use' as const,
            toolUseId: `read-${turn}-${index}`,
            toolName: 'Read',
            input: '{}',
          },
        ],
      })),
      message(turn * 2000 + 1252),
    ]).flat();
    await log.replace('chat-1', rows, 1);
    const page = await log.page('chat-1', undefined, { view: 'turns' });
    expect(page.messages.some((row) => row.id === 'm-4000')).toBe(true);
    expect(page.messages.some((row) => row.id === 'm-4001')).toBe(true);
    expect(page.messages.some((row) => row.id === 'm-1252')).toBe(true);
    expect(page.messages.length).toBeLessThan(1200);
    expect(page.turns).toHaveLength(3);
    expect(page.turns?.[0].summary.read).toBe(1250);
    expect(page.messages.some((row) => row.id === 'm-2')).toBe(false);
    let before = page.turns?.[0].before;
    const loaded = new Map(page.messages.map((row) => [row.id, row]));
    while (before !== undefined) {
      const older = await log.page('chat-1', before, {
        view: 'turns',
        turnId: 'm-0',
      });
      expect(older.turns?.[0].summary.read).toBe(1250);
      for (const row of older.messages) loaded.set(row.id, row);
      before = older.turns?.[0].before;
    }
    expect(loaded.get('m-2')).toEqual(rows[2]);
    expect(
      Array.from(loaded.values()).filter((row) => row.timestamp < 2000),
    ).toHaveLength(1253);
    await writeFile(join(root, 'chat-1.turns.json'), '{broken cache');
    expect(
      (
        await new ChatTranscriptLog(root).page('chat-1', undefined, {
          view: 'turns',
        })
      ).turns,
    ).toEqual(page.turns);
  }, 300_000);

  it('reads nearby completed turn frames without repeatedly scanning the same sparse blocks', async () => {
    const rows = Array.from({ length: 20 }, (_, turn) => [
      message(turn * 53, 'user'),
      {
        ...message(turn * 53 + 1, 'system'),
        blocks: [{ type: 'turn_timer' as const, startedAt: 1, completedAt: 2 }],
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        ...message(turn * 53 + index + 2),
        blocks: [
          {
            type: 'tool_use' as const,
            toolUseId: `${turn}-${index}`,
            toolName: 'Read',
            input: '{}',
          },
        ],
      })),
      message(turn * 53 + 52),
    ]).flat();
    await log.replace('chat-1', rows, 1);
    // Build the derived turn index before measuring ordinary page reads.
    await log.page('chat-1', undefined, { view: 'turns' });
    const streams = jest.spyOn(fs, 'createReadStream');
    try {
      const page = await log.page('chat-1', undefined, { view: 'turns' });
      expect(page.messages).toEqual(
        rows.filter(
          (_, ordinal) =>
            ordinal >= 19 * 53 || ordinal % 53 < 2 || ordinal % 53 >= 37,
        ),
      );
      expect(page.turns).toHaveLength(20);
      expect(
        page.turns?.every((turn) => turn.complete && turn.summary.read === 50),
      ).toBe(true);
      // Reading this ~1,000-row history must not open one stream per turn.
      expect(
        streams.mock.calls.filter(
          ([path]) => path === join(root, 'chat-1.jsonl'),
        ).length,
      ).toBeLessThanOrEqual(4);
    } finally {
      streams.mockRestore();
    }
  }, 60_000);

  it('retains the last human turn frame across a page of watcher turns', async () => {
    const rows = Array.from({ length: 105 }, (_, index) => [
      {
        ...message(index * 3, 'user'),
        ...(index ? { userMessageSource: 'watcher' as const } : {}),
      },
      {
        ...message(index * 3 + 1, 'system'),
        blocks: [{ type: 'turn_timer' as const, completedAt: 2 }],
      },
      message(index * 3 + 2),
    ]).flat();
    await log.append('chat-1', rows);
    const page = await log.page('chat-1', undefined, { view: 'turns' });
    expect(page.messages.some((row) => row.id === 'm-0')).toBe(true);
    expect(page.before).toBe(15);
  }, 30_000);

  it('buffers a running text-only turn, preserves its prompt, and reads through a missing cache without writing in read-only mode', async () => {
    const rows = [
      message(0, 'user'),
      ...Array.from({ length: 1600 }, (_, index) => message(index + 1)),
    ];
    await log.replace('chat-1', rows, 1);
    await log.writeActive('chat-1', [message(1601)]);
    const cachePath = join(root, 'chat-1.turns.json');
    await rm(cachePath, { force: true });
    const reader = new ChatTranscriptLog(root, undefined, { readOnly: true });
    const page = await reader.page('chat-1', undefined, { view: 'turns' });
    expect(page.messages[0]).toEqual(rows[0]);
    expect(page.messages).toHaveLength(1001); // Prompt and buffered tail; inferred timer stays in view metadata.
    expect(page.messages[page.messages.length - 1]).toEqual(message(1601));
    expect(page.turns?.[0]).toMatchObject({ complete: false, before: 602 });
    await expect(readFile(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await log.page('chat-1')).totalMessages).toBe(1602);
  }, 60_000);

  it('preserves active projections on restart and finalizes without duplicate rows', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    await log.writeActive('chat-1', [message(1), message(2)]);
    const restarted = new ChatTranscriptLog(root);
    expect((await restarted.page('chat-1')).messages).toEqual([
      message(0, 'user'),
      message(1),
      message(2),
    ]);
    await restarted.append('chat-1', [message(1), message(2)]);
    await restarted.append('chat-1', [message(1), message(2)]);
    expect(
      (await new ChatTranscriptLog(root).page('chat-1')).messages,
    ).toHaveLength(3);
    await expect(
      readFile(join(root, 'chat-1.active.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      restarted.append('chat-1', [{ ...message(1), blocks: [] }]),
    ).rejects.toThrow('Conflicting');
  });

  it('stores active messages as independently bounded stream rows', async () => {
    const active = [message(1), message(2), message(3)];
    await log.writeActive('chat-1', active);

    const stored = await readFile(join(root, 'chat-1.active.json'), 'utf8');
    const rows = stored.trimEnd().split('\n');
    expect(rows).toHaveLength(active.length + 1);
    expect(JSON.parse(rows[0])).toMatchObject({ version: 2 });
    const parsedMessages: PersistedChatMessage[] = [];
    for (const row of rows.slice(1)) {
      const parsed: unknown = JSON.parse(row);
      if (!isRecord(parsed) || !isPersistedChatMessage(parsed.message))
        throw new Error('Invalid active-row fixture');
      parsedMessages.push(parsed.message);
    }
    expect(parsedMessages).toEqual(active);
    expect(await new ChatTranscriptLog(root).activeMessages('chat-1')).toEqual(
      active,
    );
  });

  it('streams legacy active sidecars during a rolling upgrade', async () => {
    const active = [message(1), message(2), message(3)];
    await writeFile(
      join(root, 'chat-1.active.json'),
      JSON.stringify({
        version: 1,
        transcriptRevision: 7,
        updatedAt: '2026-09-15T00:00:00.000Z',
        messages: active,
        finalizing: {
          stagedId: 'missing-stage',
          byteOffset: 0,
          messageIds: ['m-1'],
        },
      }),
    );

    expect(await new ChatTranscriptLog(root).activeMessages('chat-1')).toEqual(
      active,
    );
    expect(
      JSON.parse(
        (await readFile(join(root, 'chat-1.active.json'), 'utf8')).split(
          '\n',
        )[0],
      ),
    ).toMatchObject({ version: 2 });
  });

  it('returns a full committed page before appending active projections', async () => {
    const committed = Array.from({ length: 510 }, (_, id) => message(id));
    const active = Array.from({ length: 20 }, (_, id) => message(600 + id));
    await log.append('chat-1', committed);
    await log.writeActive('chat-1', active);

    const recent = await log.page('chat-1');
    expect(recent.messages).toEqual([...committed.slice(10), ...active]);
    expect(recent.totalMessages).toBe(530);
    expect(recent.before).toBe(10);

    const older = await log.page('chat-1', recent.before);
    expect(older.messages).toEqual(committed.slice(0, 10));
    expect(older.before).toBeUndefined();
  }, 30_000);

  it.each([
    [
      'text',
      (text: string): PersistedChatMessage['blocks'] => [
        { type: 'text', text },
      ],
    ],
    [
      'tool_use input',
      (text: string): PersistedChatMessage['blocks'] => [
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'Bash',
          input: text,
        },
      ],
    ],
  ])(
    'rejects an oversized %s row before publishing a finalization intent',
    async (_kind, blocks) => {
      await log.append('chat-1', [message(0, 'user')]);
      const oversized: PersistedChatMessage = {
        ...message(1),
        blocks: blocks('x'.repeat(16 * 1024 * 1024)),
      };
      await expect(log.append('chat-1', [oversized])).rejects.toThrow(
        'exceeds maximum size',
      );
      // Nothing may be staged or published: the log must stay readable.
      await expect(
        readFile(join(root, 'chat-1.active.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await readdir(root)).filter((name) => name.endsWith('.append.tmp')),
      ).toEqual([]);
      expect(
        (await new ChatTranscriptLog(root).page('chat-1')).messages,
      ).toEqual([message(0, 'user')]);
      await expect(
        log.replace('chat-1', [message(0, 'user'), oversized], 2),
      ).rejects.toThrow('exceeds maximum size');
      expect(
        (await new ChatTranscriptLog(root).page('chat-1')).messages,
      ).toEqual([message(0, 'user')]);
    },
  );

  it('abandons an unapplied finalization intent whose staged rows are unreadable instead of failing every load', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    const interrupted = new ChatTranscriptLog(root, (at) =>
      at === 'prepared'
        ? Promise.reject(new Error('interrupted'))
        : Promise.resolve(),
    );
    await expect(interrupted.append('chat-1', [message(1)])).rejects.toThrow(
      'interrupted',
    );
    const staged = (await readdir(root)).filter((name) =>
      name.endsWith('.append.tmp'),
    );
    expect(staged).toHaveLength(1);
    await writeFile(join(root, staged[0]), '{broken staged row');
    const recovered = new ChatTranscriptLog(root);
    // The staged rows were never applied and remain in the durable active
    // projection, so nothing is lost by dropping the intent.
    expect((await recovered.page('chat-1')).messages).toEqual([
      message(0, 'user'),
      message(1),
    ]);
    expect(
      (await readdir(root)).filter((name) => name.endsWith('.append.tmp')),
    ).toEqual([]);
    await recovered.append('chat-1', [message(1)]);
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(0, 'user'), message(1)],
    );
    await expect(
      readFile(join(root, 'chat-1.active.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps failing closed when an unreadable staged append already extended the log', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    const interrupted = new ChatTranscriptLog(root, (at) =>
      at === 'prepared'
        ? Promise.reject(new Error('interrupted'))
        : Promise.resolve(),
    );
    await expect(interrupted.append('chat-1', [message(1)])).rejects.toThrow(
      'interrupted',
    );
    const staged = (await readdir(root)).filter((name) =>
      name.endsWith('.append.tmp'),
    );
    await appendFile(join(root, 'chat-1.jsonl'), '{"partial');
    await writeFile(join(root, staged[0]), '{broken staged row');
    await expect(new ChatTranscriptLog(root).page('chat-1')).rejects.toThrow();
    expect(
      (await readdir(root)).filter((name) => name.endsWith('.append.tmp')),
    ).toEqual(staged);
  });

  it('removes staged append files that no finalization intent references', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    await log.initialize('chat-2');
    const orphan = join(root, 'chat-1.orphan.append.tmp');
    const sibling = join(root, 'chat-2.orphan.append.tmp');
    await writeFile(orphan, JSON.stringify(message(9)) + '\n');
    await writeFile(sibling, JSON.stringify(message(9)) + '\n');
    const reader = new ChatTranscriptLog(root, undefined, { readOnly: true });
    expect((await reader.page('chat-1')).messages).toEqual([
      message(0, 'user'),
    ]);
    await expect(readFile(orphan)).resolves.toBeDefined();
    const restarted = new ChatTranscriptLog(root);
    expect((await restarted.page('chat-1')).messages).toEqual([
      message(0, 'user'),
    ]);
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(sibling)).resolves.toBeDefined();
  });

  it('does not turn a missing indexed transcript into an empty chat', async () => {
    await expect(log.page('missing-chat')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not reorder active messages when a later message settles first', async () => {
    await log.writeActive('chat-1', [message(1), message(2)]);
    await expect(log.append('chat-1', [message(2)])).rejects.toThrow('order');
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1), message(2)],
    );
  });

  it('does not lose active content through an empty replacement', async () => {
    await log.writeActive('chat-1', [message(1)]);
    await expect(log.writeActive('chat-1', [])).rejects.toThrow('discard');
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1)],
    );
  });

  it('streams only the active sidecar when a preview reuses its committed prefix', async () => {
    await log.append('chat-1', [message(1), message(2)]);
    await log.writeActive('chat-1', [message(3)]);
    const preview = await log.capturePreview(
      'chat-1',
      await log.descriptor('chat-1'),
    );
    try {
      const ids: string[] = [];
      for await (const row of preview.activeMessages()) ids.push(row.id);
      expect(ids).toEqual(['m-3']);
      expect(() => preview.assertComplete()).not.toThrow();
    } finally {
      await preview.close();
    }
  });

  it('completes an active-only preview without a sidecar', async () => {
    await log.append('chat-1', [message(1)]);
    const preview = await log.capturePreview(
      'chat-1',
      await log.descriptor('chat-1'),
    );
    try {
      const ids: string[] = [];
      for await (const row of preview.activeMessages()) ids.push(row.id);
      expect(ids).toEqual([]);
      expect(() => preview.assertComplete()).not.toThrow();
    } finally {
      await preview.close();
    }
  });

  it('refuses an active-only preview after a later append instead of trusting growth', async () => {
    await log.append('chat-1', [message(1)]);
    const preview = await log.capturePreview(
      'chat-1',
      await log.descriptor('chat-1'),
    );
    try {
      // The active-only read never checks committed bytes, so any change to
      // the committed file after capture sends callers to a full read.
      await log.append('chat-1', [message(2)]);
      const read = async (): Promise<void> => {
        for await (const row of preview.activeMessages()) void row;
      };
      await expect(read()).rejects.toThrow('Transcript preview changed');
    } finally {
      await preview.close();
    }
  });

  it('rejects an active-only preview after an in-place edit of the committed log', async () => {
    await log.append('chat-1', [message(1), message(2)]);
    await log.writeActive('chat-1', [message(3)]);
    const preview = await log.capturePreview(
      'chat-1',
      await log.descriptor('chat-1'),
    );
    try {
      const committedPath = join(root, 'chat-1.jsonl');
      const original = await readFile(committedPath, 'utf8');
      await writeFile(
        committedPath,
        original.replace('message 1', 'message 7'),
      );
      // A same-length rewrite can land in the same filesystem timestamp tick
      // as the capture on fast CI hosts. Advance mtime explicitly so the
      // edit is visible to the stat signature on the held inode.
      const changedAt = new Date(Date.now() + 60_000);
      await utimes(committedPath, changedAt, changedAt);
      const read = async (): Promise<void> => {
        for await (const row of preview.activeMessages()) void row;
      };
      await expect(read()).rejects.toThrow('Transcript preview changed');
    } finally {
      await preview.close();
    }
  });

  it('rejects an active-only preview when the committed log is edited in place and then grows', async () => {
    await log.append('chat-1', [message(1), message(2)]);
    await log.writeActive('chat-1', [message(3)]);
    const preview = await log.capturePreview(
      'chat-1',
      await log.descriptor('chat-1'),
    );
    try {
      // Growth alone cannot vouch for committed bytes the active-only read
      // never checks: rewrite the captured prefix on the same inode and
      // extend the file in one write.
      const committedPath = join(root, 'chat-1.jsonl');
      const original = await readFile(committedPath, 'utf8');
      await writeFile(
        committedPath,
        `${original.replace('message 1', 'message 7')}${JSON.stringify(message(4))}\n`,
      );
      const read = async (): Promise<void> => {
        for await (const row of preview.activeMessages()) void row;
      };
      await expect(read()).rejects.toThrow('Transcript preview changed');
    } finally {
      await preview.close();
    }
  });

  it('chains a committed digest that tracks same-length row edits but not sidecar updates', async () => {
    const rowDigest = (row: PersistedChatMessage): string =>
      createHash('sha256').update(JSON.stringify(row)).digest('hex');
    const extend = (previous: string, row: PersistedChatMessage): string =>
      createHash('sha256')
        .update(previous)
        .update(rowDigest(row))
        .digest('hex');
    const empty = await log.descriptor('chat-1');
    expect(empty.committedDigest).toMatch(/^[a-f0-9]{64}$/);
    await log.append('chat-1', [message(1), message(2)]);
    const two = await log.descriptor('chat-1');
    expect(two.committedDigest).toBe(
      extend(extend(empty.committedDigest ?? '', message(1)), message(2)),
    );
    await log.append('chat-1', [message(3)]);
    const three = await log.descriptor('chat-1');
    expect(three.committedDigest).toBe(
      extend(two.committedDigest ?? '', message(3)),
    );
    await log.writeActive('chat-1', [message(4)]);
    const streaming = await log.descriptor('chat-1');
    expect(streaming.transcriptRevision).toBeGreaterThan(
      three.transcriptRevision,
    );
    expect(streaming.hasActiveSidecar).toBe(true);
    expect(streaming.committedDigest).toBe(three.committedDigest);
    // An in-place edit that keeps every byte length changes only the digest.
    const edited: PersistedChatMessage = {
      ...message(2),
      blocks: [{ type: 'text', text: 'message 9\n🌲' }],
    };
    await log.replace(
      'chat-1',
      [message(1), edited, message(3)],
      streaming.transcriptRevision + 1,
    );
    const replaced = await log.descriptor('chat-1');
    expect(replaced.committedMessageCount).toBe(three.committedMessageCount);
    expect(replaced.committedByteLength).toBe(three.committedByteLength);
    expect(replaced.committedDigest).not.toBe(three.committedDigest);
    expect(replaced.committedDigest).toBe(
      extend(
        extend(extend(empty.committedDigest ?? '', message(1)), edited),
        message(3),
      ),
    );
    // A rebuild from the JSONL reproduces the chain exactly.
    const indexPath = join(root, 'chat-1.index.json');
    await rm(indexPath);
    expect(
      (await new ChatTranscriptLog(root).descriptor('chat-1')).committedDigest,
    ).toBe(replaced.committedDigest);
    // An older index without the field is rebuilt rather than trusted.
    const stored: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!isRecord(stored)) throw new Error('Invalid sparse index fixture');
    const { checksum: _checksum, committedDigest: _digest, ...legacy } = stored;
    void _checksum;
    void _digest;
    legacy.version = 2;
    await writeFile(
      indexPath,
      JSON.stringify({
        ...legacy,
        checksum: createHash('sha256')
          .update(JSON.stringify(legacy))
          .digest('hex'),
      }),
    );
    expect(
      (await new ChatTranscriptLog(root).descriptor('chat-1')).committedDigest,
    ).toBe(replaced.committedDigest);
    expect(await readFile(indexPath, 'utf8')).toContain(
      `"committedDigest":"${replaced.committedDigest}"`,
    );
  });

  it('rebuilds a corrupt sparse index instead of returning an empty history', async () => {
    await log.append('chat-1', [message(1)]);
    const indexPath = join(root, 'chat-1.index.json');
    const index: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!isRecord(index)) throw new Error('Invalid sparse index fixture');
    index.committedMessageCount = 0;
    index.offsets = [];
    await writeFile(indexPath, JSON.stringify(index));
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1)],
    );
  });

  it('stores exact tool-output ownership outside the bounded sparse index', async () => {
    const reference = {
      version: 1 as const,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 80_000,
      encoding: 'utf-8' as const,
      mediaType: 'text/plain' as const,
    };
    const toolMessage: PersistedChatMessage = {
      ...message(1),
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'shell',
          output: 'preview',
          isError: false,
          fullOutputRef: reference,
        },
      ],
    };
    await writeFile(
      join(root, 'chat-1.jsonl'),
      `${JSON.stringify(toolMessage)}\n`,
    );
    await new ChatTranscriptLog(root).page('chat-1');
    const restarted = new ChatTranscriptLog(root);
    await expect(
      restarted.ownsToolOutputReference(
        'chat-1',
        toolMessage.id,
        'call',
        reference,
      ),
    ).resolves.toBe(true);
    await expect(
      restarted.ownsToolOutputReference('chat-1', toolMessage.id, 'call', {
        ...reference,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toBe(false);
    const sparse: unknown = JSON.parse(
      await readFile(join(root, 'chat-1.index.json'), 'utf8'),
    );
    expect(sparse).not.toHaveProperty('toolOutputOwnership');
  });

  it('uses keyed committed identities without scanning old rows after restart', async () => {
    const history = Array.from({ length: 600 }, (_, id) => message(id));
    await log.append('chat-1', history);

    const transcriptPath = join(root, 'chat-1.jsonl');
    const bytes = await readFile(transcriptPath);
    const firstText = bytes.indexOf('message 0');
    if (firstText < 0) throw new Error('Missing first transcript row');
    bytes[firstText] = 0xff;
    await writeFile(transcriptPath, bytes);

    const restarted = new ChatTranscriptLog(root);
    await expect(
      restarted.append('chat-1', [message(600)]),
    ).resolves.toBeUndefined();
    await expect(
      restarted.committedMessageState('chat-1', message(599)),
    ).resolves.toBe('identical');
  }, 30_000);

  it.each(['directory', 'one locator'])(
    'rebuilds a missing %s before retrying a committed append',
    async (missing) => {
      const history = [message(1), message(2)];
      await log.replace('chat-1', history, 4);
      const directory = join(root, 'message-index', 'chat-1');
      await rm(
        missing === 'directory'
          ? directory
          : join(
              directory,
              `${createHash('sha256').update('m-1').digest('hex')}.json`,
            ),
        { recursive: true },
      );
      const restarted = new ChatTranscriptLog(root);
      await expect(
        restarted.committedMessageState('chat-1', history[0]),
      ).resolves.toBe('identical');
      await restarted.append('chat-1', [history[0], message(3)]);
      expect((await restarted.page('chat-1')).messages).toEqual([
        ...history,
        message(3),
      ]);
      expect(
        (await readFile(join(root, 'chat-1.jsonl'), 'utf8')).trim().split('\n'),
      ).toHaveLength(3);
    },
  );

  it('reads committed output ownership with missing locators without modifying a read-only archive', async () => {
    const output = {
      ...message(1),
      blocks: [
        {
          type: 'tool_result' as const,
          toolUseId: 'call',
          toolName: 'Read',
          isError: false,
          output: 'x'.repeat(70000),
        },
      ],
    };
    await log.append('chat-1', [output]);
    const page = await log.page('chat-1');
    const block = page.messages[0].blocks[0];
    if (block.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing artifact fixture');
    await rm(join(root, 'message-index', 'chat-1'), { recursive: true });
    const reader = new ChatTranscriptLog(root, undefined, { readOnly: true });
    await expect(
      reader.ownsToolOutputReference(
        'chat-1',
        'm-1',
        'call',
        block.fullOutputRef,
      ),
    ).resolves.toBe(true);
    await expect(
      readdir(join(root, 'message-index', 'chat-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates cached locators after a directory entry disappears', async () => {
    await log.replace('chat-1', [message(1), message(2)], 2);
    await log.descriptor('chat-1');
    const directory = join(root, 'message-index', 'chat-1');
    await rm(
      join(
        directory,
        `${createHash('sha256').update('m-1').digest('hex')}.json`,
      ),
    );
    // Some CI filesystems coalesce rapid directory metadata updates. Advance
    // the stamp explicitly so this fixture deterministically exercises cache
    // revalidation instead of depending on host timestamp resolution.
    const changedAt = new Date(Date.now() + 60_000);
    await utimes(directory, changedAt, changedAt);
    await log.append('chat-1', [message(1), message(3)]);
    expect((await log.page('chat-1')).messages).toEqual([
      message(1),
      message(2),
      message(3),
    ]);
  });

  it.each([false, true])(
    'recovers an incompletely written locator with readOnly=%s',
    async (readOnly) => {
      await log.replace('chat-1', [message(1)], 1);
      const path = join(
        root,
        'message-index',
        'chat-1',
        `${createHash('sha256').update('m-1').digest('hex')}.json`,
      );
      await writeFile(path, '{"version":1,');
      const reader = new ChatTranscriptLog(root, undefined, { readOnly });
      await expect(
        reader.committedMessageState('chat-1', message(1)),
      ).resolves.toBe('identical');
      if (readOnly) expect(await readFile(path, 'utf8')).toBe('{"version":1,');
      else {
        await writeFile(path, '{"version":1,');
        await reader.append('chat-1', [message(1), message(2)]);
        expect((await reader.descriptor('chat-1')).messageCount).toBe(2);
        expect((await reader.page('chat-1')).messages).toEqual([
          message(1),
          message(2),
        ]);
      }
    },
  );

  it.each([1, 64])(
    'rejects duplicate replacements across %i locator writes without replacing committed history',
    async (count) => {
      await log.replace('chat-1', [message(99)], 9);
      await expect(
        log.replace(
          'chat-1',
          [
            ...Array.from({ length: count }, (_, i) => message(i + 1)),
            message(1),
          ],
          10,
        ),
      ).rejects.toThrow(/duplicate/i);
      expect((await log.page('chat-1')).messages).toEqual([message(99)]);
    },
  );

  it('preserves invalid UTF-8 as an explicit corruption error', async () => {
    const bytes = Buffer.from(JSON.stringify(message(1)) + '\n');
    bytes[bytes.indexOf('message 1')] = 0xff;
    await writeFile(join(root, 'chat-1.jsonl'), bytes);
    await expect(new ChatTranscriptLog(root).page('chat-1')).rejects.toThrow();
    expect(await readFile(join(root, 'chat-1.jsonl'))).toEqual(bytes);
  });

  it('reads archived-container logs without writing missing sparse indexes', async () => {
    await log.append('chat-1', [message(1)]);
    await rm(join(root, 'chat-1.index.json'), { force: true });
    const before = await readdir(root);
    const reader = new ChatTranscriptLog(root, undefined, { readOnly: true });
    expect((await reader.page('chat-1')).messages).toEqual([message(1)]);
    expect(await readdir(root)).toEqual(before);
    await expect(reader.append('chat-1', [message(2)])).rejects.toThrow(
      'read-only',
    );
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1)],
    );
  });

  it('reads a lean chat independently of a corrupt sibling log', async () => {
    await log.append('chat-1', [message(1)]);
    await appendFile(
      join(root, 'large-sibling.jsonl'),
      'malformed sibling'.repeat(10_000),
    );
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1)],
    );
  });

  it.each(['prepared', 'appended'] as const)(
    'recovers a finalization interrupted after %s',
    async (boundary) => {
      const interrupted = new ChatTranscriptLog(root, (at) => {
        if (at === boundary) return Promise.reject(new Error('interrupted'));
        return Promise.resolve();
      });
      await interrupted.writeActive('chat-1', [message(1)]);
      await expect(
        interrupted.append('chat-1', [message(1), message(2)]),
      ).rejects.toThrow('interrupted');
      if (boundary === 'prepared') {
        await appendFile(
          join(root, 'chat-1.jsonl'),
          JSON.stringify(message(1)).slice(0, 25),
        );
      }
      const recovered = new ChatTranscriptLog(root);
      expect((await recovered.page('chat-1')).messages).toEqual([
        message(1),
        message(2),
      ]);
      await expect(
        readFile(join(root, 'chat-1.active.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
