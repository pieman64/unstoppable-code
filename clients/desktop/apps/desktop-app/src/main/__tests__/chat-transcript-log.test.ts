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
import {
  delegationTranscriptMessages,
  foldTranscriptTodoState,
} from '@canopy/agent-transcript';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type {
  PersistedChatMessage,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import { isHumanAuthoredUserMessage } from '@canopy/agent-transcript/transcript-storage';
import {
  ChatTranscriptLog,
  isDelegationChildRow,
  MAX_TRANSCRIPT_ROW_BYTES,
  readCompleteTranscriptMessages,
} from '../lib/chat-transcript-log';
import {
  activeSidecarMessageRecordBytes,
  checkActiveSidecarMessageRecordBudget,
  type ActiveRowAnchor,
  type ActiveSidecarMessageRecord,
} from '../lib/chat-transcript-live-positions';
import { isPersistedChatMessage } from '../lib/chat-tabs-reader';
import { isRecord } from '../lib/type-guards';
import { logicalTranscriptOracle } from './helpers/logical-transcript-oracle';

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

function row(
  id: string,
  text = id,
  parentBlockId?: string,
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    ...(parentBlockId === undefined ? {} : { parentBlockId }),
    blocks: [{ type: 'text', text }],
  };
}

function delegatedCard(id: string): PersistedChatMessage {
  const messageId = id.startsWith('delegated-agent-')
    ? id
    : `delegated-agent-${id}`;
  const delegationId = messageId.slice('delegated-agent-'.length);
  const event: AgentDelegationTranscript = {
    delegationId,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'parent-harness',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'parent-tool-call',
    createdAt: 1,
    task: {
      description: 'test delegation',
      prompt: 'test delegation prompt',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      status: 'running',
      outputTruncated: false,
      routeSnapshot: {
        selectedModelId: 'model',
        runtimeModelId: 'model',
        harnessId: 'claude',
        runtimeKind: 'sdk',
        runnerRegistrationId: 'claude-runner',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'agent',
        providerType: 'anthropic',
        assignmentRevision: '1',
        billingAuthority: 'local',
        aiCreditsRouted: false,
        capabilities: [],
        supportedThinkingLevels: [],
        capabilitySnapshotHash: 'hash',
        capabilityGeneration: 1,
        policyRevision: '1',
      },
    },
    transcript: [],
  };
  const card = delegationTranscriptMessages(event)[0];
  if (!card || card.id !== messageId)
    throw new Error('Expected delegation card to match its message ID');
  return card;
}

function anchor(
  runId: string,
  after: string | null,
  tie: number,
): ActiveRowAnchor {
  return { version: 1, runId, after, tie };
}

async function invokeLogMethod(
  log: ChatTranscriptLog,
  methodName: string,
  args: unknown[],
): Promise<unknown> {
  const method: unknown = Reflect.get(log, methodName);
  if (typeof method !== 'function')
    throw new Error(`Missing transcript log method: ${methodName}`);
  const result: unknown = Reflect.apply(method, log, args);
  return await Promise.resolve(result);
}

async function appendWithActiveTail(
  log: ChatTranscriptLog,
  chatId: string,
  messages: readonly PersistedChatMessage[],
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  activeTailCount: number,
): Promise<void> {
  await invokeLogMethod(log, 'append', [
    chatId,
    messages,
    anchors,
    activeTailCount,
  ]);
}

function activeSidecarRows(serialized: string): unknown[] {
  return serialized
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return parsed;
    });
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function logicalIteratorMessages(
  log: ChatTranscriptLog,
  chatId: string,
): Promise<PersistedChatMessage[]> {
  const messages: PersistedChatMessage[] = [];
  for await (const message of log.iterateLogical(chatId))
    messages.push(message);
  return messages;
}

