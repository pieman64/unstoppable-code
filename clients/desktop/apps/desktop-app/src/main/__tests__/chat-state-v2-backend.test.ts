import { searchTranscriptMessages } from '../lib/chat-transcript-search';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatArtifactMaintenance,
  ArtifactMaintenanceCapacityError,
  CountingArtifactReferenceFilter,
} from '../lib/chat-artifact-maintenance';
import * as directorySync from '../lib/fsync-directory';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  ChatStateV2Backend,
  ChatTranscriptNotLoadedError,
} from '../services/chat-state-v2-backend';
import type {
  ProviderVisualAdmission,
  StagedVisual,
  VisualStagingSidecar,
  VisualStagingStore,
} from '../lib/chat-visual-contracts';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

const message = (id: string, text = id): PersistedChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  blocks: [{ type: 'text', text }],
});

const VISUAL_ID = 'vis_123e4567-e89b-42d3-a456-426614174000';
const VISUAL_HTML = '<!doctype html><title>Visual</title>';

function stagedVisualFixture(
  chatId = 'chat',
  visualId = VISUAL_ID,
  html = VISUAL_HTML,
): StagedVisual {
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  const sidecar: VisualStagingSidecar = {
    version: 1,
    visualId,
    chatId,
    toolKey: 'show_visual',
    createdAt: 1,
    sha256,
    byteLength: Buffer.byteLength(html, 'utf8'),
    title: 'Visual',
    maxHeight: 400,
  };
  return { sidecar, html };
}

function visualAdmission(
  candidate: StagedVisual,
  readStaged: (
    chatId: string,
    visualId: string,
  ) => Promise<StagedVisual | undefined> = (
    chatId: string,
    visualId: string,
  ): Promise<StagedVisual | undefined> =>
    Promise.resolve(
      chatId === candidate.sidecar.chatId &&
        visualId === candidate.sidecar.visualId
        ? candidate
        : undefined,
    ),
): ProviderVisualAdmission {
  const staging: VisualStagingStore = {
    initialize: (): Promise<void> => Promise.resolve(),
    hasEntries: (): boolean => true,
    stagedIds: (): ReadonlySet<string> => new Set([candidate.sidecar.visualId]),
    stage: (): Promise<VisualStagingSidecar> =>
      Promise.resolve(candidate.sidecar),
    readCandidate: readStaged,
    remove: (): Promise<void> => Promise.resolve(),
    removeChat: (): Promise<void> => Promise.resolve(),
    sweep: (): Promise<{ removed: number; remaining: number }> =>
      Promise.resolve({ removed: 0, remaining: 1 }),
  };
  return {
    staging,
    resolveToolKey: (call) =>
      call.toolName === 'ShowVisual' ? 'show_visual' : undefined,
    now: (): number => 10_000,
  };
}

function visualToolMessages(
  resultMessageId: string,
  toolUseId: string,
  output = `Rendering ${VISUAL_ID}`,
): PersistedChatMessage[] {
  return [
    {
      ...message(`${resultMessageId}-call`),
      blocks: [
        {
          type: 'tool_use',
          toolUseId,
          toolName: 'ShowVisual',
          input: '{}',
        },
      ],
    },
    {
      ...message(resultMessageId),
      blocks: [
        {
          type: 'tool_result',
          toolUseId,
          toolName: 'ShowVisual',
          output,
          isError: false,
        },
      ],
    },
  ];
}

function visualReferenceFrom(
  message: PersistedChatMessage | undefined,
): PersistedVisualReference | undefined {
  const block = message?.blocks.find(
    (candidate) => candidate.type === 'tool_result' && candidate.visualRef,
  );
  return block?.type === 'tool_result' ? block.visualRef : undefined;
}

function asAsync<T>(source: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = source[Symbol.iterator]();
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}
// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('canonical transcript match counts', () => {
  it('counts literal case-insensitive occurrences in old rows without returning bodies', async () => {
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield { ...message('turn'), role: 'user' };
      yield message('old', 'Needle.* and needle.*');
      for (let i = 0; i < 1001; i++) yield message(`filler-${i}`);
      yield { ...message('later'), role: 'user' };
      yield message('last', 'NEEDLE.*');
    };
    expect(await searchTranscriptMessages(rows(), 'needle.*')).toEqual({
      totalCount: 3,
      matches: [
        { messageId: 'old', turnId: 'turn', count: 2 },
        { messageId: 'last', turnId: 'later', count: 1 },
      ],
    });
  });
  it('finds text rendered from system messages', async () => {
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield { ...message('turn'), role: 'user' };
      yield {
        ...message('system-notice', 'Authentication expired for this session.'),
        role: 'system',
      };
    };
    expect(await searchTranscriptMessages(rows(), 'authentication')).toEqual({
      totalCount: 1,
      matches: [{ messageId: 'system-notice', turnId: 'turn', count: 1 }],
    });
  });
  it('does not return matches from transcript rows hidden by sanitization', async () => {
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield { ...message('turn', 'visible needle'), role: 'user' };
      yield {
        ...message(
          'local-command',
          '<command-name>/needle</command-name><command-message>needle</command-message>',
        ),
        role: 'user',
      };
      yield message('synthetic', 'No response requested.');
    };
    expect(await searchTranscriptMessages(rows(), 'needle')).toEqual({
      totalCount: 1,
      matches: [{ messageId: 'turn', turnId: 'turn', count: 1 }],
    });
    expect(
      await searchTranscriptMessages(rows(), 'response requested'),
    ).toEqual({ totalCount: 0, matches: [] });
  });
  it('stops consuming rows when a superseded query is cancelled', async () => {
    const controller = new AbortController();
    let consumed = 0;
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      while (consumed < 1000) {
        consumed++;
        if (consumed === 3) controller.abort();
        yield message(`m${consumed}`, 'needle');
      }
    };
    await expect(
      searchTranscriptMessages(rows(), 'needle', controller.signal),
    ).rejects.toThrow();
    expect(consumed).toBe(3);
  });
  it('folds case like the renderer highlighter so counts agree with the DOM', async () => {
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield { ...message('turn'), role: 'user' };
      // "i̇stanbul" is what lowercasing "İstanbul" yields; a case-insensitive
      // RegExp never equates the two, so neither may the transcript matcher.
      yield message('dotted', 'i̇stanbul');
      // U+212A KELVIN SIGN lowercases to "k" but is not case-insensitively
      // equal to "k" under RegExp canonicalization.
      yield message('kelvin', 'Kelvin');
      yield message('plain', 'İstanbul and Kelvin');
    };
    expect(await searchTranscriptMessages(rows(), 'İstanbul')).toEqual({
      totalCount: 1,
      matches: [{ messageId: 'plain', turnId: 'turn', count: 1 }],
    });
    expect(await searchTranscriptMessages(rows(), 'kelvin')).toEqual({
      totalCount: 1,
      matches: [{ messageId: 'plain', turnId: 'turn', count: 1 }],
    });
  });
  it('emits same-owner groups in transcript order so per-element offsets accumulate', async () => {
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield { ...message('turn'), role: 'user' };
      yield {
        ...message('assistant'),
        blocks: [
          { type: 'text', text: 'Reading the file' },
          {
            type: 'tool_use',
            toolUseId: 'read',
            toolName: 'Read',
            input: '{}',
          },
        ],
      };
      yield {
        ...message('result'),
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'read',
            toolName: 'Read',
            output: 'file one\nfile two',
            isError: false,
          },
        ],
      };
    };
    expect(await searchTranscriptMessages(rows(), 'file')).toEqual({
      totalCount: 3,
      matches: [
        { messageId: 'assistant', turnId: 'turn', count: 1 },
        {
          messageId: 'result',
          turnId: 'turn',
          renderMessageId: 'assistant',
          count: 2,
        },
      ],
    });
  });
  it('keeps mixed text and results attached to their separate rendered messages', async () => {
    const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield { ...message('turn'), role: 'user' };
      for (const id of ['call-a', 'call-b'])
        yield {
          ...message(id),
          blocks: [
            { type: 'tool_use', toolUseId: id, toolName: 'Read', input: '{}' },
          ],
        };
      yield {
        ...message('mixed'),
        blocks: [
          { type: 'text', text: 'needle in prose' },
          ...['call-a', 'call-b'].map((id) => ({
            type: 'tool_result' as const,
            toolUseId: id,
            toolName: 'Read',
            output: 'needle in output',
            isError: false,
          })),
        ],
      };
    };
    expect(await searchTranscriptMessages(rows(), 'needle')).toEqual({
      totalCount: 3,
      matches: [
        { messageId: 'mixed', turnId: 'turn', count: 1 },
        {
          messageId: 'mixed',
          turnId: 'turn',
          renderMessageId: 'call-a',
          count: 1,
        },
        {
          messageId: 'mixed',
          turnId: 'turn',
          renderMessageId: 'call-b',
          count: 1,
        },
      ],
    });
  });
});