async function writeUnvalidatedActiveSidecar(
  root: string,
  chatId: string,
  messages: readonly PersistedChatMessage[],
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  transcriptRevision: number,
): Promise<void> {
  const records = [
    JSON.stringify({
      version: 2,
      transcriptRevision,
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
    ...messages.map((message) => {
      const rowAnchor = anchors.get(message.id);
      return JSON.stringify({
        version: 2,
        kind: 'message',
        message,
        ...(rowAnchor ? { anchor: rowAnchor } : {}),
      });
    }),
  ];
  await writeFile(
    join(root, `${chatId}.active.json`),
    `${records.join('\n')}\n`,
  );
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('complete-message transcript log', () => {
  let root: string;
  let log: ChatTranscriptLog;
  // These disk-backed fixtures create thousands of locators on a loaded host.
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-log-'));
    log = new ChatTranscriptLog(root);
    await log.initialize('chat-1');
  }, 30_000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }, 30_000); // Removing the largest locator inventories exceeds 5 s on this host.

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
    await log.replace('chat-1', [message(1601)], 1);
    expect(await log.readMessage('chat-1', 'm-0')).toBeUndefined();
    expect(await log.readMessage('chat-1', 'm-1600')).toBeUndefined();
    expect(await log.readMessage('chat-1', 'm-1601')).toEqual(message(1601));
  }, 30_000); // This existing case writes and replaces 1,600 locator files.

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

  it('answers a negative committed-state probe from a complete locator inventory', async () => {
    await log.append('chat-1', [message(1)]);
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const originalReadFile = fsPromises.readFile;
    const locatorReads: string[] = [];
    jest.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      const path = typeof args[0] === 'string' ? args[0] : '';
      if (path.startsWith(`${locatorDirectory}/`)) locatorReads.push(path);
      return originalReadFile(...args);
    });

    await expect(log.committedMessageState('chat-1', message(2))).resolves.toBe(
      'absent',
    );

    expect(locatorReads).toEqual([]);
  });

  it('still reads and digest-checks a positive committed locator', async () => {
    await log.append('chat-1', [message(1)]);
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const locatorFile = join(
      locatorDirectory,
      `${createHash('sha256').update('m-1').digest('hex')}.json`,
    );
    const locator: unknown = JSON.parse(await readFile(locatorFile, 'utf8'));
    if (!isRecord(locator)) throw new Error('Committed locator is invalid');
    await writeFile(
      locatorFile,
      JSON.stringify({ ...locator, digest: '0'.repeat(64) }),
    );
    const originalReadFile = fsPromises.readFile;
    let locatorReads = 0;
    jest.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      const path = typeof args[0] === 'string' ? args[0] : '';
      if (path === locatorFile) locatorReads += 1;
      return originalReadFile(...args);
    });

    await expect(
      log.committedMessageState('chat-1', message(1)),
    ).rejects.toThrow('Committed message locator does not match transcript');

    expect(locatorReads).toBe(1);
  });

  it('adds keys to a cached committed locator inventory after append', async () => {
    await log.append('chat-1', [message(1)]);
    await log.hasCommittedMessage('chat-1', 'missing');
    await log.append('chat-1', [message(2)]);

    await expect(log.committedMessageState('chat-1', message(2))).resolves.toBe(
      'identical',
    );
  });

  it('rebuilds committed locator identities after replacement', async () => {
    await log.append('chat-1', [message(1)]);
    await log.hasCommittedMessage('chat-1', 'missing');
    await log.replace('chat-1', [message(2)], 1);

    await expect(log.committedMessageState('chat-1', message(2))).resolves.toBe(
      'identical',
    );
    await expect(log.hasCommittedMessage('chat-1', 'm-1')).resolves.toBe(false);
  });

  it('clears committed locator identities when a chat is deleted', async () => {
    await log.append('chat-1', [message(1)]);
    await log.hasCommittedMessage('chat-1', 'missing');
    await log.remove('chat-1');
    await log.initialize('chat-1');

    await expect(log.hasCommittedMessage('chat-1', 'm-1')).resolves.toBe(false);
  });

  it('drops and rebuilds identities after an external locator-directory change', async () => {
    await log.append('chat-1', [message(1)]);
    await log.hasCommittedMessage('chat-1', 'missing');
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const externalFile = join(
      locatorDirectory,
      `${createHash('sha256').update('external').digest('hex')}.json`,
    );
    await writeFile(externalFile, '{}');
    // Coarse host timestamps can leave the directory stamp unchanged when this
    // write lands in the append's tick, so advance it explicitly.
    const changedAt = new Date(Date.now() + 60_000);
    await utimes(locatorDirectory, changedAt, changedAt);

    await expect(
      log.committedMessageState('chat-1', row('external')),
    ).resolves.toBe('absent');

    expect(await readdir(locatorDirectory)).toEqual([
      `${createHash('sha256').update('m-1').digest('hex')}.json`,
    ]);
  });

  it('falls back to transcript scanning for an incomplete read-only locator inventory', async () => {
    await log.append('chat-1', [message(1)]);
    await rm(
      join(
        root,
        'message-index',
        'chat-1',
        `${createHash('sha256').update('m-1').digest('hex')}.json`,
      ),
    );
    const readOnly = new ChatTranscriptLog(root, undefined, { readOnly: true });
    const scan = jest.spyOn(fs, 'createReadStream');

    await expect(
      readOnly.committedMessageState('chat-1', message(1)),
    ).resolves.toBe('identical');

    expect(scan.mock.calls.map(([path]) => String(path))).toContain(
      join(root, 'chat-1.jsonl'),
    );
  });

  it('rebuilds committed locator identities after a forced reload', async () => {
    await log.append('chat-1', [message(1)]);
    await log.hasCommittedMessage('chat-1', 'missing');
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const originalOpenDir = fsPromises.opendir;
    let inventoryReads = 0;
    jest.spyOn(fsPromises, 'opendir').mockImplementation(async (...args) => {
      if (String(args[0]) === locatorDirectory) inventoryReads += 1;
      return originalOpenDir(...args);
    });

    await invokeLogMethod(log, 'load', ['chat-1', true]);
    await expect(log.hasCommittedMessage('chat-1', 'missing')).resolves.toBe(
      false,
    );

    expect(inventoryReads).toBe(1);
  });

  it('keeps the cached index current when a torn locator forces a reload during an active write', async () => {
    await log.append('chat-1', [message(1)]);
    await log.writeActive('chat-1', [message(2)]);
    const tornLocator = join(
      root,
      'message-index',
      'chat-1',
      `${createHash('sha256').update(message(1).id).digest('hex')}.json`,
    );
    fs.writeFileSync(tornLocator, '{"torn":');

    // The committed echo of m-1 reads the torn locator, which forces a reload
    // in the middle of this write.
    await log.writeActive('chat-1', [message(1), message(2), message(3)]);
    const persisted: unknown = JSON.parse(
      fs.readFileSync(join(root, 'chat-1.index.json'), 'utf8'),
    );
    const persistedRevision: unknown = Reflect.get(
      Object(persisted),
      'transcriptRevision',
    );
    const persistedActive: unknown = Reflect.get(
      Object(persisted),
      'hasActiveSidecar',
    );
    const descriptor = await log.descriptor('chat-1');
    expect(descriptor.transcriptRevision).toBe(persistedRevision);
    expect(descriptor.hasActiveSidecar).toBe(persistedActive);

    // The next write advances from the persisted revision, not a stale copy.
    await log.writeActive('chat-1', [message(2), message(3), message(4)]);
    expect((await log.descriptor('chat-1')).transcriptRevision).toBe(
      descriptor.transcriptRevision + 1,
    );
  });

  it('drops committed locator identities with the 64-chat loaded-log LRU', async () => {
    await log.append('chat-1', [message(1)]);
    await log.hasCommittedMessage('chat-1', 'missing');
    for (let index = 0; index < 64; index += 1) {
      const chatId = `lru-${String(index)}`;
      await log.initialize(chatId);
      await log.descriptor(chatId);
    }
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const originalOpenDir = fsPromises.opendir;
    let inventoryReads = 0;
    jest.spyOn(fsPromises, 'opendir').mockImplementation(async (...args) => {
      if (String(args[0]) === locatorDirectory) inventoryReads += 1;
      return originalOpenDir(...args);
    });

    await expect(log.hasCommittedMessage('chat-1', 'missing')).resolves.toBe(
      false,
    );

    expect(inventoryReads).toBeGreaterThanOrEqual(2);
  });

  it('falls back to locator reads without a partial inventory above the key cap', async () => {
    await log.append('chat-1', [message(1)]);
    const loadedValue: unknown = Reflect.get(log, 'loaded');
    if (!(loadedValue instanceof Map))
      throw new Error('Loaded transcript cache is unavailable');
    const loadedChat: unknown = loadedValue.get('chat-1');
    if (!isRecord(loadedChat) || !isRecord(loadedChat.index))
      throw new Error('Loaded transcript cache entry is unavailable');
    Reflect.set(loadedChat.index, 'committedMessageCount', 100_001);

    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const originalReadFile = fsPromises.readFile;
    let locatorReads = 0;
    jest.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      const path = typeof args[0] === 'string' ? args[0] : '';
      if (path.startsWith(`${locatorDirectory}/`)) locatorReads += 1;
      return originalReadFile(...args);
    });

    await expect(log.hasCommittedMessage('chat-1', 'missing')).resolves.toBe(
      false,
    );

    expect(locatorReads).toBe(1);
  });

  it('does not build committed locator identities during a page read', async () => {
    await log.append('chat-1', [message(1)]);
    await writeUnvalidatedActiveSidecar(
      root,
      'chat-1',
      [message(2)],
      new Map(),
      1,
    );
    const locatorDirectory = join(root, 'message-index', 'chat-1');
    const originalOpenDir = fsPromises.opendir;
    let inventoryReads = 0;
    jest.spyOn(fsPromises, 'opendir').mockImplementation(async (...args) => {
      if (String(args[0]) === locatorDirectory) inventoryReads += 1;
      return originalOpenDir(...args);
    });

    await log.page('chat-1');
    expect(inventoryReads).toBe(0);
    await log.hasCommittedMessage('chat-1', 'missing');

    expect(inventoryReads).toBe(1);
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

  it.each([false, true])(
    'rebuilds version-9 plan edit counts without rewriting rows (plan failure: %s)',
    async (planFailed) => {
      const rows: PersistedChatMessage[] = [
        message(0, 'user'),
        ...[
          {
            toolUseId: 'plan',
            toolName: 'Write',
            input:
              '{"file_path":"/Users/test/.claude/plans/draft.md","content":"# Plan"}',
            output: planFailed ? 'Write failed' : 'Written',
            isError: planFailed,
          },
          {
            toolUseId: 'grep',
            toolName: 'Grep',
            input: '{}',
            output: 'Search failed',
            isError: true,
          },
          {
            toolUseId: 'exit',
            toolName: 'ExitPlanMode',
            input: '{}',
            output: 'canopy_plan_handoff',
            isError: true,
          },
        ].map(
          (call, index): PersistedChatMessage => ({
            ...message(index + 1),
            blocks: [
              {
                type: 'tool_use',
                toolUseId: call.toolUseId,
                toolName: call.toolName,
                input: call.input,
              },
              {
                type: 'tool_result',
                toolUseId: call.toolUseId,
                toolName: call.toolName,
                output: call.output,
                isError: call.isError,
              },
            ],
          }),
        ),
        { ...message(4), blocks: [{ type: 'text', text: 'Plan ready' }] },
        {
          ...message(5, 'system'),
          blocks: [{ type: 'turn_timer', completedAt: 5 }],
        },
      ];
      await log.replace('chat-1', rows, 1);
      const live = await log.page('chat-1', undefined, { view: 'turns' });
      expect(live.turns?.[0].summary.writeEdit).toBe(0);
      expect(live.turns?.[0].outcomes).toEqual({
        blocked: 0,
        failed: planFailed ? 2 : 1,
        interrupted: 0,
      });
      const cachePath = join(root, 'chat-1.turns.json');
      const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
      if (!isRecord(cached) || !isUnknownArray(cached.turns))
        throw new Error('Missing turn cache');
      const { checksum: oldChecksum, ...body } = cached;
      void oldChecksum;
      body.version = 9;
      for (const turn of cached.turns) {
        if (!isRecord(turn) || !isRecord(turn.summary))
          throw new Error('Invalid turn');
        turn.summary.writeEdit = 1;
      }
      await writeFile(
        cachePath,
        JSON.stringify({
          ...body,
          checksum: createHash('sha256')
            .update(JSON.stringify(body))
            .digest('hex'),
        }),
      );
      const before = await readFile(join(root, 'chat-1.jsonl'), 'utf8');
      const rebuilt = await new ChatTranscriptLog(root).page(
        'chat-1',
        undefined,
        { view: 'turns' },
      );
      expect(rebuilt.turns?.[0].summary).toEqual(live.turns?.[0].summary);
      expect(rebuilt.turns?.[0].outcomes).toEqual(live.turns?.[0].outcomes);
      expect(await readFile(cachePath, 'utf8')).toContain('"version":10');
      expect(await readFile(join(root, 'chat-1.jsonl'), 'utf8')).toBe(before);
      const reloaded = await new ChatTranscriptLog(root).page(
        'chat-1',
        undefined,
        { view: 'turns' },
      );
      expect(reloaded.turns).toEqual(rebuilt.turns);
    },
  );

  it('rebuilds interrupted outcome counts from a version-8 cache without rewriting authoritative rows', async () => {
    const rows: PersistedChatMessage[] = [
      message(0, 'user'),
      {
        ...message(1),
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'edit',
            toolName: 'Edit',
            input: '{}',
          },
          {
            type: 'tool_result',
            toolUseId: 'edit',
            toolName: 'Edit',
            output: 'Interrupted',
            isError: true,
            interruption: { reason: 'app_restart', at: 2 },
          },
        ],
      },
      {
        ...message(2, 'system'),
        blocks: [{ type: 'turn_timer', completedAt: 2 }],
      },
    ];
    await log.replace('chat-1', rows, 1);
    await log.page('chat-1', undefined, { view: 'turns' });
    const cachePath = join(root, 'chat-1.turns.json');
    const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
    if (!isRecord(cached) || !isUnknownArray(cached.turns))
      throw new Error('Missing turn cache');
    const { checksum: oldChecksum, ...body } = cached;
    void oldChecksum;
    body.version = 8;
    for (const turn of cached.turns) {
      if (!isRecord(turn)) throw new Error('Invalid turn');
      turn.outcomes = { blocked: 0, failed: 1 };
    }
    await writeFile(
      cachePath,
      JSON.stringify({
        ...body,
        checksum: createHash('sha256')
          .update(JSON.stringify(body))
          .digest('hex'),
      }),
    );
    const before = await readFile(join(root, 'chat-1.jsonl'), 'utf8');
    const rebuilt = await new ChatTranscriptLog(root).page(
      'chat-1',
      undefined,
      { view: 'turns' },
    );
    expect(rebuilt.turns?.[0].outcomes).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 1,
    });
    expect(await readFile(cachePath, 'utf8')).toContain('"version":10');
    expect(await readFile(join(root, 'chat-1.jsonl'), 'utf8')).toBe(before);
  });

  it.each(['outcomes', 'deniedToolUseIds'])(
    'rebuilds missing %s in a checksummed v8 cache without rewriting the transcript',
    async (field) => {
      const rows: PersistedChatMessage[] = [
        message(0, 'user'),
        {
          ...message(1),
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'denied',
              toolName: 'Bash',
              input: '{}',
            },
          ],
        },
        {
          ...message(2, 'system'),
          blocks: [
            {
              type: 'approval_safety_denied_info',
              receiptId: 'm-2',
              timestamp: 2,
              reason: 'force-push',
              command: 'fixture only',
              mode: 'ask',
              toolUseId: 'denied',
            },
          ],
        },
        message(3),
        {
          ...message(4, 'system'),
          blocks: [{ type: 'turn_timer', completedAt: 4 }],
        },
      ];
      await log.replace('chat-1', rows, 1);
      const cachePath = join(root, 'chat-1.turns.json');
      await log.page('chat-1', undefined, { view: 'turns' });
      const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
      if (!isRecord(cached) || !isUnknownArray(cached.turns))
        throw new Error('Expected turn cache');
      const { checksum: oldChecksum, ...body } = cached;
      void oldChecksum;
      body.version = 8;
      for (const turn of cached.turns) {
        if (!isRecord(turn)) throw new Error('Expected cached turn');
        delete turn[field];
      }
      await writeFile(
        cachePath,
        JSON.stringify({
          ...body,
          checksum: createHash('sha256')
            .update(JSON.stringify(body))
            .digest('hex'),
        }),
      );
      const transcriptBefore = await readFile(
        join(root, 'chat-1.jsonl'),
        'utf8',
      );
      const page = await new ChatTranscriptLog(root).page('chat-1', undefined, {
        view: 'turns',
      });
      expect(page.turns?.[0]).toMatchObject({
        outcomes: { blocked: 1, failed: 0, interrupted: 0 },
      });
      expect(await readFile(join(root, 'chat-1.jsonl'), 'utf8')).toBe(
        transcriptBefore,
      );
      expect(await readFile(cachePath, 'utf8')).toContain(
        '"outcomes":{"blocked":1,"failed":0,"interrupted":0}',
      );
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
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
      expect(await readFile(cachePath, 'utf8')).toContain('"version":10');
      expect(
        (await log.page('chat-1', undefined, { view: 'turns' })).turns?.[0],
      ).toMatchObject({ outcomes: { blocked: 0, failed: 0, interrupted: 0 } });
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
    expect(await readFile(cachePath, 'utf8')).toContain('"version":10');
  });

  it.each(['Write', 'Edit', 'MultiEdit'])(
    'keeps %s files through disk serialization and historical turn windows',
    async (toolName) => {
      const rows: PersistedChatMessage[] = [
        message(0, 'user'),
        {
          ...message(1),
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'write-report',
              toolName,
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
              toolName,
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
        files: [
          {
            path: '/project/report.md',
            state: 'ready',
            ...(toolName === 'Write' ? { saved: true } : { change: 'updated' }),
          },
        ],
      });
      expect(page.turns?.[1]).toMatchObject({ files: [] });
      expect(page.turns?.[0]?.files?.[0]?.evidence).toHaveLength(1);
      expect(page.turns?.[0]?.files?.[0]?.evidence?.[0]).toMatchObject({
        path: '/project/report.md',
        state: 'ready',
      });
      expect(typeof page.turns?.[0]?.files?.[0]?.evidence?.[0]?.key).toBe(
        'string',
      );
      const reloaded = await new ChatTranscriptLog(root).page(
        'chat-1',
        undefined,
        { view: 'turns' },
      );
      expect(reloaded.turns?.[0]?.files).toEqual(page.turns?.[0]?.files);
      const cache = await readFile(join(root, 'chat-1.turns.json'), 'utf8');
      expect(cache).toContain(
        toolName === 'Write' ? '"saved":true' : '"change":"updated"',
      );
      // A v7 index has the correct source length/checksum but lacks ordered evidence.
      const cached: unknown = JSON.parse(cache);
      if (!isRecord(cached) || !Array.isArray(cached.turns))
        throw new Error('Expected turn cache');
      const { checksum, ...legacyBody } = cached;
      void checksum;
      legacyBody.version = 7;
      for (const turn of cached.turns) {
        if (!isRecord(turn)) throw new Error('Expected cached turn');
        turn.files = [];
      }
      await writeFile(
        join(root, 'chat-1.turns.json'),
        JSON.stringify({
          ...legacyBody,
          checksum: createHash('sha256')
            .update(JSON.stringify(legacyBody))
            .digest('hex'),
        }),
      );
      const rebuilt = await new ChatTranscriptLog(root).page(
        'chat-1',
        undefined,
        { view: 'turns' },
      );
      expect(rebuilt.turns?.[0]?.files).toEqual(page.turns?.[0]?.files);
    },
  );

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

  it.each(['cold', 'cached', 'active', 'anchored', 'replace'])(
    'attributes a late safety receipt to its owner: %s',
    async (mode) => {
      const rows: PersistedChatMessage[] = [0, 10].flatMap((start) => [
        message(start, 'user'),
        {
          ...message(start + 1),
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'reused',
              toolName: 'Bash',
              input: '{}',
            },
            {
              type: 'tool_result',
              toolUseId: 'reused',
              toolName: 'Bash',
              output: 'fixture only',
              isError: start === 0,
            },
          ],
        },
        message(start + 2),
        {
          ...message(start + 3, 'system'),
          blocks: [{ type: 'turn_timer', completedAt: start + 3 }],
        },
      ]);
      const card = delegatedCard('outcome-card');
      rows.splice(1, 0, card);
      await log.replace('chat-1', rows, 1);
      if (mode !== 'cold')
        await log.page('chat-1', undefined, { view: 'turns' });
      const receipt: PersistedChatMessage = {
        ...message(20, 'system'),
        blocks: [
          {
            type: 'approval_safety_denied_info',
            receiptId: 'late-receipt',
            timestamp: 20,
            reason: 'force-push',
            command: 'fixture only',
            mode: 'ask',
            toolUseId: 'reused',
            turnUserMessageId: 'm-0',
          },
        ],
      };
      if (mode === 'active') await log.writeActive('chat-1', [receipt]);
      else await log.append('chat-1', [receipt]);
      if (mode === 'anchored') {
        const progress = row('outcome-progress', 'Still running', card.id);
        await log.writeActive(
          'chat-1',
          [progress],
          new Map([[progress.id, anchor(card.id, card.id, 0)]]),
        );
      }
      const page = await log.page('chat-1', undefined, { view: 'turns' });
      expect(page.turns?.[0]).toMatchObject({ deniedToolUseIds: ['reused'] });
      expect(page.turns?.map((turn) => turn.outcomes)).toEqual([
        { blocked: 1, failed: 0, interrupted: 0 },
        { blocked: 0, failed: 0, interrupted: 0 },
      ]);
      expect(
        (
          await new ChatTranscriptLog(root).page('chat-1', undefined, {
            view: 'turns',
          })
        ).turns,
      ).toEqual(page.turns);
      if (mode === 'replace') {
        await log.replace('chat-1', rows, 2);
        expect(
          (await log.page('chat-1', undefined, { view: 'turns' })).turns?.map(
            (turn) => turn.outcomes?.blocked,
          ),
        ).toEqual([0, 0]);
      }
    },
  );

  it('projects oversized turns with their sticky frame and exact condensed tool counts', async () => {
    const rows = Array.from({ length: 3 }, (_, turn) => [
      message(turn * 2000, 'user'),
      {
        ...message(turn * 2000 + 1, 'system'),
        blocks: [{ type: 'turn_timer' as const, startedAt: 1, completedAt: 2 }],
      },
      ...Array.from(
        { length: 1250 },
        (_, index): PersistedChatMessage => ({
          ...message(turn * 2000 + index + 2),
          blocks: [
            {
              type: 'tool_use' as const,
              toolUseId: `read-${turn}-${index}`,
              toolName: 'Read',
              input: '{}',
            },
            ...(index === 0
              ? [
                  {
                    type: 'approval_safety_denied_info' as const,
                    receiptId: `receipt-${turn}`,
                    timestamp: 1,
                    reason: 'force-push' as const,
                    command: 'fixture only',
                    mode: 'ask' as const,
                    toolUseId: `read-${turn}-${index}`,
                  },
                ]
              : []),
            ...(index === 1
              ? [
                  {
                    type: 'tool_result' as const,
                    toolUseId: `read-${turn}-${index}`,
                    toolName: 'Read',
                    output: 'fixture failure',
                    isError: true,
                  },
                ]
              : []),
          ],
        }),
      ),
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
    expect(page.turns?.map((turn) => turn.outcomes)).toEqual(
      Array.from({ length: 3 }, () => ({
        blocked: 1,
        failed: 1,
        interrupted: 1248,
      })),
    );
    expect(page.messages.some((row) => row.id === 'm-2')).toBe(false);
    let before = page.turns?.[0].before;
    const loaded = new Map(page.messages.map((row) => [row.id, row]));
    while (before !== undefined) {
      const older = await log.page('chat-1', before, {
        view: 'turns',
        turnId: 'm-0',
      });
      expect(older.turns?.[0].summary.read).toBe(1250);
      expect(older.turns?.[0].outcomes).toEqual({
        blocked: 1,
        failed: 1,
        interrupted: 1248,
      });
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

  it('commits ordinary sidecar prefixes while preserving the ordered active suffix and anchors', async () => {
    const card = delegatedCard('append-active-suffix-card');
    const ordinaryPrefix = row('append-active-suffix-ordinary-prefix');
    const firstChild = row(
      'append-active-suffix-first-child',
      'first',
      card.id,
    );
    const secondChild = row(
      'append-active-suffix-second-child',
      'second',
      card.id,
    );
    const ordinaryTail = row('append-active-suffix-ordinary-tail');
    const anchors = new Map<string, ActiveRowAnchor>([
      [firstChild.id, anchor(card.id, card.id, 0)],
      [secondChild.id, anchor(card.id, firstChild.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    // Anchored rows are exempt from the ordinary sidecar-prefix rule. The
    // active suffix that remains is stored in the caller's order.
    await log.writeActive(
      'chat-1',
      [firstChild, ordinaryPrefix, secondChild, ordinaryTail],
      anchors,
    );

    await appendWithActiveTail(
      log,
      'chat-1',
      [ordinaryPrefix, firstChild, secondChild, ordinaryTail],
      anchors,
      3,
    );

    expect(
      (await readFile(join(root, 'chat-1.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (!isPersistedChatMessage(value))
            throw new Error('Expected a committed transcript row');
          return value.id;
        }),
    ).toEqual([card.id, ordinaryPrefix.id]);
    expect(await log.activeMessages('chat-1')).toEqual([
      firstChild,
      secondChild,
      ordinaryTail,
    ]);
    expect(await log.activeRowAnchors('chat-1')).toEqual(
      new Map([
        [firstChild.id, anchors.get(firstChild.id)],
        [secondChild.id, anchors.get(secondChild.id)],
      ]),
    );
    const descriptor = await log.descriptor('chat-1');
    expect(descriptor).toMatchObject({
      hasActiveSidecar: true,
      hasOrdinaryActiveRows: true,
    });
  });

  it('commits a new ordinary row while retaining the complete ordinary suffix', async () => {
    const retained = row('append-retained-ordinary-tail');
    const ready = row('append-new-ordinary-ready');
    await log.writeActive('chat-1', [retained]);

    await log.append('chat-1', [ready, retained], undefined, 1);

    expect(await log.activeMessages('chat-1')).toEqual([retained]);
    expect(await log.committedMessageState('chat-1', ready)).toBe('identical');
    expect(await log.committedMessageState('chat-1', retained)).toBe('absent');
  });

  it('commits a ready anchored run while retaining an unanchored ordinary suffix', async () => {
    const card = delegatedCard('append-ordinary-suffix-card');
    const readyChild = row(
      'append-ordinary-suffix-ready-child',
      'ready',
      card.id,
    );
    const ordinarySuffix = row('append-ordinary-suffix-live-parent-tail');
    const anchors = new Map<string, ActiveRowAnchor>([
      [readyChild.id, anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [readyChild, ordinarySuffix], anchors);

    await appendWithActiveTail(
      log,
      'chat-1',
      [readyChild, ordinarySuffix],
      anchors,
      1,
    );

    expect(
      (await readFile(join(root, 'chat-1.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (!isPersistedChatMessage(value))
            throw new Error('Expected a committed transcript row');
          return value.id;
        }),
    ).toEqual([card.id, readyChild.id]);
    expect(await log.activeMessages('chat-1')).toEqual([ordinarySuffix]);
    expect(await log.activeRowAnchors('chat-1')).toEqual(new Map());
    const descriptor = await log.descriptor('chat-1');
    expect(descriptor).toMatchObject({ hasActiveSidecar: true });
    expect(
      Object.prototype.hasOwnProperty.call(descriptor, 'hasOrdinaryActiveRows'),
    ).toBe(false);
  });

  it('keeps ordinary active rows in sidecar order when committing a suffix prefix', async () => {
    const first = row('append-ordinary-order-first');
    const second = row('append-ordinary-order-second');
    await log.writeActive('chat-1', [first, second]);

    await expect(
      appendWithActiveTail(log, 'chat-1', [second, first], new Map(), 1),
    ).rejects.toThrow('order');
    expect(await log.activeMessages('chat-1')).toEqual([first, second]);
  });

  it('reapplies an already committed prefix without rewriting its identical active suffix', async () => {
    const committed = row('append-replay-committed-prefix');
    const suffix = row('append-replay-active-suffix');
    await appendWithActiveTail(
      log,
      'chat-1',
      [committed, suffix],
      new Map(),
      1,
    );
    const first = await log.descriptor('chat-1');

    await appendWithActiveTail(
      log,
      'chat-1',
      [committed, suffix],
      new Map(),
      1,
    );

    const replayed = await log.descriptor('chat-1');
    expect(replayed.transcriptRevision).toBe(first.transcriptRevision);
    expect(await log.activeMessages('chat-1')).toEqual([suffix]);
    expect((await log.page('chat-1')).messages).toEqual([committed, suffix]);
  });

  it('applies an all-active suffix once without advancing its revision on replay', async () => {
    const firstActive = row('append-all-active-first');
    const secondActive = row('append-all-active-second');
    await appendWithActiveTail(
      log,
      'chat-1',
      [firstActive, secondActive],
      new Map(),
      2,
    );
    const first = await log.descriptor('chat-1');

    await appendWithActiveTail(
      log,
      'chat-1',
      [firstActive, secondActive],
      new Map(),
      2,
    );

    expect((await log.descriptor('chat-1')).transcriptRevision).toBe(
      first.transcriptRevision,
    );
    expect(await log.activeMessages('chat-1')).toEqual([
      firstActive,
      secondActive,
    ]);
    expect((await log.page('chat-1')).messages).toEqual([
      firstActive,
      secondActive,
    ]);
  });

  it('requires a committed anchored row predecessor to be committed or earlier in the append payload', async () => {
    const card = delegatedCard('append-predecessor-order-card');
    const predecessor = row(
      'append-predecessor-order-parent',
      'parent',
      card.id,
    );
    const follower = row('append-predecessor-order-child', 'child', card.id);
    const anchors = new Map<string, ActiveRowAnchor>([
      [predecessor.id, anchor(card.id, card.id, 0)],
      [follower.id, anchor(card.id, predecessor.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [follower, predecessor], anchors);

    await expect(
      appendWithActiveTail(log, 'chat-1', [follower, predecessor], anchors, 0),
    ).rejects.toThrow('predecessor');
    expect(await log.activeMessages('chat-1')).toEqual([follower, predecessor]);
    expect(
      (await readdir(root)).filter((name) => name.endsWith('.append.tmp')),
    ).toEqual([]);
  });

  it('does not lose active content through an empty replacement', async () => {
    await log.writeActive('chat-1', [message(1)]);
    await expect(log.writeActive('chat-1', [])).rejects.toThrow('discard');
    expect((await new ChatTranscriptLog(root).page('chat-1')).messages).toEqual(
      [message(1)],
    );
  });

  it('distinguishes anchored-only sidecars from ordinary active rows in descriptors and captured previews', async () => {
    const card = delegatedCard('ordinary-active-descriptor-card');
    const child = row('ordinary-active-descriptor-child', 'child', card.id);
    const ordinary = row('ordinary-active-descriptor-row');
    const anchors = new Map<string, ActiveRowAnchor>([
      [child.id, anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child], anchors);

    const anchoredOnly = await log.descriptor('chat-1');
    expect(anchoredOnly).toMatchObject({
      hasActiveSidecar: true,
      hasOrdinaryActiveRows: false,
    });
    const anchoredCapture = await log.capturePreview('chat-1', anchoredOnly);
    try {
      expect(anchoredCapture.descriptor.hasOrdinaryActiveRows).toBe(false);
    } finally {
      await anchoredCapture.close();
    }

    await log.writeActive('chat-1', [child, ordinary], anchors);
    expect(await log.descriptor('chat-1')).toMatchObject({
      hasActiveSidecar: true,
      hasOrdinaryActiveRows: true,
    });

    await log.replaceActive('chat-1', [child], anchors);
    expect(await log.descriptor('chat-1')).toMatchObject({
      hasActiveSidecar: true,
      hasOrdinaryActiveRows: false,
    });
    await log.replaceActive('chat-1', []);
    const empty = await log.descriptor('chat-1');
    expect(empty).toMatchObject({ hasActiveSidecar: false });
    expect(
      Object.prototype.hasOwnProperty.call(empty, 'hasOrdinaryActiveRows'),
    ).toBe(false);

    await log.writeActive('chat-1', [ordinary]);
    const anchorFree = await log.descriptor('chat-1');
    expect(
      Object.prototype.hasOwnProperty.call(anchorFree, 'hasOrdinaryActiveRows'),
    ).toBe(false);
    const anchorFreeIndex: unknown = JSON.parse(
      await readFile(join(root, 'chat-1.index.json'), 'utf8'),
    );
    if (!isRecord(anchorFreeIndex))
      throw new Error('Invalid anchor-free index fixture');
    expect(
      Object.prototype.hasOwnProperty.call(
        anchorFreeIndex,
        'hasOrdinaryActiveRows',
      ),
    ).toBe(false);
  });

  it('recomputes ordinary-row metadata after an older writer strips anchors from an anchored sidecar', async () => {
    const card = delegatedCard('ordinary-active-downgrade-card');
    const child = row('ordinary-active-downgrade-child', 'child', card.id);
    const anchors = new Map<string, ActiveRowAnchor>([
      [child.id, anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child], anchors);
    const anchoredDescriptor = await log.descriptor('chat-1');
    expect(anchoredDescriptor.hasOrdinaryActiveRows ?? false).toBe(false);

    // An unchanged writer drops anchor metadata while keeping the row and
    // leaves the newer optional index field untouched.
    await writeUnvalidatedActiveSidecar(
      root,
      'chat-1',
      [child],
      new Map(),
      anchoredDescriptor.transcriptRevision,
    );
    const downgraded = await new ChatTranscriptLog(root).descriptor('chat-1');
    expect(downgraded).toMatchObject({ hasActiveSidecar: true });
    expect(
      Object.prototype.hasOwnProperty.call(downgraded, 'hasOrdinaryActiveRows'),
    ).toBe(false);
    const rewrittenIndex: unknown = JSON.parse(
      await readFile(join(root, 'chat-1.index.json'), 'utf8'),
    );
    if (!isRecord(rewrittenIndex))
      throw new Error('Invalid downgraded index fixture');
    expect(
      Object.prototype.hasOwnProperty.call(
        rewrittenIndex,
        'hasOrdinaryActiveRows',
      ),
    ).toBe(false);
  });

  it('reports no ordinary active rows when the sidecar is missing despite stale index metadata', async () => {
    const card = delegatedCard('ordinary-active-missing-sidecar-card');
    const child = row(
      'ordinary-active-missing-sidecar-child',
      'child',
      card.id,
    );
    const anchors = new Map<string, ActiveRowAnchor>([
      [child.id, anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child], anchors);
    expect((await log.descriptor('chat-1')).hasOrdinaryActiveRows).toBe(false);
    await rm(join(root, 'chat-1.active.json'), { force: true });

    const missing = await new ChatTranscriptLog(root).descriptor('chat-1');
    expect(
      Object.prototype.hasOwnProperty.call(missing, 'hasOrdinaryActiveRows'),
    ).toBe(false);
  });

  it('recomputes ordinary active-row metadata when rebuilding a sparse index', async () => {
    const card = delegatedCard('ordinary-active-reindex-card');
    const child = row('ordinary-active-reindex-child', 'child', card.id);
    const ordinary = row('ordinary-active-reindex-row');
    const anchors = new Map<string, ActiveRowAnchor>([
      [child.id, anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child, ordinary], anchors);
    await rm(join(root, 'chat-1.index.json'), { force: true });

    const rebuilt = await new ChatTranscriptLog(root).descriptor('chat-1');
    expect(rebuilt).toMatchObject({
      hasActiveSidecar: true,
      hasOrdinaryActiveRows: true,
    });
  });

  it('projects ordinary active-row metadata for journal-backed descriptors and captures', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    const projected = new ChatTranscriptLog(root);
    projected.setActiveProjection(() => ({
      messages: [message(1)],
      transcriptRevision: 4,
    }));
    const descriptor = await projected.descriptor('chat-1');
    expect(descriptor).toMatchObject({ hasActiveSidecar: true });
    expect(
      Object.prototype.hasOwnProperty.call(descriptor, 'hasOrdinaryActiveRows'),
    ).toBe(false);
    const captured = await projected.capturePreview('chat-1', descriptor);
    try {
      expect(captured.descriptor).toMatchObject({ hasActiveSidecar: true });
      expect(
        Object.prototype.hasOwnProperty.call(
          captured.descriptor,
          'hasOrdinaryActiveRows',
        ),
      ).toBe(false);
    } finally {
      await captured.close();
    }
  });

  it('propagates projected anchors through descriptors, snapshots and captures', async () => {
    const card = delegatedCard('ordinary-active-projection-card');
    const child = row('ordinary-active-projection-child', 'child', card.id);
    const ordinary = row('ordinary-active-projection-row');
    const anchors = new Map<string, ActiveRowAnchor>([
      [child.id, anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    const projected = new ChatTranscriptLog(root);
    projected.setActiveProjection(() => ({
      messages: [child, ordinary],
      transcriptRevision: 4,
      anchors,
    }));

    expect(await projected.activeSnapshot('chat-1')).toEqual({
      messages: [child, ordinary],
      anchors,
    });
    const descriptor = await projected.descriptor('chat-1');
    expect(descriptor).toMatchObject({
      hasActiveSidecar: true,
      hasOrdinaryActiveRows: true,
    });
    const captured = await projected.capturePreview('chat-1', descriptor);
    try {
      expect(captured.descriptor.hasOrdinaryActiveRows).toBe(true);
    } finally {
      await captured.close();
    }
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

  it('round-trips row anchors and preserves only surviving anchors across active writes', async () => {
    const card = delegatedCard('run-card');
    await log.append('chat-1', [card]);
    const first = row('child-one', 'first', card.id);
    const second = row('child-two', 'second', card.id);
    const originalAnchors = new Map<string, ActiveRowAnchor>([
      ['child-one', anchor(card.id, card.id, 0)],
      ['child-two', anchor(card.id, card.id, -1)],
    ]);

    await invokeLogMethod(log, 'writeActive', [
      'chat-1',
      [first, second],
      originalAnchors,
    ]);
    const raw = await readFile(join(root, 'chat-1.active.json'), 'utf8');
    const records = activeSidecarRows(raw);
    expect(records[0]).toMatchObject({ version: 2 });
    expect(records[1]).toMatchObject({
      anchor: originalAnchors.get('child-one'),
    });
    expect(records[2]).toMatchObject({
      anchor: originalAnchors.get('child-two'),
    });
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      originalAnchors,
    );

    const updatedFirst = row('child-one', 'updated first', card.id);
    await log.writeActive('chat-1', [updatedFirst, second]);
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      originalAnchors,
    );

    await log.replaceActive('chat-1', [second]);
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      new Map([['child-two', originalAnchors.get('child-two')]]),
    );
    const replacedAnchor = anchor(card.id, card.id, 0);
    const replacementAnchors = new Map([['child-two', replacedAnchor]]);
    await log.replaceActive('chat-1', [second], replacementAnchors);
    const surviving = replacementAnchors;
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      surviving,
    );

    await invokeLogMethod(log, 'writeActiveAtRevision', [
      'chat-1',
      [second],
      17,
    ]);
    const revisionAnchor = anchor(card.id, card.id, 1);
    const revisionAnchors = new Map([['child-two', revisionAnchor]]);
    await invokeLogMethod(log, 'writeActiveAtRevision', [
      'chat-1',
      [second],
      18,
      revisionAnchors,
    ]);
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      revisionAnchors,
    );
    surviving.set('child-two', revisionAnchor);
    await log.append('chat-1', [card]);
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      surviving,
    );

    const override = new Map([['child-two', anchor(card.id, card.id, 0)]]);
    await invokeLogMethod(log, 'appendAfterActive', [
      'chat-1',
      [],
      [second],
      30,
      override,
    ]);
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      override,
    );
    const beforeStaleAppend = await readFile(
      join(root, 'chat-1.active.json'),
      'utf8',
    );
    await invokeLogMethod(log, 'appendAfterActive', [
      'chat-1',
      [],
      [second],
      1,
      new Map([['child-two', anchor(card.id, card.id, 2)]]),
    ]);
    expect(await readFile(join(root, 'chat-1.active.json'), 'utf8')).toBe(
      beforeStaleAppend,
    );

    const bothAnchors = new Map([
      ['child-one', anchor(card.id, card.id, 0)],
      ['child-two', anchor(card.id, card.id, -1)],
    ]);
    await invokeLogMethod(log, 'writeActive', [
      'chat-1',
      [first, second],
      bothAnchors,
    ]);
    await log.append('chat-1', [first], bothAnchors);
    expect(await invokeLogMethod(log, 'activeRowAnchors', ['chat-1'])).toEqual(
      new Map([['child-two', bothAnchors.get('child-two')]]),
    );
  });

  it('snapshots the journal projection without file anchors and snapshots file anchors when unprojected', async () => {
    const card = delegatedCard('write-snapshot-card');
    const child = row('write-snapshot-child', 'child', card.id);
    const projected = row('journal-snapshot-child', 'journal');
    const anchors = new Map<string, ActiveRowAnchor>([
      ['write-snapshot-child', anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child], anchors);

    expect(await invokeLogMethod(log, 'activeSnapshot', ['chat-1'])).toEqual({
      messages: [child],
      anchors,
    });
    log.setActiveProjection((chatId) =>
      chatId === 'chat-1'
        ? { messages: [projected], transcriptRevision: 12 }
        : undefined,
    );
    expect(await invokeLogMethod(log, 'activeSnapshot', ['chat-1'])).toEqual({
      messages: [projected],
    });
  });

  it('avoids cloning cached active messages when writers need only anchors', async () => {
    const card = delegatedCard('anchor-cache-card');
    const child = row('anchor-cache-child', 'child', card.id);
    const anchors = new Map<string, ActiveRowAnchor>([
      ['anchor-cache-child', anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child], anchors);
    await log.activeMessages('chat-1');

    const clone = jest.spyOn(globalThis, 'structuredClone');
    try {
      await log.writeActiveAtRevision('chat-1', [child], 12);
      expect(clone).not.toHaveBeenCalled();
      await log.activeMessages('chat-1');
      clone.mockClear();
      await log.appendAfterActive('chat-1', [], [child], 13);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    expect(await log.activeRowAnchors('chat-1')).toEqual(anchors);
  });

  it('marks a page as anchored only when sidecar anchors placed its rows', async () => {
    const card = delegatedCard('anchored-flag-card');
    const child = row('anchored-flag-child', 'child', card.id);
    await log.append('chat-1', [card]);
    await log.writeActive('chat-1', [child]);
    const plain = await log.pageWithActiveMessages('chat-1');
    expect(plain).not.toHaveProperty('anchored');
    expect(plain.page.messages).toEqual([card, child]);

    await log.writeActive(
      'chat-1',
      [child],
      new Map<string, ActiveRowAnchor>([
        ['anchored-flag-child', anchor(card.id, card.id, 0)],
      ]),
    );
    const anchored = await log.pageWithActiveMessages('chat-1');
    expect(anchored.anchored).toBe(true);
    expect(anchored.page.messages).toEqual([card, child]);
    expect(anchored.activeMessages).toEqual([child]);
  });

  it('carries anchors across consecutive active writes without rereading the sidecar', async () => {
    const card = delegatedCard('anchor-repeat-card');
    const child = row('anchor-repeat-child', 'child', card.id);
    const anchors = new Map<string, ActiveRowAnchor>([
      ['anchor-repeat-child', anchor(card.id, card.id, 0)],
    ]);
    await log.append('chat-1', [card]);
    await log.writeActiveAtRevision('chat-1', [child], 11, anchors);

    const sidecar = join(root, 'chat-1.active.json');
    const read = jest.spyOn(fs, 'createReadStream');
    try {
      await log.writeActiveAtRevision('chat-1', [child], 12);
      await log.writeActiveAtRevision('chat-1', [child], 13);
      expect(read.mock.calls.map(([file]) => String(file))).not.toContain(
        sidecar,
      );
    } finally {
      read.mockRestore();
    }
    expect(await log.activeRowAnchors('chat-1')).toEqual(anchors);
  });

  it('rejects malformed present anchor fields instead of reading them as legacy records', async () => {
    const header = {
      version: 2,
      transcriptRevision: 0,
      updatedAt: new Date(0).toISOString(),
    };
    const malformedRecord = {
      version: 2,
      kind: 'message',
      message: row('invalid-anchor'),
      anchor: null,
    };
    await writeFile(
      join(root, 'chat-1.active.json'),
      `${JSON.stringify(header)}\n${JSON.stringify(malformedRecord)}\n`,
    );
    await expect(log.activeMessages('chat-1')).rejects.toThrow(
      'Invalid active transcript sidecar anchor',
    );
  });

  it('shape-validates every explicit anchor before filtering removed rows', async () => {
    await log.writeActive('chat-1', [row('still-active')]);
    const before = await readFile(join(root, 'chat-1.active.json'), 'utf8');
    const malformed = anchor('missing-card', null, 0);
    Reflect.set(malformed, 'tie', 'zero');
    const explicit = new Map<string, ActiveRowAnchor>([
      ['already-removed', malformed],
    ]);

    await expect(
      invokeLogMethod(log, 'replaceActive', ['chat-1', [], explicit]),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'chat-1.active.json'), 'utf8')).toBe(
      before,
    );
  });

  it('rejects custom-prototype anchors instead of normalizing malformed explicit input', async () => {
    const custom = anchor('missing-card', null, 0);
    Reflect.setPrototypeOf(custom, { unexpected: true });
    const explicit = new Map<string, ActiveRowAnchor>([
      ['already-removed', custom],
    ]);
    await expect(
      invokeLogMethod(log, 'replaceActive', ['chat-1', [], explicit]),
    ).rejects.toThrow();
  });

  it('rejects invalid explicit anchors without changing the canonical sidecar', async () => {
    const card = delegatedCard('run-card');
    await log.append('chat-1', [card]);
    const child = row('owned-child', 'child', card.id);
    const header = {
      version: 2,
      transcriptRevision: 1,
      updatedAt: new Date(0).toISOString(),
    };
    const validRecord: ActiveSidecarMessageRecord = {
      version: 2,
      kind: 'message',
      message: child,
      anchor: anchor(card.id, card.id, 0),
    };
    await writeFile(
      join(root, 'chat-1.active.json'),
      `${JSON.stringify(header)}\n${JSON.stringify(validRecord)}\n`,
    );
    const before = await readFile(join(root, 'chat-1.active.json'), 'utf8');
    const invalid = new Map([['owned-child', anchor('unknown-card', null, 0)]]);

    await expect(
      invokeLogMethod(log, 'writeActive', ['chat-1', [child], invalid]),
    ).rejects.toThrow(/anchor/i);
    expect(await readFile(join(root, 'chat-1.active.json'), 'utf8')).toBe(
      before,
    );
  });

  it('checks complete anchored JSON records including escaped IDs and finalizing metadata before rename', async () => {
    const runId = `delegated-agent-${'😀"\\'.repeat(123)}xyz`;
    const predecessorId = '🌲"\\'.repeat(128);
    const childId = '🪴"\\'.repeat(128);
    const card = delegatedCard(runId);
    await log.append('chat-1', [card, row(predecessorId)]);
    const recordFor = (
      text: string,
      finalizing = false,
    ): ActiveSidecarMessageRecord => ({
      version: 2,
      kind: 'message',
      message: row(childId, text, card.id),
      anchor: anchor(runId, predecessorId, 0),
      ...(finalizing ? { finalizing: true } : {}),
    });
    const ceiling = MAX_TRANSCRIPT_ROW_BYTES + 1024;
    const emptyRecord = recordFor('');
    const textLength = ceiling - activeSidecarMessageRecordBytes(emptyRecord);
    const exactText = 'x'.repeat(textLength);
    const exactRecord = recordFor(exactText);
    const overRecord = recordFor(`${exactText}x`);
    expect(activeSidecarMessageRecordBytes(exactRecord)).toBe(ceiling);
    expect(checkActiveSidecarMessageRecordBudget(exactRecord)).toEqual({
      bytes: ceiling,
      ceiling,
      withinLimit: true,
    });
    expect(checkActiveSidecarMessageRecordBudget(overRecord).withinLimit).toBe(
      false,
    );

    const exactMessage = exactRecord.message;
    const exactAnchor = exactRecord.anchor;
    if (!exactAnchor) throw new Error('Expected exact-budget record anchor');
    const exactAnchors = new Map<string, ActiveRowAnchor>([
      [childId, exactAnchor],
    ]);
    await invokeLogMethod(log, 'writeActive', [
      'chat-1',
      [exactMessage],
      exactAnchors,
    ]);
    const beforeOverLimit = await readFile(
      join(root, 'chat-1.active.json'),
      'utf8',
    );
    await expect(
      invokeLogMethod(log, 'writeActive', [
        'chat-1',
        [overRecord.message],
        exactAnchors,
      ]),
    ).rejects.toThrow(/record|size|maximum/i);
    expect(await readFile(join(root, 'chat-1.active.json'), 'utf8')).toBe(
      beforeOverLimit,
    );

    const finalizingRecord = recordFor(exactText, true);
    expect(
      checkActiveSidecarMessageRecordBudget(finalizingRecord).withinLimit,
    ).toBe(false);
    const interrupted = new ChatTranscriptLog(root, (boundary) =>
      boundary === 'prepared'
        ? Promise.reject(new Error('stop before append'))
        : Promise.resolve(),
    );
    await expect(interrupted.append('chat-1', [exactMessage])).rejects.toThrow(
      /record|size|maximum/i,
    );
    expect(await readFile(join(root, 'chat-1.active.json'), 'utf8')).toBe(
      beforeOverLimit,
    );
  });

  it.each([
    [
      'unknown run card',
      (cardId: string): ActiveRowAnchor => anchor('missing-card', cardId, 0),
    ],
    [
      'dangling predecessor',
      (cardId: string): ActiveRowAnchor =>
        anchor(cardId, 'missing-predecessor', 0),
    ],
  ] as const)(
    'rejects a semantically invalid pending anchor intent before recovery (%s)',
    async (_reason, buildAnchor) => {
      const card = delegatedCard('recovery-card');
      await log.append('chat-1', [card]);
      const child = row('pending-child', 'child', card.id);
      const stagedId = 'pending-anchor-recovery';
      const byteOffset = (await stat(join(root, 'chat-1.jsonl'))).size;
      const header = {
        version: 2,
        transcriptRevision: 2,
        updatedAt: new Date(0).toISOString(),
        finalizing: { stagedId, byteOffset },
      };
      const pendingRecord = {
        version: 2,
        kind: 'message',
        message: child,
        anchor: buildAnchor(card.id),
        finalizing: true,
      };
      const sidecarPath = join(root, 'chat-1.active.json');
      const stagedPath = join(root, `chat-1.${stagedId}.append.tmp`);
      await writeFile(
        sidecarPath,
        `${JSON.stringify(header)}\n${JSON.stringify(pendingRecord)}\n`,
      );
      await writeFile(stagedPath, `${JSON.stringify(child)}\n`);
      const sidecarBefore = await readFile(sidecarPath, 'utf8');
      const logBefore = await readFile(join(root, 'chat-1.jsonl'), 'utf8');

      await expect(new ChatTranscriptLog(root).page('chat-1')).rejects.toThrow(
        /anchor/i,
      );
      expect(await readFile(sidecarPath, 'utf8')).toBe(sidecarBefore);
      expect(await readFile(join(root, 'chat-1.jsonl'), 'utf8')).toBe(
        logBefore,
      );
      await expect(readFile(stagedPath)).resolves.toBeDefined();
    },
  );

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

  it.each([
    'prepared',
    'appended',
    'index-published',
    'survivors-published',
  ] as const)(
    'preserves survivor anchors when append recovery crosses the %s boundary',
    async (boundary) => {
      const card = delegatedCard('anchor-fault-card');
      const finalized = row('finalized-child', 'finalized', card.id);
      const survivor = row('surviving-child', 'survivor', card.id);
      await log.append('chat-1', [card]);
      const anchors = new Map<string, ActiveRowAnchor>([
        ['finalized-child', anchor(card.id, card.id, 0)],
        ['surviving-child', anchor(card.id, card.id, -1)],
      ]);
      await log.writeActive('chat-1', [finalized, survivor], anchors);
      let interrupted = false;
      const faulting = new ChatTranscriptLog(root, (at) => {
        if (!interrupted && at === boundary) {
          interrupted = true;
          return Promise.reject(new Error(`fault at ${boundary}`));
        }
        return Promise.resolve();
      });
      await expect(faulting.append('chat-1', [finalized])).rejects.toThrow(
        `fault at ${boundary}`,
      );

      const recovered = new ChatTranscriptLog(root);
      // Pages are in logical order: the survivor's tie (-1) places it nearer
      // the card than the finalized row (tie 0), before and after recovery.
      expect((await recovered.page('chat-1')).messages).toEqual([
        card,
        survivor,
        finalized,
      ]);
      expect(await recovered.activeRowAnchors('chat-1')).toEqual(
        new Map([['surviving-child', anchors.get('surviving-child')]]),
      );
    },
  );

  it.each([
    'prepared',
    'appended',
    'index-published',
    'survivors-published',
  ] as const)(
    'recovers a complete active suffix and its anchors after the %s append boundary',
    async (boundary) => {
      const card = delegatedCard(`append-suffix-recovery-${boundary}`);
      const ordinary = row(`append-suffix-recovery-ordinary-${boundary}`);
      const child = row(
        `append-suffix-recovery-child-${boundary}`,
        'child',
        card.id,
      );
      const survivor = row(
        `append-suffix-recovery-survivor-${boundary}`,
        'survivor',
        card.id,
      );
      const anchors = new Map<string, ActiveRowAnchor>([
        [child.id, anchor(card.id, card.id, 0)],
        [survivor.id, anchor(card.id, child.id, 0)],
      ]);
      await log.append('chat-1', [card]);
      await log.writeActive('chat-1', [ordinary, child, survivor], anchors);
      let interrupted = false;
      const faulting = new ChatTranscriptLog(root, (at) => {
        if (!interrupted && at === boundary) {
          interrupted = true;
          return Promise.reject(new Error(`fault at ${boundary}`));
        }
        return Promise.resolve();
      });
      await expect(
        appendWithActiveTail(
          faulting,
          'chat-1',
          [ordinary, child, survivor],
          anchors,
          2,
        ),
      ).rejects.toThrow(`fault at ${boundary}`);

      const recovered = new ChatTranscriptLog(root);
      expect(await recovered.activeMessages('chat-1')).toEqual([
        child,
        survivor,
      ]);
      const committedIds = (await readFile(join(root, 'chat-1.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (!isPersistedChatMessage(value))
            throw new Error('Expected a committed transcript row');
          return value.id;
        });
      expect(committedIds).toEqual([card.id, ordinary.id]);
      expect(await recovered.activeRowAnchors('chat-1')).toEqual(anchors);
      expect((await recovered.page('chat-1')).messages).toEqual([
        card,
        child,
        survivor,
        ordinary,
      ]);
    },
  );

  it('preserves anchors while abandoning an interrupted append intent', async () => {
    const card = delegatedCard('anchor-abandon-card');
    const finalized = row('abandoned-child', 'finalized', card.id);
    const survivor = row('abandon-survivor', 'survivor', card.id);
    await log.append('chat-1', [card]);
    const anchors = new Map<string, ActiveRowAnchor>([
      ['abandoned-child', anchor(card.id, card.id, 0)],
      ['abandon-survivor', anchor(card.id, card.id, -1)],
    ]);
    await log.writeActive('chat-1', [finalized, survivor], anchors);
    const interrupted = new ChatTranscriptLog(root, (boundary) =>
      boundary === 'prepared'
        ? Promise.reject(new Error('prepared interruption'))
        : Promise.resolve(),
    );
    await expect(interrupted.append('chat-1', [finalized])).rejects.toThrow(
      'prepared interruption',
    );
    const [stagedName] = (await readdir(root)).filter((name) =>
      name.endsWith('.append.tmp'),
    );
    if (!stagedName) throw new Error('Expected a staged append');
    await rm(join(root, stagedName), { force: true });
    const abandonFault = new ChatTranscriptLog(root, (boundary) =>
      boundary === 'abandoned'
        ? Promise.reject(new Error('abandon interruption'))
        : Promise.resolve(),
    );
    await expect(abandonFault.page('chat-1')).rejects.toThrow(
      'abandon interruption',
    );
    const settledRecords = activeSidecarRows(
      await readFile(join(root, 'chat-1.active.json'), 'utf8'),
    );
    expect(settledRecords[0]).not.toHaveProperty('finalizing');
    const recovered = new ChatTranscriptLog(root);
    // Logical order: the survivor's tie (-1) precedes the finalized row's (0).
    expect((await recovered.page('chat-1')).messages).toEqual([
      card,
      survivor,
      finalized,
    ]);
    expect(await recovered.activeRowAnchors('chat-1')).toEqual(anchors);
  });

  it('reads an active projection for anchor validation without replaying a pending append', async () => {
    await log.append('chat-1', [message(0, 'user')]);
    const pending = message(1);
    const interrupted = new ChatTranscriptLog(root, (boundary) =>
      boundary === 'prepared'
        ? Promise.reject(new Error('leave prepared append'))
        : Promise.resolve(),
    );
    await expect(interrupted.append('chat-1', [pending])).rejects.toThrow(
      'leave prepared append',
    );
    const sidecarPath = join(root, 'chat-1.active.json');
    const stagedNames = (await readdir(root)).filter((name) =>
      name.endsWith('.append.tmp'),
    );
    const sidecarBefore = await readFile(sidecarPath, 'utf8');
    const logBefore = await readFile(join(root, 'chat-1.jsonl'), 'utf8');

    expect(
      await new ChatTranscriptLog(root).activeMessagesForAnchorValidation(
        'chat-1',
      ),
    ).toEqual([pending]);
    expect(await readFile(sidecarPath, 'utf8')).toBe(sidecarBefore);
    expect(await readFile(join(root, 'chat-1.jsonl'), 'utf8')).toBe(logBefore);
    expect(
      (await readdir(root)).filter((name) => name.endsWith('.append.tmp')),
    ).toEqual(stagedNames);
  });

  it('validates active anchors through verified committed locators without scanning the JSONL hot path', async () => {
    const card = delegatedCard('locator-validation-hot-path-card');
    const predecessor = message(2, 'user');
    const child = row('locator-validation-hot-path-child', 'child', card.id);
    const anchors = new Map<string, ActiveRowAnchor>([
      [child.id, anchor(card.id, predecessor.id, 0)],
    ]);
    await log.append('chat-1', [message(0, 'user'), card, predecessor]);
    await log.writeActive('chat-1', [child], anchors);

    const scan = jest.spyOn(fs, 'createReadStream');
    await log.validateActiveRowAnchors('chat-1', [child], anchors);
    expect(
      scan.mock.calls.filter(
        ([file]) => String(file) === join(root, 'chat-1.jsonl'),
      ),
    ).toHaveLength(0);
    scan.mockRestore();
  });

  // Coverage-green-first: missing and invalid derived locators must fall back
  // without repairing files; the locator hot-path regression above was red.
  it.each(['missing', 'offset', 'length', 'digest'] as const)(
    'falls back to a committed JSONL scan for a %s anchor locator without repairing it',
    async (invalidPart) => {
      const card = delegatedCard('locator-validation-fallback-card');
      const child = row('locator-validation-fallback-child', 'child', card.id);
      const anchors = new Map<string, ActiveRowAnchor>([
        [child.id, anchor(card.id, card.id, 0)],
      ]);
      await log.append('chat-1', [card]);
      await log.writeActive('chat-1', [child], anchors);
      const locatorPath = join(
        root,
        'message-index',
        'chat-1',
        `${createHash('sha256').update(card.id).digest('hex')}.json`,
      );
      let locatorBefore: string | undefined;
      if (invalidPart === 'missing') await rm(locatorPath, { force: true });
      else {
        const locator: unknown = JSON.parse(
          await readFile(locatorPath, 'utf8'),
        );
        if (!isRecord(locator) || typeof locator.end !== 'number')
          throw new Error('Expected committed message locator');
        if (invalidPart === 'offset') locator.offset = 1;
        else if (invalidPart === 'length') locator.end -= 1;
        else locator.digest = '0'.repeat(64);
        locatorBefore = JSON.stringify(locator);
        await writeFile(locatorPath, locatorBefore, 'utf8');
      }
      const indexBefore = await readFile(
        join(root, 'chat-1.index.json'),
        'utf8',
      );

      const scan = jest.spyOn(fs, 'createReadStream');
      await log.validateActiveRowAnchors('chat-1', [child], anchors);
      expect(
        scan.mock.calls.filter(
          ([file]) => String(file) === join(root, 'chat-1.jsonl'),
        ),
      ).toHaveLength(1);
      if (invalidPart === 'missing')
        await expect(readFile(locatorPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      else expect(await readFile(locatorPath, 'utf8')).toBe(locatorBefore);
      expect(await readFile(join(root, 'chat-1.index.json'), 'utf8')).toBe(
        indexBefore,
      );
      scan.mockRestore();
    },
  );

  it('restores a snapshotted suffix anchor after replace removes the active sidecar', async () => {
    const card = delegatedCard('replace-snapshot-card');
    const finalized = row('replace-finalized', 'finalized', card.id);
    const suffix = row('replace-suffix', 'suffix', card.id);
    await log.append('chat-1', [card]);
    const anchors = new Map<string, ActiveRowAnchor>([
      ['replace-finalized', anchor(card.id, card.id, 0)],
      ['replace-suffix', anchor(card.id, 'replace-finalized', 0)],
    ]);
    await log.writeActive('chat-1', [finalized, suffix], anchors);
    const saved = await log.activeRowAnchors('chat-1');
    const faulting = new ChatTranscriptLog(root, undefined, {
      testHooks: {
        onReplaceBoundary: (): Promise<void> =>
          Promise.reject(new Error('replace sidecar removed')),
      },
    });
    await expect(
      faulting.replace('chat-1', [card, finalized], 20),
    ).rejects.toThrow('replace sidecar removed');
    await expect(
      readFile(join(root, 'chat-1.active.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const suffixAnchor = saved.get('replace-suffix');
    if (!suffixAnchor) throw new Error('Expected a snapshotted suffix anchor');
    await new ChatTranscriptLog(root).writeActive(
      'chat-1',
      [suffix],
      new Map([['replace-suffix', suffixAnchor]]),
    );
    expect(
      await new ChatTranscriptLog(root).activeRowAnchors('chat-1'),
    ).toEqual(new Map([['replace-suffix', anchors.get('replace-suffix')]]));
  });

  it('keeps anchor-free active record bytes unchanged and omits the optional field', async () => {
    const active = [row('anchor-free-row', 'unchanged')];
    const clock = jest
      .spyOn(Date.prototype, 'toISOString')
      .mockReturnValue(new Date(0).toISOString());
    try {
      await log.writeActive('chat-1', active);
    } finally {
      clock.mockRestore();
    }
    const raw = await readFile(join(root, 'chat-1.active.json'), 'utf8');
    expect(raw).toBe(
      `${JSON.stringify({
        version: 2,
        transcriptRevision: 1,
        updatedAt: new Date(0).toISOString(),
      })}\n${JSON.stringify({ version: 2, kind: 'message', message: active[0] })}\n`,
    );
    expect(activeSidecarRows(raw)[1]).not.toHaveProperty('anchor');
  });

  describe('logical anchored transcript reads', () => {
    it('reads known run cards without anchors from committed or active storage', async () => {
      const committedCard = delegatedCard('logical-unanchored-committed-run');
      const activeCard = delegatedCard('logical-unanchored-active-run');
      await log.append('chat-1', [message(0, 'user'), committedCard]);
      await log.writeActive('chat-1', [activeCard]);
      expect(await log.readRunMessages('chat-1', committedCard.id)).toEqual([
        committedCard,
      ]);
      expect(await log.readRunMessages('chat-1', activeCard.id)).toEqual([
        activeCard,
      ]);
    });

    it.each([true, false])(
      'matches the logical raw and turn-page oracle with active sidecar present: %s',
      async (hasActiveSidecar) => {
        // 501 committed rows exercise newest/older raw pages and 101 turns with a compact locator tree.
        const committed = [
          ...Array.from({ length: 100 }, (_, turn) => [
            message(turn * 5, 'user'),
            message(turn * 5 + 1),
            message(turn * 5 + 2),
            {
              ...message(turn * 5 + 3, 'system'),
              blocks: [
                {
                  type: 'turn_timer' as const,
                  startedAt: turn * 5,
                  completedAt: turn * 5 + 3,
                },
              ],
            },
            message(turn * 5 + 4),
          ]).flat(),
          message(500, 'user'),
        ];
        await log.append('chat-1', committed);
        const active = hasActiveSidecar
          ? [message(900, 'user'), message(901)]
          : [];
        if (active.length > 0) await log.writeActive('chat-1', active);

        const descriptor = await log.descriptor('chat-1');
        const oracle = await logicalTranscriptOracle({
          committed,
          active,
          anchors: new Map(),
          revision: descriptor.transcriptRevision,
        });

        const projectedReader = new ChatTranscriptLog(root, undefined, {
          readOnly: true,
        });
        projectedReader.setActiveProjection((candidateChatId) =>
          candidateChatId === 'chat-1'
            ? {
                messages: active,
                transcriptRevision: descriptor.transcriptRevision,
              }
            : undefined,
        );
        expect(await projectedReader.page('chat-1')).toEqual(oracle.rawPage());
        expect(
          await projectedReader.page('chat-1', undefined, { view: 'turns' }),
        ).toEqual(oracle.turnPage());
        expect(await projectedReader.descriptor('chat-1')).toEqual(descriptor);

        const newestRaw = await log.page('chat-1');
        expect(newestRaw).toEqual(oracle.rawPage());
        if (newestRaw.before !== undefined) {
          expect(await log.page('chat-1', newestRaw.before)).toEqual(
            oracle.rawPage(newestRaw.before),
          );
        }
        const middleRawCursor = oracle.body.length - 1;
        expect(await log.page('chat-1', middleRawCursor)).toEqual(
          oracle.rawPage(middleRawCursor),
        );

        const newestTurns = await log.page('chat-1', undefined, {
          view: 'turns',
        });
        expect(newestTurns).toEqual(oracle.turnPage());
        if (newestTurns.before !== undefined) {
          expect(
            await log.page('chat-1', newestTurns.before, { view: 'turns' }),
          ).toEqual(oracle.turnPage(newestTurns.before));
        }
        expect(await logicalIteratorMessages(log, 'chat-1')).toEqual(
          oracle.messages,
        );
      },
      30_000,
    );

    it('weaves start and tied run anchors depth-first, independent of sidecar order', async () => {
      // The 505-row base puts the tied cards across the 500-row raw-page boundary.
      const committed = Array.from({ length: 505 }, (_, id) =>
        id % 5 === 0 ? message(id, 'user') : message(id),
      );
      const startCard = delegatedCard('logical-start-run');
      const earlyRunCard = delegatedCard('logical-tied-run-early');
      const laterRunCard = delegatedCard('logical-tied-run-late');
      const startChild = row(
        'logical-start-child',
        'start child',
        startCard.id,
      );
      const earlyLow = {
        ...row('logical-early-low', 'tie -2', earlyRunCard.id),
        delegationSequence: 2,
      };
      const earlyRoot = {
        ...row('logical-early-root', 'root', earlyRunCard.id),
        delegationSequence: 1,
      };
      const earlyNested = row(
        'logical-early-nested',
        'nested after root',
        earlyRunCard.id,
      );
      const laterRoot = row('logical-late-root', 'later run', laterRunCard.id);
      // Physical sidecar order deliberately disagrees with the stored tie order.
      const active = [
        earlyNested,
        laterRoot,
        earlyRunCard,
        startChild,
        laterRunCard,
        earlyRoot,
        earlyLow,
        startCard,
      ];
      const anchors = new Map<string, ActiveRowAnchor>([
        [startCard.id, anchor(startCard.id, null, 0)],
        [earlyRunCard.id, anchor(earlyRunCard.id, 'm-499', -1)],
        [laterRunCard.id, anchor(laterRunCard.id, 'm-499', 0)],
        [startChild.id, anchor(startCard.id, startCard.id, 0)],
        [earlyLow.id, anchor(earlyRunCard.id, earlyRunCard.id, -2)],
        [earlyRoot.id, anchor(earlyRunCard.id, earlyRunCard.id, 0)],
        [earlyNested.id, anchor(earlyRunCard.id, earlyRoot.id, 0)],
        [laterRoot.id, anchor(laterRunCard.id, laterRunCard.id, 0)],
      ]);
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);
      expect(active.indexOf(earlyLow)).toBeGreaterThan(
        active.indexOf(earlyRoot),
      );
      expect(anchors.get(earlyLow.id)?.tie).toBeLessThan(
        anchors.get(earlyRoot.id)?.tie ?? 0,
      );

      const descriptor = await log.descriptor('chat-1');
      const oracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: descriptor.transcriptRevision,
      });
      expect(oracle.messages.slice(0, 3)).toEqual([
        startCard,
        startChild,
        committed[0],
      ]);
      expect(
        oracle.messages.slice(
          oracle.messageOrdinals[earlyRunCard.id],
          oracle.messageOrdinals[earlyRunCard.id] + 6,
        ),
      ).toEqual([
        earlyRunCard,
        earlyLow,
        earlyRoot,
        earlyNested,
        laterRunCard,
        laterRoot,
      ]);
      expect(oracle.messageOrdinals[earlyRunCard.id]).toBeLessThan(
        oracle.messageOrdinals[laterRunCard.id],
      );

      const newestRaw = await log.page('chat-1');
      expect(newestRaw).toEqual(oracle.rawPage());
      if (newestRaw.before !== undefined) {
        expect(await log.page('chat-1', newestRaw.before)).toEqual(
          oracle.rawPage(newestRaw.before),
        );
      }
      expect(await log.page('chat-1', 507)).toEqual(oracle.rawPage(507));

      const newestTurns = await log.page('chat-1', undefined, {
        view: 'turns',
      });
      expect(newestTurns).toEqual(oracle.turnPage());
      if (newestTurns.before !== undefined) {
        expect(
          await log.page('chat-1', newestTurns.before, { view: 'turns' }),
        ).toEqual(oracle.turnPage(newestTurns.before));
      }
      const earlyOrdinal = oracle.messageOrdinals[earlyRunCard.id];
      const owner = oracle.turns.find(
        (turn) => turn.start <= earlyOrdinal && earlyOrdinal < turn.end,
      );
      if (!owner) throw new Error('Expected a turn to own the anchored run');
      const ownerPage = await log.page('chat-1', owner.end, {
        view: 'turns',
        turnId: owner.id,
      });
      expect(ownerPage).toEqual(
        oracle.turnPage(owner.end, { turnId: owner.id }),
      );
      expect(ownerPage.messageOrdinals?.[earlyRunCard.id]).toBe(earlyOrdinal);
      expect(await logicalIteratorMessages(log, 'chat-1')).toEqual(
        oracle.messages,
      );
    }, 30_000);

    it('keeps logical ranks on content edits and appends new rows downstream', async () => {
      const committed = [
        message(0, 'user'),
        message(1),
        message(2),
        message(3),
        message(4),
      ];
      const card = delegatedCard('logical-rank-run');
      const rootChild = row('logical-rank-root', 'root before edit', card.id);
      const nestedChild = row('logical-rank-nested', 'nested', card.id);
      const sibling = row('logical-rank-sibling', 'sibling', card.id);
      const active = [sibling, nestedChild, card, rootChild];
      const anchors = new Map<string, ActiveRowAnchor>([
        [card.id, anchor(card.id, 'm-1', 0)],
        [rootChild.id, anchor(card.id, card.id, 0)],
        [nestedChild.id, anchor(card.id, rootChild.id, 0)],
        [sibling.id, anchor(card.id, card.id, 1)],
      ]);
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);
      const firstRevision = (await log.descriptor('chat-1')).transcriptRevision;
      const firstOracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: firstRevision,
      });

      const updatedRoot: PersistedChatMessage = {
        ...rootChild,
        blocks: [{ type: 'text', text: 'root after content update' }],
      };
      const updatedActive = active.map((entry) =>
        entry.id === rootChild.id ? updatedRoot : entry,
      );
      await log.writeActive('chat-1', updatedActive, anchors);
      const updatedRevision = (await log.descriptor('chat-1'))
        .transcriptRevision;
      const updatedOracle = await logicalTranscriptOracle({
        committed,
        active: updatedActive,
        anchors,
        revision: updatedRevision,
      });
      expect(updatedOracle.messageOrdinals).toEqual(
        firstOracle.messageOrdinals,
      );
      expect(updatedOracle.messages).toContainEqual(updatedRoot);
      expect(await logicalIteratorMessages(log, 'chat-1')).toEqual(
        updatedOracle.messages,
      );

      const downstream = row(
        'logical-rank-added',
        'new anchored child',
        card.id,
      );
      const finalActive = [...updatedActive, downstream];
      const finalAnchors = new Map(anchors);
      finalAnchors.set(downstream.id, anchor(card.id, rootChild.id, -1));
      await log.writeActive('chat-1', finalActive, finalAnchors);
      const finalRevision = (await log.descriptor('chat-1')).transcriptRevision;
      const finalOracle = await logicalTranscriptOracle({
        committed,
        active: finalActive,
        anchors: finalAnchors,
        revision: finalRevision,
      });
      const insertionRank = updatedOracle.messageOrdinals[nestedChild.id];
      for (const [id, ordinal] of Object.entries(updatedOracle.messageOrdinals))
        expect(finalOracle.messageOrdinals[id]).toBe(
          ordinal >= insertionRank ? ordinal + 1 : ordinal,
        );
      expect(finalOracle.messageOrdinals[downstream.id]).toBe(insertionRank);
      expect(await log.page('chat-1')).toEqual(finalOracle.rawPage());
      expect(await log.page('chat-1', undefined, { view: 'turns' })).toEqual(
        finalOracle.turnPage(),
      );
      expect(await logicalIteratorMessages(log, 'chat-1')).toEqual(
        finalOracle.messages,
      );
    });

    it('projects logical last-message metadata instead of sidecar order', async () => {
      const committed = [message(0, 'user'), message(1), message(2)];
      const card = delegatedCard('logical-descriptor-run');
      const first = {
        ...row('logical-descriptor-first', 'physical last row', card.id),
        timestamp: 66,
      };
      const last = {
        ...row('logical-descriptor-last', 'logical final preview', card.id),
        timestamp: 77,
      };
      const active = [last, card, first];
      const anchors = new Map<string, ActiveRowAnchor>([
        [card.id, anchor(card.id, 'm-2', 0)],
        [first.id, anchor(card.id, card.id, 0)],
        [last.id, anchor(card.id, first.id, 0)],
      ]);
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);
      const descriptor = await log.descriptor('chat-1');
      const oracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: descriptor.transcriptRevision,
      });
      const expectedLast = oracle.messages.at(-1);
      if (!expectedLast) throw new Error('Expected logical transcript rows');

      expect(descriptor.messageCount).toBe(oracle.messages.length);
      expect(descriptor.lastMessageId).toBe(expectedLast.id);
      expect(descriptor.lastMessageAt).toBe(expectedLast.timestamp);
      expect(descriptor.lastAssistantPreview).toBe('logical final preview');
      expect(descriptor.userMessageCount).toBe(1);
      expect(await logicalIteratorMessages(log, 'chat-1')).toEqual(
        oracle.messages,
      );
    });

    function toolRow(
      id: string,
      toolName: string,
      input: Record<string, unknown>,
      parentBlockId?: string,
    ): PersistedChatMessage {
      return {
        id,
        role: 'assistant',
        timestamp: 1,
        ...(parentBlockId === undefined ? {} : { parentBlockId }),
        blocks: [
          {
            type: 'tool_use',
            toolUseId: `${id}-tool`,
            toolName,
            input: JSON.stringify(input),
          },
        ],
      };
    }

    function textRow(
      id: string,
      text: string,
      role: PersistedChatMessage['role'] = 'assistant',
    ): PersistedChatMessage {
      return { id, role, timestamp: 1, blocks: [{ type: 'text', text }] };
    }

    /** Write one anchored chat and check its metadata against a fold over the
     * logical sequence: counts, last row, and TODO state. */
    async function logicalDescriptorCase(
      chatId: string,
      committed: PersistedChatMessage[],
      active: PersistedChatMessage[],
      anchors: Map<string, ActiveRowAnchor>,
    ): Promise<Awaited<ReturnType<ChatTranscriptLog['descriptor']>>> {
      if (chatId !== 'chat-1') await log.initialize(chatId);
      await log.append(chatId, committed);
      await log.writeActive(chatId, active, anchors);
      const descriptor = await log.descriptor(chatId);
      const oracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: descriptor.transcriptRevision,
      });
      const logical = oracle.messages;
      expect(await logicalIteratorMessages(log, chatId)).toEqual(logical);
      const todoState = logical.reduce<
        Parameters<typeof foldTranscriptTodoState>[0]
      >(foldTranscriptTodoState, {});
      expect(descriptor.todos).toEqual(todoState.todos);
      expect(descriptor.taskTodos).toEqual(todoState.taskTodos);
      expect(descriptor.messageCount).toBe(logical.length);
      expect(descriptor.userMessageCount).toBe(
        logical.filter((entry) => entry.role === 'user').length,
      );
      expect(descriptor.lastMessageId).toBe(logical.at(-1)?.id);
      expect((await log.page(chatId)).totalMessages).toBe(logical.length);
      return descriptor;
    }

    it('takes the preview from the newest logical row with text, skipping a tool-only row', async () => {
      const card = delegatedCard('logical-preview-tool-run');
      const text = row('logical-preview-text', 'delegate text', card.id);
      const tool = toolRow(
        'logical-preview-tool',
        'Read',
        { file_path: 'a.ts' },
        card.id,
      );
      const descriptor = await logicalDescriptorCase(
        'chat-1',
        [message(0, 'user'), textRow('m-1', 'committed preview')],
        [tool, card, text],
        new Map<string, ActiveRowAnchor>([
          [card.id, anchor(card.id, 'm-1', 0)],
          [text.id, anchor(card.id, card.id, 0)],
          [tool.id, anchor(card.id, text.id, 0)],
        ]),
      );
      expect(descriptor.lastAssistantPreview).toBe('delegate text');
    });

    it('compares an anchored preview with the last committed preview in logical order', async () => {
      // The anchored text follows the last committed text but precedes a
      // trailing committed user row.
      const card = delegatedCard('logical-preview-trailing-run');
      const child = row('logical-preview-trailing', 'anchored text', card.id);
      const trailing = await logicalDescriptorCase(
        'chat-1',
        [
          message(0, 'user'),
          textRow('m-1', 'committed preview'),
          message(2, 'user'),
        ],
        [child, card],
        new Map<string, ActiveRowAnchor>([
          [card.id, anchor(card.id, 'm-1', 0)],
          [child.id, anchor(card.id, card.id, 0)],
        ]),
      );
      expect(trailing.lastAssistantPreview).toBe('anchored text');

      // A later committed text still wins over an earlier anchored one.
      const earlier = await logicalDescriptorCase(
        'chat-2',
        [
          message(0, 'user'),
          textRow('m-1', 'early committed'),
          message(2, 'user'),
          textRow('m-3', 'later committed'),
        ],
        [child, card],
        new Map<string, ActiveRowAnchor>([
          [card.id, anchor(card.id, 'm-1', 0)],
          [child.id, anchor(card.id, card.id, 0)],
        ]),
      );
      expect(earlier.lastAssistantPreview).toBe('later committed');
    });

    it('folds TODO state in logical order around anchored rows', async () => {
      const todoWrite = (
        id: string,
        content: string,
        parentBlockId?: string,
      ): PersistedChatMessage =>
        toolRow(
          id,
          'TodoWrite',
          { todos: [{ id: content, content, status: 'pending' }] },
          parentBlockId,
        );
      const card = delegatedCard('logical-todo-run');
      const committed = [
        message(0, 'user'),
        todoWrite('todo-a', 'committed first'),
        message(2, 'user'),
        todoWrite('todo-b', 'committed last'),
      ];
      const child = todoWrite('logical-todo-child', 'anchored', card.id);
      // Anchored before the last committed TodoWrite: that write still wins.
      const middle = await logicalDescriptorCase(
        'chat-1',
        committed,
        [child, card],
        new Map<string, ActiveRowAnchor>([
          [card.id, anchor(card.id, 'todo-a', 0)],
          [child.id, anchor(card.id, card.id, 0)],
        ]),
      );
      expect(middle.todos?.map((item) => item.content)).toEqual([
        'committed last',
      ]);
      // Anchored after it: the anchored write wins.
      const after = await logicalDescriptorCase(
        'chat-2',
        committed,
        [child, card],
        new Map<string, ActiveRowAnchor>([
          [card.id, anchor(card.id, 'todo-b', 0)],
          [child.id, anchor(card.id, card.id, 0)],
        ]),
      );
      expect(after.todos?.map((item) => item.content)).toEqual(['anchored']);

      // Task ids without an explicit id are numbered in logical order.
      const taskCard = delegatedCard('logical-task-run');
      const anchoredTask = toolRow(
        'logical-task-child',
        'TaskCreate',
        { subject: 'anchored task' },
        taskCard.id,
      );
      const tasks = await logicalDescriptorCase(
        'chat-3',
        [
          message(0, 'user'),
          textRow('m-1', 'before the run'),
          message(2, 'user'),
          toolRow('later-task', 'TaskCreate', { subject: 'later task' }),
        ],
        [anchoredTask, taskCard],
        new Map<string, ActiveRowAnchor>([
          [taskCard.id, anchor(taskCard.id, 'm-1', 0)],
          [anchoredTask.id, anchor(taskCard.id, taskCard.id, 0)],
        ]),
      );
      expect(tasks.taskTodos).toEqual([
        { id: 'task:1', content: 'anchored task', status: 'pending' },
        { id: 'task:2', content: 'later task', status: 'pending' },
      ]);
    });

    it('reuses committed TODO operations across active TODO updates without changing logical order', async () => {
      const todoWrite = (
        id: string,
        content: string,
        parentBlockId?: string,
      ): PersistedChatMessage =>
        toolRow(
          id,
          'TodoWrite',
          { todos: [{ id: content, content, status: 'pending' }] },
          parentBlockId,
        );
      const card = delegatedCard('bounded-todo-run');
      const committed = [
        message(0, 'user'),
        todoWrite('bounded-todo-first', 'first committed'),
        message(2, 'user'),
        todoWrite('bounded-todo-last', 'last committed'),
      ];
      const childId = 'bounded-todo-child';
      const anchors = new Map<string, ActiveRowAnchor>([
        [card.id, anchor(card.id, 'bounded-todo-first', 0)],
        [childId, anchor(card.id, card.id, 0)],
      ]);
      await log.append('chat-1', committed);
      let child = todoWrite(childId, 'initial active', card.id);
      await log.writeActive('chat-1', [child, card], anchors);

      const scan = jest.spyOn(fs, 'createReadStream');
      await log.descriptor('chat-1');
      // First identity: one bounded locator-to-rank seek plus one TODO replay.
      expect(
        scan.mock.calls.filter(
          ([file]) => String(file) === join(root, 'chat-1.jsonl'),
        ),
      ).toHaveLength(2);
      scan.mockClear();
      for (let update = 0; update < 3; update += 1) {
        child = todoWrite(childId, `active ${update}`, card.id);
        await log.writeActive('chat-1', [child, card], anchors);
        const descriptor = await log.descriptor('chat-1');
        const oracle = await logicalTranscriptOracle({
          committed,
          active: [child, card],
          anchors,
          revision: descriptor.transcriptRevision,
        });
        const expected = oracle.messages.reduce<
          Parameters<typeof foldTranscriptTodoState>[0]
        >(foldTranscriptTodoState, {});
        expect(descriptor.todos).toEqual(expected.todos);
        expect(descriptor.taskTodos).toEqual(expected.taskTodos);
      }
      expect(
        scan.mock.calls.filter(
          ([file]) => String(file) === join(root, 'chat-1.jsonl'),
        ),
      ).toHaveLength(0);
      scan.mockRestore();
    });

    it('counts a committed echo in an anchored sidecar once', async () => {
      const card = delegatedCard('logical-echo-count-run');
      const child = row('logical-echo-count-child', 'child', card.id);
      const anchors = new Map<string, ActiveRowAnchor>([
        [child.id, anchor(card.id, card.id, 0)],
      ]);
      await log.append('chat-1', [message(0, 'user'), card, message(2)]);
      await log.writeActive('chat-1', [child], anchors);
      const revision = (await log.descriptor('chat-1')).transcriptRevision;
      // A sidecar can still hold a row that finalization already committed.
      await writeUnvalidatedActiveSidecar(
        root,
        'chat-1',
        [message(0, 'user'), child],
        anchors,
        revision,
      );
      const reader = new ChatTranscriptLog(root, undefined, {
        readOnly: true,
      });
      const logical = await logicalIteratorMessages(reader, 'chat-1');
      expect(logical.map((entry) => entry.id)).toEqual([
        'm-0',
        card.id,
        child.id,
        'm-2',
      ]);
      const descriptor = await reader.descriptor('chat-1');
      expect(descriptor.messageCount).toBe(logical.length);
      expect(descriptor.userMessageCount).toBe(1);
      expect((await reader.page('chat-1')).totalMessages).toBe(logical.length);
    });

    it('keeps physical iterate and preview order separate from logical iteration', async () => {
      const card = delegatedCard('logical-physical-run');
      const committed = [message(0, 'user'), card, message(2)];
      const first = row('logical-physical-first', 'logical first', card.id);
      const last = row('logical-physical-last', 'logical last', card.id);
      const active = [last, first];
      const anchors = new Map<string, ActiveRowAnchor>([
        [first.id, anchor(card.id, card.id, 0)],
        [last.id, anchor(card.id, first.id, 0)],
      ]);
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);
      const physical: PersistedChatMessage[] = [];
      for await (const entry of log.iterate('chat-1')) physical.push(entry);
      expect(physical).toEqual(committed);

      const preview = await log.capturePreview(
        'chat-1',
        await log.descriptor('chat-1'),
      );
      const previewRows: PersistedChatMessage[] = [];
      try {
        for await (const entry of preview.activeMessages())
          previewRows.push(entry);
        expect(previewRows).toEqual(active);
        expect(() => preview.assertComplete()).not.toThrow();
      } finally {
        await preview.close();
      }

      const oracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: (await log.descriptor('chat-1')).transcriptRevision,
      });
      expect(await logicalIteratorMessages(log, 'chat-1')).toEqual(
        oracle.messages,
      );
    });

    it.each(['committed', 'live'] as const)(
      'reads the logical run card and anchored rows when the card is %s',
      async (cardLocation) => {
        const card = delegatedCard(`logical-read-run-${cardLocation}`);
        const committed =
          cardLocation === 'committed'
            ? [message(0, 'user'), card, message(2)]
            : [message(0, 'user'), message(1), message(2)];
        const first = row(
          `logical-read-first-${cardLocation}`,
          'first',
          card.id,
        );
        const last = row(`logical-read-last-${cardLocation}`, 'last', card.id);
        const active =
          cardLocation === 'committed' ? [last, first] : [last, card, first];
        const anchors = new Map<string, ActiveRowAnchor>([
          ...(cardLocation === 'live'
            ? [[card.id, anchor(card.id, 'm-1', 0)] as const]
            : []),
          [first.id, anchor(card.id, card.id, 0)],
          [last.id, anchor(card.id, first.id, 0)],
        ]);
        await log.append('chat-1', committed);
        await log.writeActive('chat-1', active, anchors);
        const descriptor = await log.descriptor('chat-1');
        const oracle = await logicalTranscriptOracle({
          committed,
          active,
          anchors,
          revision: descriptor.transcriptRevision,
        });
        const expectedRun = oracle.messages.filter(
          (entry) =>
            entry.id === card.id || anchors.get(entry.id)?.runId === card.id,
        );
        const result = await log.readRunMessages('chat-1', card.id);
        expect(result).toEqual(expectedRun);
        expect(expectedRun).toEqual([card, first, last]);
      },
    );

    it.each([
      'dangling descendant before its predecessor',
      'cycle with an incoming descendant',
      'self anchor',
      'duplicate tie at one predecessor',
      'unknown owner card',
    ] as const)(
      'fails closed on an invalid logical anchor graph: %s',
      async (failureKind) => {
        const card = delegatedCard(`invalid-logical-run-${failureKind}`);
        const committed = [message(0, 'user'), card, message(2)];
        await log.append('chat-1', committed);
        const active: PersistedChatMessage[] = [];
        const anchors = new Map<string, ActiveRowAnchor>();
        let runId = card.id;

        if (failureKind === 'dangling descendant before its predecessor') {
          const orphan = row('invalid-dangling-child', 'orphan', card.id);
          const laterRoot = row('invalid-dangling-root', 'later root', card.id);
          active.push(orphan, laterRoot);
          anchors.set(orphan.id, anchor(card.id, laterRoot.id, 0));
          anchors.set(laterRoot.id, anchor(card.id, 'missing-predecessor', 0));
        } else if (failureKind === 'cycle with an incoming descendant') {
          const rootRow = row('invalid-cycle-root', 'root', card.id);
          const cycleA = row('invalid-cycle-a', 'cycle a', card.id);
          const cycleB = row('invalid-cycle-b', 'cycle b', card.id);
          const incoming = row('invalid-cycle-incoming', 'incoming', card.id);
          active.push(incoming, cycleB, rootRow, cycleA);
          anchors.set(rootRow.id, anchor(card.id, card.id, 0));
          anchors.set(cycleA.id, anchor(card.id, cycleB.id, 0));
          anchors.set(cycleB.id, anchor(card.id, cycleA.id, 0));
          anchors.set(incoming.id, anchor(card.id, cycleA.id, 1));
        } else if (failureKind === 'self anchor') {
          const self = row('invalid-self-anchor', 'self', card.id);
          active.push(self);
          anchors.set(self.id, anchor(card.id, self.id, 0));
        } else if (failureKind === 'duplicate tie at one predecessor') {
          const first = row('invalid-duplicate-tie-first', 'first', card.id);
          const second = row('invalid-duplicate-tie-second', 'second', card.id);
          active.push(second, first);
          anchors.set(first.id, anchor(card.id, card.id, 0));
          anchors.set(second.id, anchor(card.id, card.id, 0));
        } else {
          const unknownOwner = 'missing-delegation-card';
          const child = row(
            'invalid-unknown-owner',
            'unknown owner',
            unknownOwner,
          );
          active.push(child);
          anchors.set(child.id, anchor(unknownOwner, card.id, 0));
          runId = unknownOwner;
        }

        const revision = (await log.descriptor('chat-1')).transcriptRevision;
        await writeUnvalidatedActiveSidecar(
          root,
          'chat-1',
          active,
          anchors,
          revision,
        );
        const reader = new ChatTranscriptLog(root, undefined, {
          readOnly: true,
        });

        const pageFailed = await reader.page('chat-1').then(
          () => false,
          () => true,
        );
        const turnPageFailed = await reader
          .page('chat-1', undefined, { view: 'turns' })
          .then(
            () => false,
            () => true,
          );
        const iteratorFailed = await logicalIteratorMessages(
          reader,
          'chat-1',
        ).then(
          () => false,
          () => true,
        );
        const descriptorFailed = await reader.descriptor('chat-1').then(
          () => false,
          () => true,
        );
        const runReadFailed = await reader
          .readRunMessages('chat-1', runId)
          .then(
            () => false,
            () => true,
          );
        expect(pageFailed).toBe(true);
        expect(turnPageFailed).toBe(true);
        expect(iteratorFailed).toBe(true);
        expect(descriptorFailed).toBe(true);
        expect(runReadFailed).toBe(true);
      },
    );

    it('pages a large completed affected turn while retaining its live owner card', async () => {
      // The 1,250 active children stress paged turn reconstruction without a large locator tree.
      const timer: PersistedChatMessage = {
        ...message(2, 'system'),
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
      };
      const committed = [
        message(0, 'user'),
        message(1),
        timer,
        message(3, 'user'),
        message(4),
      ];
      const card = delegatedCard('logical-large-turn-run');
      const children = Array.from({ length: 1250 }, (_, index) =>
        row(`logical-large-child-${index}`, `child ${index}`, card.id),
      );
      const active = [...children].reverse().concat(card);
      const anchors = new Map<string, ActiveRowAnchor>([
        [card.id, anchor(card.id, 'm-1', 0)],
      ]);
      children.forEach((child, index) => {
        anchors.set(
          child.id,
          anchor(card.id, index === 0 ? card.id : children[index - 1].id, 0),
        );
      });
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);

      // Warm committed and turn indexes before counting page-by-page I/O.
      await log.page('chat-1');
      await log.page('chat-1', undefined, { view: 'turns' });
      const descriptor = await log.descriptor('chat-1');
      const oracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: descriptor.transcriptRevision,
      });
      const cardOrdinal = oracle.messageOrdinals[card.id];
      const owner = oracle.turns.find(
        (turn) => turn.start <= cardOrdinal && cardOrdinal < turn.end,
      );
      if (!owner) throw new Error('Expected a completed owner turn');
      expect(owner.complete).toBe(true);

      const jsonlPath = join(root, 'chat-1.jsonl');
      const sidecarPath = join(root, 'chat-1.active.json');
      const openFile = fsPromises.open;
      let committedOpens = 0;
      let sidecarOpens = 0;
      const openSpy = jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (path, flags, mode) => {
          if (path === jsonlPath) committedOpens += 1;
          if (path === sidecarPath) sidecarOpens += 1;
          return openFile(path, flags, mode);
        });
      const streamSpy = jest.spyOn(fs, 'createReadStream');
      const committedReads = (): number =>
        committedOpens +
        streamSpy.mock.calls.filter(([path]) => String(path) === jsonlPath)
          .length;
      try {
        const ownerPage = await log.page('chat-1', owner.end, {
          view: 'turns',
          turnId: owner.id,
        });
        expect(ownerPage).toEqual(
          oracle.turnPage(owner.end, { turnId: owner.id }),
        );
        expect(ownerPage.messages).toEqual(expect.arrayContaining([card]));
        expect(ownerPage.messageOrdinals?.[card.id]).toBe(cardOrdinal);
        expect(ownerPage.messages.length).toBeLessThan(children.length);
        const pageBefore = ownerPage.turns?.[0]?.before;
        if (pageBefore === undefined)
          throw new Error('Expected a cursor for the large owner turn');

        const older = await log.page('chat-1', pageBefore, {
          view: 'turns',
          turnId: owner.id,
        });
        expect(older).toEqual(
          oracle.turnPage(pageBefore, { turnId: owner.id }),
        );
        expect(older.messages).toEqual(expect.arrayContaining([card]));
        expect(older.messages.length).toBeLessThan(children.length);
        expect(committedReads()).toBeLessThanOrEqual(2);
        expect(sidecarOpens).toBeLessThanOrEqual(1);
        const afterOlderPage = committedReads();

        const repeated = await log.page('chat-1', pageBefore, {
          view: 'turns',
          turnId: owner.id,
        });
        expect(repeated).toEqual(older);
        expect(committedReads()).toBe(afterOlderPage);
      } finally {
        openSpy.mockRestore();
        streamSpy.mockRestore();
      }
    }, 30_000);

    it('pages distinct ranges of a very large anchored committed turn without rescanning the turn', async () => {
      // 1,500 committed rows make full-turn rescans distinguishable from page-sized reads.
      const completedTimer: PersistedChatMessage = {
        ...message(1499, 'system'),
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 1499 }],
      };
      const committed = [
        message(0, 'user'),
        ...Array.from({ length: 1498 }, (_, index) => message(index + 1)),
        completedTimer,
        message(1500, 'user'),
        message(1501),
      ];
      const card = delegatedCard('logical-large-committed-turn-run');
      const firstChild = row('logical-large-committed-first', 'first', card.id);
      const nestedChild = row(
        'logical-large-committed-nested',
        'nested',
        card.id,
      );
      const active = [nestedChild, card, firstChild];
      const anchors = new Map<string, ActiveRowAnchor>([
        [card.id, anchor(card.id, 'm-750', 0)],
        [firstChild.id, anchor(card.id, card.id, 0)],
        [nestedChild.id, anchor(card.id, firstChild.id, 0)],
      ]);
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);

      // Build committed and turn indexes before warming pages and counting reads.
      await log.page('chat-1');
      await log.page('chat-1', undefined, { view: 'turns' });
      const descriptor = await log.descriptor('chat-1');
      const oracle = await logicalTranscriptOracle({
        committed,
        active,
        anchors,
        revision: descriptor.transcriptRevision,
      });
      const cardOrdinal = oracle.messageOrdinals[card.id];
      const owner = oracle.turns.find(
        (turn) => turn.start <= cardOrdinal && cardOrdinal < turn.end,
      );
      if (!owner) throw new Error('Expected a completed large owner turn');
      expect(owner.complete).toBe(true);
      expect(owner.end - owner.start).toBeGreaterThan(1500);

      const ownerPage = await log.page('chat-1', owner.end, {
        view: 'turns',
        turnId: owner.id,
      });
      expect(ownerPage).toEqual(
        oracle.turnPage(owner.end, { turnId: owner.id }),
      );
      const firstOlderCursor = ownerPage.turns?.[0]?.before;
      if (firstOlderCursor === undefined)
        throw new Error('Expected the large owner turn to have an older page');
      const olderPage = await log.page('chat-1', firstOlderCursor, {
        view: 'turns',
        turnId: owner.id,
      });
      expect(olderPage).toEqual(
        oracle.turnPage(firstOlderCursor, { turnId: owner.id }),
      );
      const secondOlderCursor = olderPage.turns?.[0]?.before;
      if (secondOlderCursor === undefined)
        throw new Error('Expected another older owner-turn page');

      const jsonlPath = join(root, 'chat-1.jsonl');
      const affectedTurnBytes = committed
        .slice(0, 1500)
        .reduce(
          (total, entry) =>
            total + Buffer.byteLength(JSON.stringify(entry)) + 1,
          0,
        );
      const actualCreateReadStream = fs.createReadStream;
      let committedBytesRead = 0;
      const streamSpy = jest
        .spyOn(fs, 'createReadStream')
        .mockImplementation((...args) => {
          const stream = actualCreateReadStream(...args);
          if (String(args[0]) === jsonlPath)
            stream.on('data', (chunk) => {
              committedBytesRead += Buffer.isBuffer(chunk)
                ? chunk.byteLength
                : Buffer.byteLength(String(chunk));
            });
          return stream;
        });
      const readMeasuredPage = async (
        before: number,
      ): Promise<{
        page: Awaited<ReturnType<typeof log.page>>;
        bytes: number;
      }> => {
        committedBytesRead = 0;
        const page = await log.page('chat-1', before, {
          view: 'turns',
          turnId: owner.id,
        });
        return { page, bytes: committedBytesRead };
      };
      try {
        const warmTail = await readMeasuredPage(owner.end);
        expect(warmTail.page).toEqual(ownerPage);
        const warmMiddle = await readMeasuredPage(firstOlderCursor);
        expect(warmMiddle.page).toEqual(olderPage);
        expect(warmMiddle.page.messages).toEqual(
          expect.arrayContaining([card, firstChild, nestedChild]),
        );
        expect(warmMiddle.page.messages.length).toBeLessThan(1500);
        expect(warmMiddle.page.messageOrdinals?.[card.id]).toBe(cardOrdinal);
        expect(warmTail.bytes).toBeLessThan(affectedTurnBytes * 0.75);
        expect(warmMiddle.bytes).toBeLessThan(affectedTurnBytes * 0.75);
        expect(warmTail.bytes + warmMiddle.bytes).toBeLessThan(
          affectedTurnBytes * 1.5,
        );

        const repeatedTail = await readMeasuredPage(owner.end);
        expect(repeatedTail.page).toEqual(ownerPage);
        expect(repeatedTail.bytes).toBeLessThan(affectedTurnBytes * 0.75);
        expect(secondOlderCursor).toBeLessThan(firstOlderCursor);
      } finally {
        streamSpy.mockRestore();
      }
    }, 30_000);

    it('reuses warm committed reads across repeated logical queries and active content updates', async () => {
      const committed = Array.from({ length: 120 }, (_, id) =>
        id % 5 === 0 ? message(id, 'user') : message(id),
      );
      const card = delegatedCard('logical-warm-run');
      committed.splice(61, 0, card);
      const children = Array.from({ length: 24 }, (_, index) =>
        row(`logical-warm-child-${index}`, `warm child ${index}`, card.id),
      );
      const active = [...children].reverse();
      const anchors = new Map<string, ActiveRowAnchor>();
      children.forEach((child, index) => {
        anchors.set(child.id, anchor(card.id, card.id, index));
      });
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active, anchors);
      const readQueries = async (): Promise<void> => {
        await log.page('chat-1');
        await log.page('chat-1', undefined, { view: 'turns' });
        await log.descriptor('chat-1');
        await log.readRunMessages('chat-1', card.id);
      };
      await readQueries();

      const jsonlPath = join(root, 'chat-1.jsonl');
      const openFile = fsPromises.open;
      let committedOpens = 0;
      const openSpy = jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (path, flags, mode) => {
          if (path === jsonlPath) committedOpens += 1;
          return openFile(path, flags, mode);
        });
      const streamSpy = jest.spyOn(fs, 'createReadStream');
      const committedReads = (): number =>
        committedOpens +
        streamSpy.mock.calls.filter(([path]) => String(path) === jsonlPath)
          .length;
      try {
        await readQueries();
        const warmReadCount = committedReads();
        expect(warmReadCount).toBeLessThanOrEqual(4);
        await readQueries();
        expect(committedReads()).toBe(warmReadCount);

        const updatedFirst: PersistedChatMessage = {
          ...children[0],
          blocks: [{ type: 'text', text: 'warm content updated' }],
        };
        const updatedActive = active.map((entry) =>
          entry.id === updatedFirst.id ? updatedFirst : entry,
        );
        await log.writeActive('chat-1', updatedActive, anchors);
        committedOpens = 0;
        openSpy.mockClear();
        streamSpy.mockClear();
        await readQueries();
        expect(committedReads()).toBe(0);
        const runResult = await log.readRunMessages('chat-1', card.id);
        expect(runResult).toContainEqual(updatedFirst);
      } finally {
        openSpy.mockRestore();
        streamSpy.mockRestore();
      }
    });

    it('keeps anchor-free logical reads within the warmed physical-path work', async () => {
      const committed = [message(0, 'user'), message(1), message(2)];
      const active = [message(3, 'user'), message(4)];
      await log.append('chat-1', committed);
      await log.writeActive('chat-1', active);
      await log.page('chat-1');
      await log.page('chat-1', undefined, { view: 'turns' });
      await log.descriptor('chat-1');

      const jsonlPath = join(root, 'chat-1.jsonl');
      const activePath = join(root, 'chat-1.active.json');
      const openFile = fsPromises.open;
      const readFileOriginal = fsPromises.readFile;
      let openCalls = 0;
      let readFileCalls = 0;
      const openSpy = jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (path, flags, mode) => {
          openCalls += 1;
          return openFile(path, flags, mode);
        });
      const streamSpy = jest.spyOn(fs, 'createReadStream');
      const stringifySpy = jest.spyOn(JSON, 'stringify');
      const cloneSpy = jest.spyOn(globalThis, 'structuredClone');
      const readFileSpy = jest
        .spyOn(fsPromises, 'readFile')
        .mockImplementation(async (...args) => {
          readFileCalls += 1;
          return readFileOriginal(...args);
        });
      let runResult: unknown;
      const metrics = (): {
        files: number;
        serializations: number;
        clones: number;
      } => ({
        files:
          openCalls +
          readFileCalls +
          streamSpy.mock.calls.filter(
            ([path]) =>
              String(path) === jsonlPath || String(path) === activePath,
          ).length,
        serializations: stringifySpy.mock.calls.length,
        clones: cloneSpy.mock.calls.length,
      });
      const measure = async (
        operation: () => Promise<void>,
      ): Promise<ReturnType<typeof metrics>> => {
        openCalls = 0;
        readFileCalls = 0;
        openSpy.mockClear();
        streamSpy.mockClear();
        stringifySpy.mockClear();
        cloneSpy.mockClear();
        readFileSpy.mockClear();
        await operation();
        return metrics();
      };
      try {
        const physicalIteration = await measure(async () => {
          for await (const _entry of log.iterate('chat-1')) void _entry;
          await log.activeMessages('chat-1');
        });
        const logicalIteration = await measure(async () => {
          await logicalIteratorMessages(log, 'chat-1');
        });
        const ordinaryPages = async (): Promise<void> => {
          await log.page('chat-1');
          await log.page('chat-1', undefined, { view: 'turns' });
          await log.descriptor('chat-1');
        };
        const physicalQueries = await measure(ordinaryPages);
        const logicalQueries = await measure(async () => {
          await ordinaryPages();
        });
        expect(logicalIteration).toEqual(physicalIteration);
        expect(logicalQueries).toEqual(physicalQueries);
        runResult = await log.readRunMessages('chat-1', 'not-a-known-run');
      } finally {
        openSpy.mockRestore();
        streamSpy.mockRestore();
        stringifySpy.mockRestore();
        cloneSpy.mockRestore();
        readFileSpy.mockRestore();
      }
      expect(runResult).toEqual([]);
    });
  });
});

describe('transcript log seams for live delegate runs', () => {
  let root: string;
  let log: ChatTranscriptLog;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-log-seams-'));
    log = new ChatTranscriptLog(root);
    await log.initialize('chat-1');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    'prepared',
    'appended',
    'index-published',
    'survivors-published',
  ] as const)(
    'recovers an explicit-zero complete append with no anchors after %s',
    async (boundary) => {
      const card = delegatedCard('empty-suffix-run');
      const first = row('empty-suffix-first', 'first');
      const second = row('empty-suffix-second', 'second');
      const child = row('empty-suffix-child', 'child', card.id);
      const anchors = new Map<string, ActiveRowAnchor>([
        [child.id, anchor(card.id, first.id, 0)],
      ]);
      await log.append('chat-1', [card]);
      await log.writeActive('chat-1', [child, first, second], anchors);
      const payload = [first, child, second];
      const faulting = new ChatTranscriptLog(root, (at) =>
        at === boundary
          ? Promise.reject(new Error(`fault at ${boundary}`))
          : Promise.resolve(),
      );
      await expect(
        faulting.append('chat-1', payload, undefined, 0),
      ).rejects.toThrow(`fault at ${boundary}`);
      const recovered = new ChatTranscriptLog(root);
      expect((await recovered.page('chat-1')).messages).toEqual([
        card,
        ...payload,
      ]);
      expect(await recovered.activeMessages('chat-1')).toEqual([]);
      expect(await recovered.activeRowAnchors('chat-1')).toEqual(new Map());
      await recovered.append('chat-1', payload, undefined, 0);
      expect(
        (await new ChatTranscriptLog(root).page('chat-1')).messages,
      ).toEqual([card, ...payload]);
      await expect(
        stat(join(root, 'chat-1.active.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('requires an explicit-zero committed anchor predecessor to be committed or earlier in the payload', async () => {
    const card = delegatedCard('complete-predecessor-run');
    const first = row('complete-predecessor-first', 'first');
    const child = row('complete-predecessor-child', 'child', card.id);
    await log.append('chat-1', [card]);
    await log.writeActive(
      'chat-1',
      [child, first],
      new Map<string, ActiveRowAnchor>([
        [child.id, anchor(card.id, first.id, 0)],
      ]),
    );
    await expect(
      log.append('chat-1', [child, first], undefined, 0),
    ).rejects.toThrow('must be committed or earlier in append payload');
    expect(await log.activeMessages('chat-1')).toEqual([child, first]);
    await log.append('chat-1', [first, child], undefined, 0);
    expect(await log.activeMessages('chat-1')).toEqual([]);
  });

  it('allows a new ordinary row before existing ordinary rows in an explicit-zero complete append', async () => {
    const first = row('complete-first', 'first');
    const second = row('complete-second', 'second');
    const ready = row('complete-ready', 'new ready row');
    await log.writeActive('chat-1', [first, second]);
    await log.append('chat-1', [ready, first, second], undefined, 0);
    expect((await log.page('chat-1')).messages).toEqual([ready, first, second]);
    expect(await log.activeMessages('chat-1')).toEqual([]);
    expect(await log.activeRowAnchors('chat-1')).toEqual(new Map());
    await log.append('chat-1', [ready, first, second], undefined, 0);
    expect((await log.page('chat-1')).messages).toEqual([ready, first, second]);
  });

  it('reads a committed row with its contiguous direct-child group from its locator', async () => {
    const card = delegatedCard('seam-group-run');
    const first = row('seam-group-first', 'first', card.id);
    const second = row('seam-group-second', 'second', card.id);
    const unrelated = row('seam-group-unrelated', 'not a child');
    const late = row('seam-group-late', 'after the group', card.id);
    await log.append('chat-1', [
      message(0, 'user'),
      card,
      first,
      second,
      unrelated,
      late,
    ]);
    await log.writeActive('chat-1', [row('seam-group-active', 'active')]);

    expect(await log.readCommittedGroup('chat-1', card.id)).toEqual([
      card,
      first,
      second,
    ]);
    expect(await log.readCommittedGroup('chat-1', 'm-0')).toEqual([
      message(0, 'user'),
    ]);
    expect(
      await log.readCommittedGroup('chat-1', 'seam-group-active'),
    ).toBeUndefined();
    expect(await log.readCommittedGroup('chat-1', 'absent')).toBeUndefined();
  });

  it('lists only chats whose active sidecar holds anchors', async () => {
    const card = delegatedCard('seam-anchored-run');
    const child = row('seam-anchored-child', 'child', card.id);
    await log.append('chat-1', [message(0, 'user'), card]);
    await log.writeActive(
      'chat-1',
      [child],
      new Map<string, ActiveRowAnchor>([
        [child.id, anchor(card.id, card.id, 0)],
      ]),
    );
    await log.initialize('chat-2');
    await log.writeActive('chat-2', [row('seam-plain', 'plain active row')]);
    await log.initialize('chat-3');

    expect(await log.anchoredChatIds()).toEqual(['chat-1']);
    await log.writeActive('chat-1', [child], new Map());
    expect(await new ChatTranscriptLog(root).anchoredChatIds()).toEqual([
      'chat-1',
    ]);
  });

  it('reports the last committed row id without counting active rows', async () => {
    expect(await log.lastCommittedMessageId('chat-1')).toBeUndefined();

    await log.append('chat-1', [message(0, 'user'), message(1)]);
    await log.writeActive('chat-1', [row('seam-last-active', 'active')]);
    expect(await log.lastCommittedMessageId('chat-1')).toBe('m-1');

    await log.replace('chat-1', [message(0, 'user')], 3);
    expect(
      await new ChatTranscriptLog(root).lastCommittedMessageId('chat-1'),
    ).toBe('m-0');
  });
});

describe('isDelegationChildRow', () => {
  const row = {
    id: 'delegated-agent-d:item',
    role: 'assistant',
    timestamp: 1,
    parentBlockId: 'delegated-agent-d',
    delegationSequence: 0,
    blocks: [{ type: 'text', text: 'hello' }],
    itemRevision: 0,
    final: false,
  };

  it('accepts a child row with its native segment', () => {
    expect(isDelegationChildRow({ ...row, delegationSegment: 'turn-1' })).toBe(
      true,
    );
    expect(isDelegationChildRow(row)).toBe(true);
  });

  it.each([[''], [7], [null]])(
    'rejects a native segment of %p',
    (delegationSegment) => {
      expect(isDelegationChildRow({ ...row, delegationSegment })).toBe(false);
    },
  );
});