describe('index-owned chat state', () => {
  let root: string;
  let store: ChatStorageV2;
  let backend: ChatStateV2Backend;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-v2-backend-'));
    store = new ChatStorageV2(root, 'scope');
    await store.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'chat', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          for (const id of ['chat', 'sibling'])
            yield await Promise.resolve({
              metadata: { id, title: id, createdAt: '2026-09-05' },
              messages:
                (async function* (): AsyncGenerator<PersistedChatMessage> {
                  for (let i = 0; i < (id === 'chat' ? 510 : 1); i++)
                    yield await Promise.resolve(message(`m${i}`));
                })(),
            });
        })(),
      }),
    );
    backend = new ChatStateV2Backend(store);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.disposeArtifactMaintenance();
    await rm(root, { recursive: true, force: true });
  });

  it('counts the mutations each commit carries and the index clones around it', async () => {
    await backend.load();
    resetWorkCounters();

    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: message('n1') },
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
      ],
      { source: 'automation' },
    );
    // A transaction that produces no mutations never commits.
    await backend.transact(() => [], { source: 'automation' });

    expect(snapshotWorkCounters().chatStorage).toMatchObject({
      commits: 1,
      mutations: 2,
      // Committed: the build view and the result view. The recovery metadata
      // and the transaction's prepared and returned indexes are shared
      // copy-on-write, not cloned. Empty: only its build view.
      indexClones: 3,
    });
  });

  it('skips catalog enumeration for active-only maintenance hints', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
      ],
      { source: 'automation' },
    );
    const indexes = await backend.load();
    const catalogMap = jest.spyOn(indexes.archive.archived, 'map');
    expect(await backend.pendingArtifactMaintenanceChats(['chat'])).toEqual([]);
    expect(catalogMap).not.toHaveBeenCalled();
  });

  it('does not rebuild missing locators for an artifactless cold cleanup', async () => {
    const locators = join(
      store.directory,
      'transcripts',
      'message-index',
      'chat',
    );
    await rm(locators, { recursive: true, force: true });
    await rm(join(store.directory, 'transcripts', 'tool-output', 'chat'), {
      recursive: true,
      force: true,
    });
    const cold = new ChatStateV2Backend(new ChatStorageV2(root, 'scope'));
    await cold.load();
    const streams = jest.spyOn(fs, 'createReadStream');
    try {
      expect(await cold.maintainArtifacts('chat', 64 * 1024)).toMatchObject({
        complete: true,
        scannedBytes: 0,
        removed: 0,
      });
      expect(
        streams.mock.calls.filter(([path]) =>
          String(path).endsWith('chat.jsonl'),
        ),
      ).toHaveLength(0);
      await expect(readdir(locators)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cold.disposeArtifactMaintenance();
    }
  });

  it('bounds a cold artifact scan without rebuilding missing locators', async () => {
    const largeRoot = join(root, 'cold-large');
    const largeStore = new ChatStorageV2(largeRoot, 'scope');
    await largeStore.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'large', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: asAsync<ChatMigrationEntry>([
          {
            metadata: {
              id: 'large',
              title: 'Large',
              createdAt: '2026-09-05',
            },
            messages: asAsync(
              (function* (): Generator<PersistedChatMessage> {
                yield {
                  ...message('tool'),
                  blocks: [
                    {
                      type: 'tool_result',
                      toolUseId: 'tool',
                      toolName: 'Read',
                      output: 'retained output '.repeat(8000),
                      isError: false,
                    },
                  ],
                };
                for (let i = 0; i < 300; i++)
                  yield message(`large-${i}`, 'payload '.repeat(600));
              })(),
            ),
          },
        ]),
      }),
    );
    const locators = join(
      largeStore.directory,
      'transcripts',
      'message-index',
      'large',
    );
    const artifacts = join(
      largeStore.directory,
      'transcripts',
      'tool-output',
      'large',
    );
    const referenced = (await readdir(artifacts)).filter((name) =>
      name.endsWith('.txt'),
    );
    expect(referenced).toHaveLength(1);
    const orphan = `sha256-v1-${createHash('sha256').update('orphan').digest('hex')}.txt`;
    await writeFile(join(artifacts, orphan), 'orphan');
    await rm(locators, { recursive: true, force: true });
    const cold = new ChatStateV2Backend(new ChatStorageV2(largeRoot, 'scope'));
    await cold.load();
    const streams = jest.spyOn(fs, 'createReadStream');
    try {
      let progress = await cold.maintainArtifacts('large', 64 * 1024);
      const jsonlStreams = streams.mock.calls.flatMap(([path], index) => {
        const stream: unknown = streams.mock.results[index]?.value;
        return String(path).endsWith('large.jsonl') &&
          stream instanceof fs.ReadStream
          ? [stream]
          : [];
      });
      expect(jsonlStreams).toHaveLength(1);
      expect(
        jsonlStreams.reduce((bytes, stream) => bytes + stream.bytesRead, 0),
      ).toBeLessThan(256 * 1024);
      await expect(readdir(locators)).rejects.toMatchObject({ code: 'ENOENT' });
      for (let i = 0; i < 100 && !progress.complete; i++)
        progress = await cold.maintainArtifacts('large', 64 * 1024);
      expect(progress.complete).toBe(true);
      expect(await readdir(artifacts)).toContain(referenced[0]);
      expect(await readdir(artifacts)).not.toContain(orphan);
    } finally {
      await cold.disposeArtifactMaintenance();
    }
  }, 30_000);

  it.each(['oversized', 'canonical descriptor mismatch'])(
    'defers cleanup with an %s sparse index without reclaiming candidates',
    async (caseName) => {
      const candidate = `sha256-v1-${createHash('sha256').update('cold-orphan').digest('hex')}.txt`;
      const artifactDirectory = join(
        store.directory,
        'transcripts',
        'tool-output',
        'chat',
      );
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(join(artifactDirectory, candidate), 'orphan');
      const cold = new ChatStateV2Backend(new ChatStorageV2(root, 'scope'));
      await cold.load();
      const indexPath = join(store.directory, 'transcripts', 'chat.index.json');
      if (caseName === 'oversized') {
        await writeFile(indexPath, Buffer.alloc(1024 * 1024 + 1, 32));
      } else {
        const index: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
        if (!index || typeof index !== 'object' || Array.isArray(index))
          throw new Error('Expected sparse transcript index object');
        Reflect.deleteProperty(index, 'checksum');
        Reflect.set(index, 'committedDigest', 'f'.repeat(64));
        await writeFile(
          indexPath,
          JSON.stringify({
            ...index,
            checksum: createHash('sha256')
              .update(JSON.stringify(index))
              .digest('hex'),
          }),
        );
      }
      try {
        let failure: unknown;
        try {
          let progress = await cold.maintainArtifacts('chat', 64 * 1024);
          for (let i = 0; i < 10 && !progress.complete; i++)
            progress = await cold.maintainArtifacts('chat', 64 * 1024);
        } catch (error) {
          failure = error;
        }
        expect(await readdir(artifactDirectory)).toContain(candidate);
        expect(failure).toBeInstanceOf(Error);
        if (failure instanceof Error)
          expect(failure.message).toMatch(
            caseName === 'oversized'
              ? /index exceeds/i
              : /descriptor mismatch/i,
          );
      } finally {
        await cold.disposeArtifactMaintenance();
      }
    },
  );

  it('keeps counting-filter membership conservative through collisions and saturation', () => {
    const filter = new CountingArtifactReferenceFilter();
    const first = `sha256-v1-${'0'.repeat(63)}1`;
    const colliding = `sha256-v1-${'0'.repeat(63)}2`;
    filter.add(first);
    filter.add(colliding);
    filter.remove(first);
    expect(filter.maybeHas(colliding)).toBe(true);
    filter.remove(colliding);
    expect(filter.maybeHas(colliding)).toBe(false);

    const shared = new CountingArtifactReferenceFilter();
    const sharedId = `sha256-v1-${createHash('sha256').update('shared').digest('hex')}`;
    shared.add(sharedId);
    shared.add(sharedId);
    shared.remove(sharedId);
    expect(shared.maybeHas(sharedId)).toBe(true);
    shared.remove(sharedId);
    expect(shared.maybeHas(sharedId)).toBe(false);

    const oracle = new Map<string, number>();
    const ids = Array.from(
      { length: 1000 },
      (_, index) =>
        `sha256-v1-${createHash('sha256').update(String(index)).digest('hex')}`,
    );
    for (let cycle = 0; cycle < 4; cycle++)
      for (const id of ids) {
        filter.add(id);
        oracle.set(id, (oracle.get(id) ?? 0) + 1);
      }
    for (let cycle = 0; cycle < 3; cycle++)
      for (const id of ids) {
        filter.remove(id);
        oracle.set(id, (oracle.get(id) ?? 0) - 1);
      }
    for (const [id, count] of Array.from(oracle))
      if (count > 0) expect(filter.maybeHas(id)).toBe(true);

    const saturated = new CountingArtifactReferenceFilter();
    for (let i = 0; i < 300; i++) saturated.add(first);
    for (let i = 0; i < 300; i++) saturated.remove(first);
    expect(saturated.maybeHas(first)).toBe(true);
    expect(() => new CountingArtifactReferenceFilter().remove(first)).toThrow(
      'underflow',
    );
  });

  it('publishes the durable tool preview and reference rather than the raw oversized output', async () => {
    const output = 'lossless output '.repeat(10000);
    const commit = await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...message('large-result'),
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'tool',
                toolName: 'Read',
                output,
                isError: false,
              },
            ],
          },
        },
      ],
      { source: 'automation' },
    );
    const mutation = commit.record.mutations[0];
    if (mutation.type !== 'message.upserted')
      throw new Error('Missing message delta');
    const block = mutation.message.blocks[0];
    if (block.type !== 'tool_result') throw new Error('Missing result');
    expect(block.fullOutputRef).toBeDefined();
    expect(Buffer.byteLength(block.output)).toBeLessThanOrEqual(65536);
    expect(block.output).not.toBe(output);
    expect((await backend.page('chat')).messages.slice(-1)[0]).toEqual(
      mutation.message,
    );
  });

  it('commits one fence when two result blocks echo the same staged visual', async () => {
    const candidate = stagedVisualFixture();
    const admission = visualAdmission(candidate);
    const [call, result] = visualToolMessages('visual-result', 'tool-a');
    const resultBlock = result.blocks[0];
    if (resultBlock.type !== 'tool_result') throw new Error('Missing result');
    const echoed = {
      ...result,
      blocks: [resultBlock, { ...resultBlock, output: `Again ${VISUAL_ID}` }],
    };

    const commit = await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: echoed },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );

    const stored = commit.record.mutations.find(
      (mutation) =>
        mutation.type === 'message.upserted' &&
        mutation.message.id === 'visual-result',
    );
    if (stored?.type !== 'message.upserted')
      throw new Error('Missing stored visual result');
    const refs = stored.message.blocks.flatMap((block) =>
      block.type === 'tool_result' && block.visualRef ? [block.visualRef] : [],
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual(refs[1]);
    expect(commit.promotedVisuals).toHaveLength(1);
    expect(
      (await backend.load()).recovery.visualOwnersByChatId?.chat?.[VISUAL_ID],
    ).toMatchObject({ messageId: 'visual-result', toolUseId: 'tool-a' });
  });

  it('reads verified raw visual byte ranges and rejects missing or damaged artifacts', async () => {
    const html = `🌲${'x'.repeat(1_048_579)}é`;
    const candidate = stagedVisualFixture('chat', VISUAL_ID, html);
    const [call, result] = visualToolMessages('visual-read', 'visual-tool');
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: result },
      ],
      { source: 'provider', chatIds: ['chat'] },
      visualAdmission(candidate),
    );
    const page = await backend.page('chat');
    const reference = visualReferenceFrom(
      page.messages.find((item) => item.id === 'visual-read'),
    );
    if (!reference) throw new Error('Missing visual reference');
    const bytes = Buffer.from(html, 'utf8');
    const slices: Uint8Array[] = [];
    let offset = 0;
    for (const limit of [1, 3, 1_048_576, 16]) {
      const read = await backend.visual(
        'chat',
        'visual-read',
        'visual-tool',
        reference,
        offset,
        limit,
      );
      slices.push(read.bytes);
      offset += read.length;
      if (offset === bytes.length) break;
    }
    expect(Buffer.concat(slices)).toEqual(bytes);
    const end = await backend.visual(
      'chat',
      'visual-read',
      'visual-tool',
      reference,
      bytes.length,
      1,
    );
    expect(end.length).toBe(0);
    expect(end.bytes).toHaveLength(0);
    await expect(
      backend.visual('chat', 'visual-read', 'wrong-tool', reference, 0, 1),
    ).rejects.toMatchObject({ reason: 'not_found' });
    await expect(
      backend.visual('sibling', 'visual-read', 'visual-tool', reference, 0, 1),
    ).rejects.toMatchObject({ reason: 'not_found' });
    const artifactPath = join(
      store.directory,
      'transcripts',
      'visuals',
      'chat',
      `${reference.artifactId}.html`,
    );
    await writeFile(artifactPath, 'broken');
    await expect(
      backend.visual('chat', 'visual-read', 'visual-tool', reference, 0, 1),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
    await rm(artifactPath);
    await expect(
      backend.visual('chat', 'visual-read', 'visual-tool', reference, 0, 1),
    ).rejects.toMatchObject({ reason: 'not_found' });
    // An I/O failure is not an integrity failure; it keeps its own error.
    const ioError = Object.assign(
      new Error(`EIO: i/o error, read '${artifactPath}'`),
      { code: 'EIO' },
    );
    jest
      .spyOn(backend.storage.transcripts.artifacts, 'readVisualRange')
      .mockRejectedValueOnce(ioError);
    await expect(
      backend.visual('chat', 'visual-read', 'visual-tool', reference, 0, 1),
    ).rejects.toBe(ioError);
  });

  it('does not read staging when copied tab rows contain a visual token', async () => {
    const candidate = stagedVisualFixture();
    const readCandidate = jest.fn(
      (chatId: string, visualId: string): Promise<StagedVisual | undefined> =>
        Promise.resolve(
          chatId === candidate.sidecar.chatId &&
            visualId === candidate.sidecar.visualId
            ? candidate
            : undefined,
        ),
    );
    const admission = visualAdmission(candidate, readCandidate);
    const [call, result] = visualToolMessages('copied-result', 'copied-tool');
    const current = await backend.state({ chatIds: ['chat'] });
    const sourceTab = current.tabsFile.tabs[0];
    if (!sourceTab) throw new Error('Missing source tab');

    await backend.transact(
      () => [
        {
          type: 'tab.created',
          tab: { ...sourceTab, id: 'copied-chat', messages: [call, result] },
        },
      ],
      { source: 'automation', chatIds: ['copied-chat'] },
      admission,
    );

    expect(readCandidate).not.toHaveBeenCalled();
    const copied = await backend.state({ chatIds: ['copied-chat'] });
    const copiedTab = copied.tabsFile.tabs.find(
      (tab) => tab.id === 'copied-chat',
    );
    if (!copiedTab) throw new Error('Missing copied chat');
    expect(visualReferenceFrom(copiedTab.messages[1])).toBeUndefined();
  });

  it('keeps a claimed visual fenced across turns and a backend restart', async () => {
    const candidate = stagedVisualFixture();
    const readCandidate = jest.fn(
      (chatId: string, visualId: string): Promise<StagedVisual | undefined> =>
        Promise.resolve(
          chatId === candidate.sidecar.chatId &&
            visualId === candidate.sidecar.visualId
            ? candidate
            : undefined,
        ),
    );
    const admission = visualAdmission(candidate, readCandidate);
    const [firstCall, firstResult] = visualToolMessages(
      'visual-owner',
      'first-tool',
    );
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: firstCall },
        { type: 'message.upserted', chatId: 'chat', message: firstResult },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );
    const [competingCall, competingResult] = visualToolMessages(
      'competing-result',
      'competing-tool',
    );
    const competing = await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: competingCall },
        { type: 'message.upserted', chatId: 'chat', message: competingResult },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );
    const competingProjection = competing.record.mutations.find(
      (mutation) =>
        mutation.type === 'message.upserted' &&
        mutation.message.id === 'competing-result',
    );
    expect(
      visualReferenceFrom(
        competingProjection?.type === 'message.upserted'
          ? competingProjection.message
          : undefined,
      ),
    ).toBeUndefined();
    await backend.transact(
      () => [
        { type: 'message.removed', chatId: 'chat', messageId: 'visual-owner' },
      ],
      { source: 'provider', chatIds: ['chat'] },
    );
    await backend.disposeArtifactMaintenance();
    backend = new ChatStateV2Backend(new ChatStorageV2(root, 'scope'));

    const [secondCall, secondResult] = visualToolMessages(
      'later-result',
      'third-tool',
    );
    const later = await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: secondCall },
        { type: 'message.upserted', chatId: 'chat', message: secondResult },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );
    const projected = later.record.mutations.find(
      (mutation) =>
        mutation.type === 'message.upserted' &&
        mutation.message.id === 'later-result',
    );

    expect(
      visualReferenceFrom(
        projected?.type === 'message.upserted' ? projected.message : undefined,
      ),
    ).toBeUndefined();
    expect(readCandidate).toHaveBeenCalledTimes(1);
    expect(
      (await backend.load()).recovery.visualOwnersByChatId?.chat?.[VISUAL_ID],
    ).toMatchObject({ messageId: 'visual-owner', toolUseId: 'first-tool' });
  });

  it('prunes expired fences only when an admission can check staged ids', async () => {
    const candidate = stagedVisualFixture();
    const [call, result] = visualToolMessages('expired-owner', 'expired-tool');
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: result },
      ],
      { source: 'provider', chatIds: ['chat'] },
      visualAdmission(candidate),
    );
    const persisted = await backend.load();
    const owners = persisted.recovery.visualOwnersByChatId?.chat;
    if (!owners?.[VISUAL_ID]) throw new Error('Missing visual owner fence');
    owners[VISUAL_ID].claimedAt = 0;
    persisted.live.revision += 1;
    persisted.archive.revision = persisted.live.revision;
    await backend.storage.commit(1, persisted, []);
    backend.releaseJournal();

    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );
    expect(
      (await backend.load()).recovery.visualOwnersByChatId?.chat?.[VISUAL_ID],
    ).toBeDefined();

    const admission = visualAdmission(candidate);
    admission.staging.stagedIds = (): ReadonlySet<string> => new Set();
    admission.now = (): number => 1_000_000_000;
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );

    expect(
      (await backend.load()).recovery.visualOwnersByChatId?.chat,
    ).toBeUndefined();
  });

  it('keeps a visual when a result is re-reported outside the loaded window', async () => {
    const candidate = stagedVisualFixture();
    const admission = visualAdmission(candidate, () =>
      Promise.resolve(candidate),
    );
    const [call, result] = visualToolMessages('visual-result', 'visual-tool');
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: result },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );
    const promoted = visualReferenceFrom(
      (
        await backend.state({ chatIds: ['chat'], fullTranscript: true })
      ).tabsFile.tabs[0]?.messages.find(
        (message) => message.id === 'visual-result',
      ),
    );
    if (!promoted) throw new Error('Visual was not promoted');

    // The chat is not loaded, so the view holds none of its rows.
    const [, rereported] = visualToolMessages('visual-result', 'visual-tool');
    await backend.transact(
      () => [{ type: 'message.upserted', chatId: 'chat', message: rereported }],
      { source: 'provider' },
    );

    const refreshed = await backend.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(
      visualReferenceFrom(
        refreshed.tabsFile.tabs[0]?.messages.find(
          (message) => message.id === 'visual-result',
        ),
      ),
    ).toEqual(promoted);
  });

  it('keeps a visual when an archive rewrite carries a result outside the loaded window', async () => {
    const candidate = stagedVisualFixture();
    const admission = visualAdmission(candidate, () =>
      Promise.resolve(candidate),
    );
    const [call, result] = visualToolMessages('visual-result', 'visual-tool');
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: result },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );
    await backend.transact(
      (current) => {
        const tab = current.tabsFile.tabs.find((entry) => entry.id === 'chat');
        if (!tab) throw new Error('Missing chat tab');
        return [
          { type: 'tab.removed', tabId: 'chat' },
          {
            type: 'archive.upserted',
            entry: { tab, archivedAt: '2026-10-07', turnCount: 1 },
          },
        ];
      },
      { source: 'provider', chatIds: ['chat'], fullTranscript: true },
    );
    const archived = (
      await backend.state({ chatIds: ['chat'], fullTranscript: true })
    ).archivesFile.archived[0];
    if (!archived) throw new Error('Missing archived chat');
    const promoted = visualReferenceFrom(
      archived.tab.messages.find((message) => message.id === 'visual-result'),
    );
    if (!promoted) throw new Error('Visual was not promoted');

    // The rewrite rebuilds the rows, and the chat is not loaded.
    const rebuilt = visualToolMessages('visual-result', 'visual-tool');
    await backend.transact(
      () => [
        {
          type: 'archive.upserted',
          entry: {
            ...archived,
            tab: {
              ...archived.tab,
              messages: archived.tab.messages.map(
                (message) =>
                  rebuilt.find((row) => row.id === message.id) ?? message,
              ),
            },
          },
        },
      ],
      { source: 'provider' },
    );

    const refreshed = await backend.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(
      visualReferenceFrom(
        refreshed.archivesFile.archived[0]?.tab.messages.find(
          (message) => message.id === 'visual-result',
        ),
      ),
    ).toEqual(promoted);
  });

  it('preserves a visual on an archived re-report and drops the fence on permanent removal', async () => {
    const candidate = stagedVisualFixture();
    const readCandidate = jest.fn(
      (chatId: string, visualId: string): Promise<StagedVisual | undefined> =>
        Promise.resolve(
          chatId === candidate.sidecar.chatId &&
            visualId === candidate.sidecar.visualId
            ? candidate
            : undefined,
        ),
    );
    const admission = visualAdmission(candidate, readCandidate);
    const [call, result] = visualToolMessages('visual-result', 'visual-tool');
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: result },
      ],
      { source: 'provider', chatIds: ['chat'] },
      admission,
    );
    await backend.transact(
      (current) => {
        const tab = current.tabsFile.tabs.find((entry) => entry.id === 'chat');
        if (!tab) throw new Error('Missing chat tab');
        return [
          { type: 'tab.removed', tabId: 'chat' },
          {
            type: 'archive.upserted',
            entry: { tab, archivedAt: '2026-10-07', turnCount: 1 },
          },
        ];
      },
      { source: 'provider', chatIds: ['chat'], fullTranscript: true },
    );
    await backend.disposeArtifactMaintenance();
    backend = new ChatStateV2Backend(new ChatStorageV2(root, 'scope'));
    const archivedState = await backend.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const archive = archivedState.archivesFile.archived[0];
    if (!archive) throw new Error('Missing archived chat');
    const rebuiltMessages = visualToolMessages('visual-result', 'visual-tool');
    const rebuilt = await backend.transact(
      () => [
        {
          type: 'archive.upserted',
          entry: {
            ...archive,
            tab: {
              ...archive.tab,
              messages: archive.tab.messages.map(
                (message) =>
                  rebuiltMessages.find(
                    (candidateMessage) => candidateMessage.id === message.id,
                  ) ?? message,
              ),
            },
          },
        },
      ],
      { source: 'provider', chatIds: ['chat'], fullTranscript: true },
      admission,
    );
    const refreshed = await backend.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const refreshedResult =
      refreshed.archivesFile.archived[0]?.tab.messages.find(
        (message) => message.id === 'visual-result',
      );

    expect(visualReferenceFrom(refreshedResult)?.visualId).toBe(VISUAL_ID);
    expect(rebuilt.promotedVisuals).toBeUndefined();
    expect(readCandidate).toHaveBeenCalledTimes(1);
    await backend.transact(
      () => [
        {
          type: 'archive.removed',
          archiveEntryId: 'chat',
          chatId: 'chat',
        },
      ],
      { source: 'provider', chatIds: ['chat'] },
    );
    expect(
      (await backend.load()).recovery.visualOwnersByChatId,
    ).toBeUndefined();
  });

  it('preserves owner fences when a malformed ledger disables admission', async () => {
    const indexes = await backend.storage.load();
    Reflect.set(indexes.recovery, 'visualOwnersByChatId', {
      chat: { broken: true },
    });
    indexes.live.revision = indexes.archive.revision = 1;
    await backend.storage.commit(0, indexes, []);
    const report = jest.fn();
    await backend.disposeArtifactMaintenance();
    backend = new ChatStateV2Backend(store, {
      onVisualOwnerLedgerInvalid: report,
    });
    await backend.load();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      reason: 'malformed_visual_owner_ledger',
    });
    backend.releaseJournal();
    await backend.load();
    expect(report).toHaveBeenCalledTimes(2);

    const candidate = stagedVisualFixture();
    const readCandidate = jest.fn(
      (chatId: string, visualId: string): Promise<StagedVisual | undefined> =>
        Promise.resolve(
          chatId === candidate.sidecar.chatId &&
            visualId === candidate.sidecar.visualId
            ? candidate
            : undefined,
        ),
    );
    const [call, result] = visualToolMessages('blocked-result', 'blocked-tool');
    const commit = await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: call },
        { type: 'message.upserted', chatId: 'chat', message: result },
      ],
      { source: 'provider', chatIds: ['chat'] },
      visualAdmission(candidate, readCandidate),
    );
    const projected = commit.record.mutations.find(
      (mutation) =>
        mutation.type === 'message.upserted' &&
        mutation.message.id === 'blocked-result',
    );
    expect(
      visualReferenceFrom(
        projected?.type === 'message.upserted' ? projected.message : undefined,
      ),
    ).toBeUndefined();
    expect(readCandidate).not.toHaveBeenCalled();
    expect(
      Reflect.get((await backend.load()).recovery, 'visualOwnersByChatId'),
    ).toEqual({ chat: { broken: true } });
  });

  it('omits the visual owner ledger when no claim has occurred', async () => {
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: message('plain') },
      ],
      { source: 'provider', chatIds: ['chat'] },
    );

    expect(
      Object.prototype.hasOwnProperty.call(
        (await backend.load()).recovery,
        'visualOwnersByChatId',
      ),
    ).toBe(false);
  });

  it('publishes the committed transcript digest on the index descriptor', async () => {
    const before = (await backend.state()).tabsFile.tabs[0].transcript;
    expect(before?.committedDigest).toMatch(/^[a-f0-9]{64}$/);
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: message('next') },
      ],
      { source: 'automation' },
    );
    const after = (await backend.state()).tabsFile.tabs[0].transcript;
    expect(after?.committedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(after?.committedDigest).not.toBe(before?.committedDigest);
  });

  it('reclaims artifacts externalized for a transaction that fails before publication', async () => {
    const output = 'reclaimed output 🌲\n'.repeat(9000);
    const artifactDirectory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    const upsert = (): ReturnType<ChatStateV2Backend['transact']> =>
      backend.transact(
        () => [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: {
              ...message('large-result'),
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'tool',
                  toolName: 'Read',
                  output,
                  isError: false,
                },
              ],
            },
          },
        ],
        { source: 'automation' },
      );
    const syncDirectory = directorySync.fsyncDirectory;
    const sync = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (directory.includes(join('pending-transcripts', '')))
          throw new Error('payload directory sync failed');
        await syncDirectory(directory);
      });
    await expect(upsert()).rejects.toThrow('payload directory sync failed');
    expect(await readdir(artifactDirectory)).toEqual([]);
    expect((await backend.load()).live.revision).toBe(0);
    sync.mockRestore();
    await expect(upsert()).resolves.toMatchObject({ applied: true });
    expect(await readdir(artifactDirectory)).toHaveLength(1);
    const last = (await backend.page('chat')).messages.slice(-1)[0];
    const block = last.blocks[0];
    if (block.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing artifact reference');
    await backend.storage.transcripts.artifacts.verify(
      'chat',
      block.fullOutputRef,
    );
  });

  it('does not persist a visual owner fence when publication fails', async () => {
    const candidate = stagedVisualFixture();
    const readCandidate = jest.fn(
      (chatId: string, visualId: string): Promise<StagedVisual | undefined> =>
        Promise.resolve(
          chatId === candidate.sidecar.chatId &&
            visualId === candidate.sidecar.visualId
            ? candidate
            : undefined,
        ),
    );
    const admission = visualAdmission(candidate, readCandidate);
    const [call, result] = visualToolMessages('failed-visual', 'failed-tool');
    const visualDirectory = join(
      store.directory,
      'transcripts',
      'visuals',
      'chat',
    );
    const syncDirectory = directorySync.fsyncDirectory;
    const sync = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (directory.includes(join('pending-transcripts', '')))
          throw new Error('transcript payload sync failed');
        await syncDirectory(directory);
      });

    await expect(
      backend.transact(
        () => [
          { type: 'message.upserted', chatId: 'chat', message: call },
          { type: 'message.upserted', chatId: 'chat', message: result },
        ],
        { source: 'provider', chatIds: ['chat'] },
        admission,
      ),
    ).rejects.toThrow('transcript payload sync failed');

    expect(readCandidate).toHaveBeenCalledTimes(1);
    expect(
      (await new ChatStateV2Backend(new ChatStorageV2(root, 'scope')).load())
        .recovery.visualOwnersByChatId,
    ).toBeUndefined();
    expect(await readdir(visualDirectory)).toEqual([]);
    sync.mockRestore();
  });

  it('rejects an imported transcript with an oversized JSONL row', async () => {
    const source = new ChatStorageV2(root, 'import-source');
    await source.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'imported', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          await Promise.resolve();
          yield {
            metadata: {
              id: 'imported',
              title: 'Imported',
              createdAt: '2026-09-05',
            },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                await Promise.resolve();
                yield message('imported');
              })(),
          };
        })(),
      }),
    );
    const metadata = await new ChatStateV2Backend(source).state();
    const oversized = message('imported', 'x'.repeat(16 * 1024 * 1024));
    await writeFile(
      join(source.directory, 'transcripts', 'imported.jsonl'),
      JSON.stringify(oversized) + '\n',
    );
    await expect(
      backend.importScope(
        source,
        {
          tabsFile: metadata.tabsFile,
          archivesFile: metadata.archivesFile,
        },
        { merge: true },
      ),
    ).rejects.toThrow('Transcript row exceeds maximum size');
  });

  it('reclaims copied tool artifacts when an import fails before publication', async () => {
    const source = new ChatStorageV2(root, 'artifact-import-source');
    await source.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'imported', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          await Promise.resolve();
          yield {
            metadata: {
              id: 'imported',
              title: 'Imported',
              createdAt: '2026-09-05',
            },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                await Promise.resolve();
                yield {
                  ...message('large-result'),
                  blocks: [
                    {
                      type: 'tool_result',
                      toolUseId: 'tool',
                      toolName: 'Read',
                      output: 'copied output '.repeat(10_000),
                      isError: false,
                    },
                  ],
                };
              })(),
          };
        })(),
      }),
    );
    const sourceBackend = new ChatStateV2Backend(source);
    const metadata = await sourceBackend.state();

    await expect(
      backend.importScope(
        source,
        {
          tabsFile: metadata.tabsFile,
          archivesFile: metadata.archivesFile,
        },
        { merge: true, throughMessageIds: { imported: 'missing-anchor' } },
      ),
    ).rejects.toThrow('Canonical branch message anchor was not found');
    await expect(
      readdir(join(store.directory, 'transcripts', 'tool-output', 'imported')),
    ).resolves.toEqual([]);
    expect((await backend.state()).tabsFile.tabs).toHaveLength(2);
  });

  it('does not perform a fallible artifact write after the durable commit', async () => {
    const artifacts = backend.storage.transcripts.artifacts;
    const originalPut = artifacts.put.bind(artifacts);
    const put = jest.spyOn(artifacts, 'put').mockImplementation((...args) => {
      if (put.mock.calls.length > 1)
        return Promise.reject(new Error('post-commit artifact write'));
      return originalPut(...args);
    });

    await expect(
      backend.transact(
        () => [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: {
              ...message('large-result'),
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'tool',
                  toolName: 'Read',
                  output: 'lossless output '.repeat(10000),
                  isError: false,
                },
              ],
            },
          },
        ],
        { source: 'automation' },
      ),
    ).resolves.toMatchObject({ applied: true, revision: 1 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('reclaims an unreferenced superseded tool output during bounded maintenance after its active turn settles', async () => {
    const firstOutput = 'old output 🌲\n'.repeat(8000);
    const finalOutput = 'final output 🌲\n'.repeat(9000);
    const toolMessage = (output: string): PersistedChatMessage => ({
      ...message('changing-tool'),
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'Read',
          output,
          isError: false,
        },
      ],
    });
    const artifactName = (output: string): string =>
      `sha256-v1-${createHash('sha256').update(output).digest('hex')}.txt`;
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage(firstOutput),
        },
      ],
      { source: 'automation' },
    );
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage(finalOutput),
        },
      ],
      { source: 'automation' },
    );
    expect((await readdir(directory)).sort()).toEqual(
      [artifactName(firstOutput), artifactName(finalOutput)].sort(),
    );

    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'automation' },
    );

    // The unchanged backend has no maintenance hook; its retained artifact is
    // the baseline red. A candidate may complete small maintenance in the
    // commit or expose bounded chunks without making the durable ack wait for
    // a whole-history reachability scan.
    const maintain = Reflect.get(backend, 'maintainArtifacts');
    if (typeof maintain === 'function') {
      for (let i = 0; i < 16; i++) {
        const progress: unknown = await Reflect.apply(maintain, backend, [
          'chat',
          64 * 1024,
        ]);
        if (
          typeof progress === 'object' &&
          progress !== null &&
          Reflect.get(progress, 'complete') === true
        )
          break;
      }
    }

    expect(await readdir(directory)).toEqual([artifactName(finalOutput)]);
    const output = await new ChatStateV2Backend(store).consumeTranscript(
      'chat',
      true,
      async (messages) => {
        let last: PersistedChatMessage | undefined;
        for await (const row of messages) last = row;
        return last;
      },
    );
    expect(output?.blocks[0]).toEqual(toolMessage(finalOutput).blocks[0]);
  });

  it('yields across a large active sidecar and retains its referenced output', async () => {
    const oldOutput = 'obsolete active output\n'.repeat(9000);
    const finalOutput = 'retained active output\n'.repeat(9000);
    const toolMessage = (output: string): PersistedChatMessage => ({
      ...message('active-result'),
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'Read',
          output,
          isError: false,
        },
      ],
    });
    const artifactName = (output: string): string =>
      `sha256-v1-${createHash('sha256').update(output).digest('hex')}.txt`;
    await backend.load();
    const transcript = backend.storage.transcripts;
    await transcript.writeActive('chat', [toolMessage(oldOutput)]);
    await transcript.replaceActive('chat', [
      toolMessage(finalOutput),
      ...Array.from({ length: 300 }, (_, index) =>
        message(`active-${index}`, 'x'.repeat(1024)),
      ),
    ]);
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    expect((await readdir(directory)).sort()).toEqual(
      [artifactName(oldOutput), artifactName(finalOutput)].sort(),
    );
    const largestActiveRowBytes = Math.max(
      ...String(
        await readFile(
          join(store.directory, 'transcripts', 'chat.active.json'),
        ),
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => Buffer.byteLength(line, 'utf8') + 1),
    );

    const journal = join(store.directory, 'metadata-journal.jsonl');
    await writeFile(journal, 'pending replay\n');
    await expect(backend.maintainArtifacts('chat')).rejects.toThrow(
      'replay is pending',
    );
    expect((await readdir(directory)).sort()).toEqual(
      [artifactName(oldOutput), artifactName(finalOutput)].sort(),
    );
    await writeFile(journal, '');

    const first = await backend.maintainArtifacts('chat', 64 * 1024);
    expect(first.complete).toBe(false);
    expect(first.scannedBytes).toBeLessThanOrEqual(
      64 * 1024 + largestActiveRowBytes,
    );
    expect((await transcript.activeMessages('chat')).length).toBe(301);
    let progress = first;
    let slices = 1;
    while (!progress.complete && slices < 32) {
      progress = await backend.maintainArtifacts('chat', 64 * 1024);
      expect(progress.scannedBytes).toBeLessThanOrEqual(
        64 * 1024 + largestActiveRowBytes,
      );
      slices += 1;
    }
    expect(progress.complete).toBe(true);
    expect(slices).toBeGreaterThan(2);
    expect(await readdir(directory)).toEqual([artifactName(finalOutput)]);
  }, 30_000);

  it('caps cross-scope maintenance hints and defers a ninth pinned scan', async () => {
    let releaseIdentity: (() => void) | undefined;
    const identityGate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockImplementation(async () => {
        await identityGate;
        return 'unchanged';
      });
    const maintainers = Array.from(
      { length: 9 },
      (_, index) =>
        new ChatArtifactMaintenance(backend.storage, `${root}/scope-${index}`),
    );
    const scans = maintainers
      .slice(0, 8)
      .map((maintenance) => maintenance.maintain('chat', 64 * 1024));
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (maintainers[0].stats().inFlight === 8) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(maintainers[0].stats()).toMatchObject({ chats: 8, inFlight: 8 });
      await expect(
        maintainers[8].maintain('chat', 64 * 1024),
      ).rejects.toBeInstanceOf(ArtifactMaintenanceCapacityError);
      expect(maintainers[0].stats().chats).toBe(8);
    } finally {
      releaseIdentity?.();
      await Promise.all(scans);
      expect(maintainers[0].stats().chargedReferenceBytes).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('wakes one capacity waiter for each slot that frees', async () => {
    const gates: Array<(clear: boolean) => void> = [];
    jest.spyOn(backend.storage, 'journalIsClear').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          gates.push(resolve);
        }),
    );
    const maintainers = Array.from(
      { length: 12 },
      (_, index) =>
        new ChatArtifactMaintenance(backend.storage, `${root}/wake-${index}`),
    );
    const scans = maintainers
      .slice(0, 8)
      .map((maintenance) =>
        maintenance.maintain('chat', 64 * 1024).catch(() => undefined),
      );
    const settle = async (milliseconds = 0): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const woken: number[] = [];
    const stopWaiting: Array<() => void> = [];
    try {
      for (let attempt = 0; attempt < 200 && gates.length < 8; attempt++)
        await settle(5);
      expect(gates).toHaveLength(8);
      maintainers.slice(8).forEach((maintenance, index) => {
        stopWaiting.push(
          maintenance.onCapacityAvailable(() => {
            woken.push(index);
            // Waiter 2 leaves its slot unused; the others take theirs.
            if (index !== 2)
              scans.push(
                maintenance.maintain('chat', 64 * 1024).catch(() => undefined),
              );
          }),
        );
      });
      await settle();
      expect(woken).toEqual([]);

      // A scan deferred by pending replay frees one slot: one waiter wakes.
      gates.shift()?.(false);
      await settle();
      expect(woken).toEqual([0]);
      gates.shift()?.(false);
      await settle();
      expect(woken).toEqual([0, 1]);
      gates.shift()?.(false);
      await settle();
      expect(woken).toEqual([0, 1, 2]);

      // The slot waiter 2 left unused does not strand waiter 3.
      await settle(200);
      expect(woken).toEqual([0, 1, 2, 3]);
    } finally {
      for (const stop of stopWaiting) stop();
      for (const open of gates.splice(0)) open(false);
      await Promise.all(scans);
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('does not offer a slot a woken waiter has not taken yet to another waiter', async () => {
    const gates: Array<(clear: boolean) => void> = [];
    jest.spyOn(backend.storage, 'journalIsClear').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          gates.push(resolve);
        }),
    );
    const maintainers = Array.from(
      { length: 12 },
      (_, index) =>
        new ChatArtifactMaintenance(backend.storage, `${root}/defer-${index}`),
    );
    const scans = maintainers
      .slice(0, 8)
      .map((maintenance) =>
        maintenance.maintain('chat', 64 * 1024).catch(() => undefined),
      );
    const settle = async (milliseconds = 0): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const woken: number[] = [];
    const stopWaiting: Array<() => void> = [];
    try {
      for (let attempt = 0; attempt < 200 && gates.length < 8; attempt++)
        await settle(5);
      expect(gates).toHaveLength(8);
      maintainers.slice(8).forEach((maintenance, index) => {
        stopWaiting.push(
          maintenance.onCapacityAvailable(() => {
            woken.push(index);
            // Like the repository, start the woken work on a later turn.
            setImmediate(() => {
              scans.push(
                maintenance.maintain('chat', 64 * 1024).catch(() => undefined),
              );
            });
          }),
        );
      });
      await settle();

      // Two slots free before either woken waiter starts: two wake, not three.
      gates.shift()?.(false);
      await Promise.resolve();
      gates.shift()?.(false);
      await settle();
      await settle(200);
      expect(woken).toEqual([0, 1]);
    } finally {
      for (const stop of stopWaiting) stop();
      for (const open of gates.splice(0)) open(false);
      await Promise.all(scans);
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('charges partial reference scans to the global hint budget', async () => {
    const candidate = `sha256-v1-${'b'.repeat(64)}`;
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${candidate}.txt`), 'orphan');
    const artifactIds = [
      candidate,
      ...Array.from(
        { length: 5000 },
        (_, index) => `sha256-v1-${index.toString(16).padStart(64, '0')}`,
      ),
    ];
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('stable');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockResolvedValue({
        identity: 'committed',
        nextOffset: 1,
        complete: false,
        scannedBytes: 64 * 1024,
        artifactIds,
      });
    const maintainers = Array.from(
      { length: 8 },
      (_, index) =>
        new ChatArtifactMaintenance(
          backend.storage,
          `${root}/partial-${index}`,
        ),
    );
    try {
      for (const maintenance of maintainers)
        expect((await maintenance.maintain('chat', 64 * 1024)).complete).toBe(
          false,
        );
      expect(maintainers[0].stats()).toMatchObject({ chats: 8, inFlight: 0 });
      expect(maintainers[0].stats().chargedReferenceBytes).toBe(
        4 * 1024 * 1024,
      );
    } finally {
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('finishes nine interleaved multi-slice cleanups without restarting partial scans', async () => {
    const chatIds = Array.from({ length: 9 }, (_, index) => `fair-${index}`);
    for (const chatId of chatIds) {
      const directory = join(
        store.directory,
        'transcripts',
        'tool-output',
        chatId,
      );
      await mkdir(directory, { recursive: true });
      const id = `sha256-v1-${createHash('sha256').update(chatId).digest('hex')}`;
      await writeFile(join(directory, `${id}.txt`), 'orphan');
    }
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    const committed = jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockImplementation((_chatId, offset) =>
        Promise.resolve({
          identity: 'committed',
          nextOffset: offset + 1,
          complete: offset >= 2,
          scannedBytes: 1,
          artifactIds: [],
        }),
      );
    jest
      .spyOn(backend.storage.transcripts, 'artifactActiveReferenceSlice')
      .mockResolvedValue({
        identity: 'absent',
        nextOffset: 0,
        complete: true,
        scannedBytes: 0,
        artifactIds: [],
      });
    const maintenance = new ChatArtifactMaintenance(
      backend.storage,
      `${root}/fair-interleaving`,
    );
    const finished = new Set<string>();
    try {
      for (let round = 0; round < 8 && finished.size < chatIds.length; round++)
        for (const chatId of chatIds) {
          if (finished.has(chatId)) continue;
          try {
            if ((await maintenance.maintain(chatId, 64 * 1024)).complete)
              finished.add(chatId);
          } catch (error) {
            if (!(error instanceof ArtifactMaintenanceCapacityError))
              throw error;
          }
          expect(maintenance.stats().chats).toBeLessThanOrEqual(8);
          expect(maintenance.stats().chargedReferenceBytes).toBeLessThanOrEqual(
            4 * 1024 * 1024,
          );
        }
      expect(finished.size).toBe(chatIds.length);
      expect(committed).toHaveBeenCalledTimes(27);
      for (const chatId of chatIds)
        expect(
          await readdir(
            join(store.directory, 'transcripts', 'tool-output', chatId),
          ),
        ).toEqual([]);
    } finally {
      await maintenance.dispose();
    }
  }, 30_000);

  it('releases reserved scans after pending replay and early I/O failure', async () => {
    const candidate = `sha256-v1-${'e'.repeat(64)}`;
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${candidate}.txt`), 'orphan');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockResolvedValue({
        identity: 'committed',
        nextOffset: 1,
        complete: false,
        scannedBytes: 1,
        artifactIds: [],
      });
    const maintainers = Array.from(
      { length: 10 },
      (_, index) =>
        new ChatArtifactMaintenance(
          backend.storage,
          `${root}/early-failure-${index}`,
        ),
    );
    try {
      for (const maintenance of maintainers.slice(0, 8))
        expect((await maintenance.maintain('chat', 64 * 1024)).complete).toBe(
          false,
        );
      await expect(
        maintainers[8].maintain('chat', 64 * 1024),
      ).rejects.toBeInstanceOf(ArtifactMaintenanceCapacityError);
      const journal = jest.spyOn(backend.storage, 'journalIsClear');
      journal.mockResolvedValueOnce(false);
      await expect(maintainers[0].maintain('chat', 64 * 1024)).rejects.toThrow(
        'replay is pending',
      );
      journal.mockRestore();
      expect((await maintainers[8].maintain('chat', 64 * 1024)).complete).toBe(
        false,
      );
      const io = jest.spyOn(backend.storage, 'journalIsClear');
      io.mockRejectedValueOnce(
        Object.assign(new Error('read EIO'), { code: 'EIO' }),
      );
      await expect(maintainers[1].maintain('chat', 64 * 1024)).rejects.toThrow(
        'read EIO',
      );
      io.mockRestore();
      expect((await maintainers[9].maintain('chat', 64 * 1024)).complete).toBe(
        false,
      );
      expect(maintainers[0].stats().chats).toBeLessThanOrEqual(8);
      expect(maintainers[0].stats().chargedReferenceBytes).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
    } finally {
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('frees a reserved scan when its chat becomes ineligible', async () => {
    const candidate = `sha256-v1-${'f'.repeat(64)}`;
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${candidate}.txt`), 'orphan');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockResolvedValue({
        identity: 'committed',
        nextOffset: 1,
        complete: false,
        scannedBytes: 1,
        artifactIds: [],
      });
    const maintainers = Array.from(
      { length: 9 },
      (_, index) =>
        new ChatArtifactMaintenance(
          backend.storage,
          `${root}/ineligible-${index}`,
        ),
    );
    try {
      for (const maintenance of maintainers.slice(0, 8))
        await maintenance.maintain('chat', 64 * 1024);
      await expect(
        maintainers[8].maintain('chat', 64 * 1024),
      ).rejects.toBeInstanceOf(ArtifactMaintenanceCapacityError);
      await maintainers[0].abandon('chat');
      expect((await maintainers[8].maintain('chat', 64 * 1024)).complete).toBe(
        false,
      );
      expect(maintainers[0].stats().chats).toBeLessThanOrEqual(8);
    } finally {
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('tries another idle slot when an evicted directory cannot close', async () => {
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 65 }, async (_, index) => {
        const id = `sha256-v1-${createHash('sha256').update(String(index)).digest('hex')}`;
        await writeFile(join(directory, `${id}.txt`), 'orphan');
      }),
    );
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockRejectedValueOnce(new Error('scan EIO'));
    const artifacts = backend.storage.transcripts.artifacts;
    const originalOpen = artifacts.openCandidateDirectory.bind(artifacts);
    let failClose = true;
    let closeAttempts = 0;
    const opened = jest
      .spyOn(artifacts, 'openCandidateDirectory')
      .mockImplementation(async (chatId) => {
        const handle = await originalOpen(chatId);
        if (handle) {
          const close = handle.close.bind(handle);
          handle.close = async (): Promise<void> => {
            closeAttempts++;
            if (failClose) throw new Error('close EIO');
            await close();
          };
        }
        return handle;
      });
    const warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});
    const maintainers = Array.from(
      { length: 9 },
      (_, index) =>
        new ChatArtifactMaintenance(backend.storage, `${root}/close-${index}`),
    );
    try {
      await expect(maintainers[0].maintain('chat', 64 * 1024)).rejects.toThrow(
        'scan EIO',
      );
      // Probing for work takes no slot.
      expect(await maintainers[8].hasWork('chat')).toBe(true);
      expect(maintainers[0].stats().chats).toBe(1);
      // Invalidation does: fill the remaining idle slots, then need a ninth.
      for (const maintenance of maintainers.slice(1, 8))
        await maintenance.invalidate('chat');
      await maintainers[8].invalidate('chat');
      expect(closeAttempts).toBe(1);
      expect(maintainers[0].stats().chats).toBe(8);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      failClose = false;
      opened.mockRestore();
      warning.mockRestore();
      await Promise.all(
        maintainers.map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('pins a directory while disposal waits for its close', async () => {
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 65 }, async (_, index) => {
        const id = `sha256-v1-${createHash('sha256').update(String(index)).digest('hex')}`;
        await writeFile(join(directory, `${id}.txt`), 'orphan');
      }),
    );
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockRejectedValueOnce(new Error('scan EIO'));
    const artifacts = backend.storage.transcripts.artifacts;
    const originalOpen = artifacts.openCandidateDirectory.bind(artifacts);
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let holdClose = false;
    let closeAttempts = 0;
    const opened = jest
      .spyOn(artifacts, 'openCandidateDirectory')
      .mockImplementation(async (chatId) => {
        const handle = await originalOpen(chatId);
        if (handle) {
          const close = handle.close.bind(handle);
          handle.close = async (): Promise<void> => {
            closeAttempts++;
            if (holdClose) await closeGate;
            await close();
          };
        }
        return handle;
      });
    const maintainers = Array.from(
      { length: 9 },
      (_, index) =>
        new ChatArtifactMaintenance(
          backend.storage,
          `${root}/held-close-${index}`,
        ),
    );
    let disposing: Promise<void> | undefined;
    try {
      await expect(maintainers[0].maintain('chat', 64 * 1024)).rejects.toThrow(
        'scan EIO',
      );
      for (const maintenance of maintainers.slice(1, 8))
        await maintenance.hasWork('chat');
      holdClose = true;
      disposing = maintainers[0].dispose();
      let disposed = false;
      void disposing.then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(closeAttempts).toBe(1);
      expect(disposed).toBe(false);
      expect(await maintainers[8].hasWork('chat')).toBe(true);
      expect(closeAttempts).toBe(1);
    } finally {
      releaseClose?.();
      await disposing;
      opened.mockRestore();
      await Promise.all(
        maintainers.slice(1).map((maintenance) => maintenance.dispose()),
      );
    }
  }, 30_000);

  it('coalesces same-root disposal while an admitted maintenance slice is in flight', async () => {
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    const id = `sha256-v1-${createHash('sha256').update('orphan').digest('hex')}`;
    await writeFile(join(directory, `${id}.txt`), 'orphan');
    const artifacts = backend.storage.transcripts.artifacts;
    const originalOpen = artifacts.openCandidateDirectory.bind(artifacts);
    let enter = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(artifacts, 'openCandidateDirectory')
      .mockImplementation(async (chatId) => {
        const handle = await originalOpen(chatId);
        enter();
        await held;
        return handle;
      });
    const first = new ChatArtifactMaintenance(backend.storage, store.directory);
    const second = new ChatArtifactMaintenance(
      backend.storage,
      store.directory,
    );
    const slice = first.maintain('chat', 64 * 1024);
    try {
      await entered;
      // A recreated repository may already hold the same derived state.
      await second.hasWork('chat');
      const drains = Promise.allSettled([first.dispose(), second.dispose()]);
      release();
      await slice;
      expect(await drains).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(first.stats().inFlight).toBe(0);
    } finally {
      release();
      await Promise.allSettled([slice, first.dispose(), second.dispose()]);
    }
  }, 30_000);

  it('keeps artifacts when the canonical scan identity changes before unlink', async () => {
    const candidate = `sha256-v1-${'c'.repeat(64)}`;
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${candidate}.txt`), 'orphan');
    const identity = jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValueOnce('committed:absent')
      .mockResolvedValueOnce('committed:absent')
      .mockResolvedValue('changed:absent');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockResolvedValue({
        identity: 'committed',
        nextOffset: 1,
        complete: true,
        scannedBytes: 1,
        artifactIds: [],
      });
    jest
      .spyOn(backend.storage.transcripts, 'artifactActiveReferenceSlice')
      .mockResolvedValue({
        identity: 'absent',
        nextOffset: 0,
        complete: true,
        scannedBytes: 0,
        artifactIds: [],
      });
    const reclaim = jest.spyOn(
      backend.storage.transcripts.artifacts,
      'reclaimCandidates',
    );
    const maintenance = new ChatArtifactMaintenance(
      backend.storage,
      `${root}/identity`,
    );
    try {
      expect((await maintenance.maintain('chat', 64 * 1024)).complete).toBe(
        false,
      );
      expect((await maintenance.maintain('chat', 64 * 1024)).complete).toBe(
        false,
      );
      expect(identity).toHaveBeenCalledTimes(3);
      expect(reclaim).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([`${candidate}.txt`]);
      expect(await maintenance.identityIfCached('chat')).toBeUndefined();
    } finally {
      await maintenance.dispose();
    }
  }, 30_000);

  it('invalidates a derived reference hint after a canonical delta underflows', async () => {
    const candidate = `sha256-v1-${'d'.repeat(64)}`;
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${candidate}.txt`), 'orphan');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockResolvedValue({
        identity: 'committed',
        nextOffset: 1,
        complete: true,
        scannedBytes: 1,
        artifactIds: [],
      });
    jest
      .spyOn(backend.storage.transcripts, 'artifactActiveReferenceSlice')
      .mockResolvedValue({
        identity: 'absent',
        nextOffset: 0,
        complete: true,
        scannedBytes: 0,
        artifactIds: [],
      });
    const maintenance = new ChatArtifactMaintenance(
      backend.storage,
      `${root}/underflow`,
    );
    try {
      expect((await maintenance.maintain('chat', 64 * 1024)).complete).toBe(
        false,
      );
      expect((await maintenance.maintain('chat', 64 * 1024)).complete).toBe(
        true,
      );
      expect(await maintenance.identityIfCached('chat')).toBe(
        'committed:absent',
      );
      const oldActive: PersistedChatMessage = {
        ...message('old-active'),
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'old-call',
            toolName: 'Read',
            output: 'preview',
            isError: false,
            fullOutputRef: {
              version: 1,
              artifactId: candidate,
              sha256: 'd'.repeat(64),
              byteLength: 1,
              encoding: 'utf-8',
              mediaType: 'text/plain',
            },
          },
        ],
      };
      await maintenance.committed(
        'chat',
        { chatId: 'chat', kind: 'active', messages: [] },
        [oldActive],
        'committed:absent',
      );
      expect(await maintenance.identityIfCached('chat')).toBeUndefined();
      expect(await maintenance.hasWork('chat')).toBe(true);
    } finally {
      await maintenance.dispose();
    }
  }, 30_000);

  it('does not rescan a large referenced history for each orphan directory batch', async () => {
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await mkdir(directory, { recursive: true });
    const orphanIds = Array.from(
      { length: 130 },
      (_, index) =>
        `sha256-v1-${createHash('sha256')
          .update(String(index + 10_000))
          .digest('hex')}`,
    );
    await Promise.all(
      orphanIds.map((id) => writeFile(join(directory, `${id}.txt`), 'orphan')),
    );
    const referencedIds = Array.from(
      { length: 5000 },
      (_, index) =>
        `sha256-v1-${createHash('sha256').update(String(index)).digest('hex')}`,
    );
    // Begin the timer inside the accounting loop. Earlier filesystem awaits
    // must not satisfy this responsiveness assertion by accident.
    const originalAdd: unknown = Reflect.get(
      CountingArtifactReferenceFilter.prototype,
      'add',
    );
    if (typeof originalAdd !== 'function')
      throw new Error('Missing reference filter add method');
    let added = 0;
    let timerRan = false;
    let yieldedBeforeTail = false;
    jest
      .spyOn(CountingArtifactReferenceFilter.prototype, 'add')
      .mockImplementation(function (this: CountingArtifactReferenceFilter, id) {
        if (++added === 1) setImmediate(() => (timerRan = true));
        if (added === 1000) yieldedBeforeTail = timerRan;
        Reflect.apply(originalAdd, this, [id]);
      });
    jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceIdentity')
      .mockResolvedValue('committed:absent');
    const committed = jest
      .spyOn(backend.storage.transcripts, 'artifactReferenceSlice')
      .mockResolvedValue({
        identity: 'committed',
        nextOffset: 64 * 1024,
        complete: true,
        scannedBytes: 64 * 1024,
        artifactIds: referencedIds,
      });
    jest
      .spyOn(backend.storage.transcripts, 'artifactActiveReferenceSlice')
      .mockResolvedValue({
        identity: 'absent',
        nextOffset: 0,
        complete: true,
        scannedBytes: 0,
        artifactIds: [],
      });
    const removed: string[] = [];
    jest
      .spyOn(backend.storage.transcripts.artifacts, 'reclaimCandidates')
      .mockImplementation((_chatId, ids): Promise<void> => {
        removed.push(...ids);
        return Promise.resolve();
      });
    const maintenance = new ChatArtifactMaintenance(
      backend.storage,
      `${root}/large`,
    );
    try {
      let complete = false;
      for (let slice = 0; slice < 100 && !complete; slice++)
        complete = (await maintenance.maintain('chat', 64 * 1024)).complete;
      expect(complete).toBe(true);
      expect(removed.sort()).toEqual(orphanIds.sort());
      expect(committed).toHaveBeenCalledTimes(1);
      expect(yieldedBeforeTail).toBe(true);
    } finally {
      await maintenance.dispose();
    }
  }, 30_000);

  it('preserves a content-addressed artifact shared by another committed message', async () => {
    const sharedOutput = 'shared output 🌲\n'.repeat(8000);
    const replacementOutput = 'replacement output 🌲\n'.repeat(8000);
    const toolMessage = (id: string, output: string): PersistedChatMessage => ({
      ...message(id),
      blocks: [
        {
          type: 'tool_result',
          toolUseId: `${id}-call`,
          toolName: 'Read',
          output,
          isError: false,
        },
      ],
    });
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage('changing', sharedOutput),
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage('keeper', sharedOutput),
        },
      ],
      { source: 'automation' },
    );
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage('changing', replacementOutput),
        },
      ],
      { source: 'automation' },
    );
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'automation' },
    );
    const directory = join(
      store.directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    const artifactName = (output: string): string =>
      `sha256-v1-${createHash('sha256').update(output).digest('hex')}.txt`;
    const maintain = Reflect.get(backend, 'maintainArtifacts');
    if (typeof maintain === 'function')
      for (let i = 0; i < 16; i++) {
        const progress: unknown = await Reflect.apply(maintain, backend, [
          'chat',
          64 * 1024,
        ]);
        if (
          typeof progress === 'object' &&
          progress !== null &&
          Reflect.get(progress, 'complete') === true
        )
          break;
      }
    expect((await readdir(directory)).sort()).toEqual(
      [artifactName(sharedOutput), artifactName(replacementOutput)].sort(),
    );
  });

  it('keeps task state in the index when its source messages are outside the visible page', async () => {
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...message('m0'),
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'task',
                toolName: 'TaskCreate',
                input:
                  '{"subject":"Keep this task","description":"Earlier history"}',
              },
            ],
          },
        },
      ],
      { source: 'automation' },
    );
    const metadata = (await backend.state()).tabsFile.tabs[0];
    expect(metadata.transcript?.taskTodos).toEqual([
      expect.objectContaining({ content: 'Keep this task', status: 'pending' }),
    ]);
    expect(
      (await backend.page('chat')).messages.some((row) => row.id === 'm0'),
    ).toBe(false);
  });

  it('keeps unloaded history explicit and never reads a sibling body for metadata', async () => {
    await rm(join(store.directory, 'transcripts', 'sibling.jsonl'));
    const state = await backend.state({ chatIds: ['chat'] });
    expect(state.tabsFile.tabs[0].messages).toHaveLength(500);
    expect(() => state.tabsFile.tabs[1].messages).toThrow(
      ChatTranscriptNotLoadedError,
    );
    await backend.transact(
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'automation' },
    );
    expect((await backend.state()).tabsFile.tabs[0].unread).toBe(true);
  });

  it('updates a streaming suffix and settles complete rows without losing older pages', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('stream', 'hello'),
        },
      ],
      { source: 'automation' },
    );
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('stream', 'hello world'),
        },
      ],
      { source: 'automation' },
    );
    expect(
      (await backend.storage.transcripts.descriptor('chat'))
        .committedMessageCount,
    ).toBe(510);
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'automation' },
    );
    const all = (
      await new ChatStateV2Backend(store).state({
        chatIds: ['chat'],
        fullTranscript: true,
      })
    ).tabsFile.tabs[0].messages;
    expect(all).toHaveLength(511);
    expect(all[0]).toEqual(message('m0'));
    expect(all[510]).toEqual(message('stream', 'hello world'));
    expect((await store.indexes()).live.tabs[0]).not.toHaveProperty('messages');
  });

  it('commits an accepted user message while the chat is starting', async () => {
    const accepted: PersistedChatMessage = {
      id: 'accepted-user-message',
      role: 'user',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'Persist this before dispatch' }],
    };
    const mutableAssistant = message(
      'starting-assistant',
      'This projection can still change',
    );

    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'starting', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: accepted,
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: mutableAssistant,
        },
      ],
      { source: 'automation' },
    );

    expect(
      (await backend.storage.transcripts.descriptor('chat'))
        .committedMessageCount,
    ).toBe(511);
    expect(await backend.storage.transcripts.activeMessages('chat')).toEqual([
      mutableAssistant,
    ]);
    const page = await backend.page('chat');
    expect(page.messages[page.messages.length - 2]).toEqual(accepted);
    expect(page.messages[page.messages.length - 1]).toEqual(mutableAssistant);
  });

  it('patches an older committed message without dropping the mutable suffix or omitted history', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('stream'),
        },
      ],
      { source: 'automation' },
    );
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('m0', 'corrected'),
        },
      ],
      { source: 'automation' },
    );
    const all = (
      await backend.state({ chatIds: ['chat'], fullTranscript: true })
    ).tabsFile.tabs[0].messages;
    expect(all).toHaveLength(511);
    expect(all[0]).toEqual(message('m0', 'corrected'));
    expect(await backend.storage.transcripts.activeMessages('chat')).toEqual([
      message('stream'),
    ]);
  });

  it('finalizes the active suffix when moving a selected tab to archives', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('stream'),
        },
      ],
      { source: 'automation' },
    );
    await backend.transact(
      (current) => [
        { type: 'tab.removed', tabId: 'chat' },
        {
          type: 'archive.upserted',
          entry: {
            tab: current.tabsFile.tabs[0],
            archivedAt: '2026-09-05',
            turnCount: 511,
          },
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );
    expect(await backend.storage.transcripts.activeMessages('chat')).toEqual(
      [],
    );
    const archived = (
      await backend.state({ chatIds: ['chat'], fullTranscript: true })
    ).archivesFile.archived[0];
    expect(archived.tab.messages).toHaveLength(511);
    expect(archived.tab.messages[0]).toEqual(message('m0'));
  });

  it.each(['tab.created', 'archive.upserted'] as const)(
    'retains long-turn prompt, timer and summary in %s wire projections',
    async (type) => {
      const rows: PersistedChatMessage[] = [
        { ...message('prompt'), role: 'user' },
        {
          ...message('timer'),
          role: 'system',
          blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 20 }],
        },
        ...Array.from({ length: 1250 }, (_, i) => ({
          ...message(`tool-${i}`),
          role: 'system' as const,
          blocks: [
            {
              type: 'tool_use' as const,
              toolUseId: `tool-${i}`,
              toolName: 'Read',
              input: '{}',
            },
          ],
        })),
        {
          ...message('answer'),
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: 'Keep reviewing',
              asyncQuestionAnswer: {
                requestId: 'q',
                startsTurn: false,
                answers: [],
              },
            },
          ],
        },
        message('final', 'Finished'),
      ];
      const tab = {
        id: 'long-turn',
        title: 'Long turn',
        createdAt: '2026-09-18',
        messages: rows,
      };
      const commit = await backend.transact(
        () => [
          type === 'tab.created'
            ? { type, tab }
            : { type, entry: { tab, archivedAt: '2026-09-18', turnCount: 1 } },
        ],
        { source: 'automation' },
      );
      const mutation = commit.record.mutations[0];
      const projected =
        mutation.type === 'tab.created'
          ? mutation.tab
          : mutation.type === 'archive.upserted'
            ? mutation.entry.tab
            : undefined;
      expect(projected?.messages).toEqual(
        expect.arrayContaining([rows[0], rows[1]]),
      );
      expect(projected?.messages.length).toBeLessThan(1100);
      expect(projected?.transcriptWindow).toMatchObject({
        view: 'turns',
        turns: [
          {
            id: 'prompt',
            complete: true,
          },
        ],
      });
      expect(projected?.transcriptWindow?.turns?.[0].finalMessageIds).toContain(
        'final',
      );
    },
    120_000,
  );

  it('does not treat a paged tab upsert as a history replacement', async () => {
    await backend.transact(
      (current) => [
        {
          type: 'tab.created',
          tab: {
            ...current.tabsFile.tabs[0],
            title: 'renamed',
            messages: current.tabsFile.tabs[0].messages.slice(),
          },
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );
    expect(
      (await backend.state({ chatIds: ['chat'], fullTranscript: true }))
        .tabsFile.tabs[0].messages,
    ).toHaveLength(510);
  });

  it('does not let read projections mutate durable metadata without a commit', async () => {
    const indexes = await backend.load();
    indexes.live.tabs[0].title = 'not committed';
    const state = await backend.state();
    state.runtimeByChatId.chat = { status: 'streaming', queuedMessageIds: [] };
    expect((await backend.state()).tabsFile.tabs[0].title).toBe('chat');
    expect((await backend.state()).runtimeByChatId.chat).toBeUndefined();
  });

  it('does not reuse caller-mutated message projections for no-op or metadata transactions', async () => {
    const poison = (
      current: Awaited<ReturnType<ChatStateV2Backend['state']>>,
    ): void => {
      const block = current.tabsFile.tabs[0].messages.at(-1)?.blocks[0];
      if (block?.type !== 'text') throw new Error('Missing text projection');
      block.text = 'caller-mutated text';
    };

    const noOp = await backend.transact(
      (current) => {
        poison(current);
        return [];
      },
      { source: 'automation', chatIds: ['chat'] },
    );
    expect(noOp.applied).toBe(false);
    expect((await backend.page('chat')).messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'm509' },
    ]);

    const metadata = await backend.transact(
      (current) => {
        poison(current);
        return [
          {
            type: 'runtime.patched',
            chatId: 'chat',
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
        ];
      },
      { source: 'automation', chatIds: ['chat'] },
    );
    expect(metadata.applied).toBe(true);
    expect((await backend.page('chat')).messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'm509' },
    ]);
  });

  it('reads the selected active sidecar once while building a state view', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('active', 'latest active text'),
        },
      ],
      { source: 'automation' },
    );
    const open = jest.spyOn(fsPromises, 'open');

    const state = await backend.state({ chatIds: ['chat'] });
    expect(state.tabsFile.tabs[0].messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'latest active text' },
    ]);
    expect(
      open.mock.calls.filter(([path]) =>
        String(path).endsWith('chat.active.json'),
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  it('reuses a revision-bound active tail across one selected mutable update without sharing caller objects', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('active', 'first text'),
        },
      ],
      { source: 'automation' },
    );
    const open = jest.spyOn(fsPromises, 'open');

    const commit = await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('active', 'updated text'),
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );

    expect(
      open.mock.calls.filter(([path]) =>
        String(path).endsWith('chat.active.json'),
      ).length,
    ).toBeLessThanOrEqual(2);
    const active = commit.state.tabsFile.tabs[0].messages.at(-1);
    expect(active?.blocks).toEqual([{ type: 'text', text: 'updated text' }]);
    if (active?.blocks[0].type !== 'text')
      throw new Error('Missing active text');
    active.blocks[0].text = 'caller mutation';
    commit.state.tabsFile.tabs[0].messages.push(message('caller-only'));
    expect(
      (await backend.state({ chatIds: ['chat'] })).tabsFile.tabs[0].messages.at(
        -1,
      )?.blocks,
    ).toEqual([{ type: 'text', text: 'updated text' }]);
    await backend.transact(
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );
    expect(
      (
        await new ChatStateV2Backend(store).state({ chatIds: ['chat'] })
      ).tabsFile.tabs[0].messages.at(-1)?.blocks,
    ).toEqual([{ type: 'text', text: 'updated text' }]);
  });

  it('reuses the committed recent page across active-only revisions without sharing caller rows', async () => {
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('active', 'first text'),
        },
      ],
      { source: 'automation' },
    );
    const warm = await backend.state({ chatIds: ['chat'] });
    const first = warm.tabsFile.tabs[0].messages[0];
    expect(first.blocks).toEqual([{ type: 'text', text: 'm10' }]);
    if (first.blocks[0].type !== 'text')
      throw new Error('Missing committed text');
    first.blocks[0].text = 'caller mutation';
    const streams = jest.spyOn(fs, 'createReadStream');

    for (const text of ['second text', 'third text'])
      await backend.transact(
        () => [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('active', text),
          },
        ],
        { source: 'automation', chatIds: ['chat'] },
      );

    expect(
      streams.mock.calls.filter(([path]) => String(path).endsWith('chat.jsonl'))
        .length,
    ).toBeLessThanOrEqual(1);
    const selected = await backend.state({ chatIds: ['chat'] });
    expect(selected.tabsFile.tabs[0].messages[0].blocks).toEqual([
      { type: 'text', text: 'm10' },
    ]);
    expect(selected.tabsFile.tabs[0].messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'third text' },
    ]);
  });

  it('keeps the latest human frame and active reply in a page-only turn view', async () => {
    const pageStore = new ChatStorageV2(root, 'page-only-scope');
    await pageStore.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'page-chat', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          yield await Promise.resolve({
            metadata: {
              id: 'page-chat',
              title: 'Long turn',
              createdAt: '2026-09-05',
            },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                await Promise.resolve();
                yield { ...message('human', 'human prompt'), role: 'user' };
                for (let i = 0; i < 1200; i++) yield message(`history-${i}`);
              })(),
          });
        })(),
      }),
    );
    const pageBackend = new ChatStateV2Backend(pageStore);
    await pageBackend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'page-chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'page-chat',
          message: message('active', 'latest active reply'),
        },
      ],
      { source: 'automation' },
    );

    const state = await pageBackend.state({
      chatIds: ['page-chat'],
      pageOnly: true,
    });
    const tab = state.tabsFile.tabs[0];
    expect(tab.messages[0]?.id).toBe('human');
    expect(tab.messages.at(-1)?.id).toBe('active');
    expect(
      tab.transcriptWindow?.turns?.some((turn) => turn.id === 'human'),
    ).toBe(true);
    expect(tab.messages.length).toBeLessThan(1201);
  }, 120_000);

  it('rejects a fork whose artifact directory cannot be made durable, then retries with an independent artifact closure', async () => {
    const output = 'lossless fork 🌲\n'.repeat(9000);
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...message('tool'),
            blocks: [
              {
                type: 'tool_result',
                toolName: 'shell',
                toolUseId: 'call',
                output,
                isError: false,
              },
            ],
          },
        },
      ],
      { source: 'automation' },
    );
    const fork = (): ReturnType<ChatStateV2Backend['transact']> =>
      backend.transact(
        (current) => [
          {
            type: 'tab.created',
            transcriptSourceChatId: 'chat',
            tab: { ...current.tabsFile.tabs[0], id: 'fork', title: 'Fork' },
          },
        ],
        { source: 'automation', chatIds: ['chat'], fullTranscript: true },
      );
    const syncDirectory = directorySync.fsyncDirectory;
    const sync = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (directory.endsWith(join('transcripts', 'tool-output')))
          throw new Error('directory sync failed');
        await syncDirectory(directory);
      });
    await expect(fork()).rejects.toThrow('directory sync failed');
    expect((await backend.load()).live.tabs.map((tab) => tab.id)).toEqual([
      'chat',
      'sibling',
    ]);
    sync.mockRestore();
    await fork();
    await backend.transact(() => [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'automation',
    });
    const last = await backend.consumeTranscript(
      'fork',
      true,
      async (messages) => {
        let last: PersistedChatMessage | undefined;
        for await (const message of messages) last = message;
        return last;
      },
    );
    expect(last?.blocks[0]).toEqual({
      type: 'tool_result',
      toolName: 'shell',
      toolUseId: 'call',
      output,
      isError: false,
    });
  });

  it('requires explicit full-history intent for reset and retains receipt idempotency', async () => {
    const reset = (): ChatCoreMutation[] => [
      {
        type: 'messages.replaced' as const,
        chatId: 'chat',
        messages: [],
        removedMessageIds: ['m0'],
      },
    ];
    await expect(
      backend.transact(reset, { source: 'automation' }),
    ).rejects.toThrow('explicit full-transcript');
    await backend.transact(reset, {
      source: 'automation',
      fullTranscript: true,
      mutationId: 'reset',
      commandResult: { commandId: 'command', outcome: 'applied' },
    });
    const retried = await backend.transact(reset, {
      source: 'automation',
      mutationId: 'reset',
    });
    expect(retried.applied).toBe(false);
    expect((await backend.storage.transcripts.page('chat')).messages).toEqual(
      [],
    );
    expect((await backend.load()).recovery.removedMessageIds).toContain('m0');
    await backend.transact(
      (_state, _revision, context) => {
        expect(context.hasRemovedMessage('m0')).toBe(true);
        expect(context.hasRemovedMessage('m0', 'chat')).toBe(true);
        expect(context.hasRemovedMessage('m0', 'sibling')).toBe(false);
        return [];
      },
      { source: 'automation' },
    );
    const recovery: unknown = JSON.parse(
      await readFile(join(store.directory, 'recovery-index.json'), 'utf8'),
    );
    expect(recovery).toMatchObject({ receipts: [expect.anything()] });
  });
});
