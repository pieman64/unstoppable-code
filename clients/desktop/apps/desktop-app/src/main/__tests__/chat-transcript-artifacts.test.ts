import { projectAgentArtifacts } from '@canopy/desktop-shared/lib/agent-artifact-projection';
import * as crypto from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegatedAgentCallBlock,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import {
  ChatTranscriptArtifacts,
  CreatedArtifacts,
  type TranscriptFieldPolicy,
} from '../lib/chat-transcript-artifacts';
import { MAX_TRANSCRIPT_ROW_BYTES } from '../lib/chat-transcript-prefix-replace';
import type {
  ExternalizeVisualContext,
  LinkedToolCall,
  StagedVisual,
  VisualStagingSidecar,
  VisualOwnerFence,
} from '../lib/chat-visual-contracts';
import type { PersistedArtifactReference } from '@canopy/agent-transcript/lib/visual-ref';
import * as directorySync from '../lib/fsync-directory';
import { enforceWindowsFileSync } from './helpers/windows-file-sync';
import {
  TOOL_OUTPUT_INLINE_BYTES,
  transcriptBodyReferences,
} from '@canopy/agent-transcript/transcript-storage';
import { VISUAL_PREPARED_MAX_BYTES } from '@canopy/agent-transcript/lib/visual-ref';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
const visualId = 'vis_00000000-0000-0000-0000-000000000010';

function makeStagedVisual(html: string, codexCallId?: string): StagedVisual {
  const bytes = Buffer.from(html, 'utf8');
  const sidecar: VisualStagingSidecar = {
    version: 1,
    visualId,
    chatId: 'chat-1',
    toolKey: 'show_visual',
    createdAt: 100,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    title: 'Preview title',
    maxHeight: 600,
    ...(codexCallId !== undefined ? { codexCallId } : {}),
  };
  return { sidecar, html };
}

function makeVisualContext(
  staged: StagedVisual,
  overrides: Partial<ExternalizeVisualContext> = {},
): ExternalizeVisualContext {
  const owners = new Map<string, VisualOwnerFence>();
  const base: ExternalizeVisualContext = {
    kind: 'provider',
    chatId: 'chat-1',
    hasStagedEntries: () => true,
    linkedToolCall: (toolUseId: string): LinkedToolCall => ({
      toolUseId,
      toolName: 'show_visual',
      ...(staged.sidecar.codexCallId !== undefined
        ? { codexCallId: staged.sidecar.codexCallId }
        : {}),
    }),
    resolveToolKey: (call: LinkedToolCall) =>
      call.toolName === 'show_visual' ? 'show_visual' : undefined,
    ownerOf: (id: string) => owners.get(id),
    reserve: (id: string, owner: VisualOwnerFence) => {
      const existing = owners.get(id);
      if (
        existing &&
        (existing.messageId !== owner.messageId ||
          existing.toolUseId !== owner.toolUseId)
      ) {
        return false;
      }
      owners.set(id, owner);
      return true;
    },
    readStaged: (id: string) =>
      Promise.resolve(id === staged.sidecar.visualId ? staged : undefined),
    now: () => 200,
  };
  return { ...base, ...overrides };
}

function makeVisualReference(
  artifact: { artifactId: string; byteLength: number; sha256: string },
  id: string = visualId,
): PersistedVisualReference {
  return {
    version: 1,
    visualId: id,
    artifactId: artifact.artifactId,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    mediaType: 'text/html',
    title: 'Preview title',
    maxHeight: 600,
  };
}

function makeVisualResultMessage(output: string): PersistedChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'tool-use-1',
        toolName: 'ShowVisual',
        output,
        isError: false,
      },
    ],
  };
}

describe('chat transcript artifacts', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-artifacts-'));
    artifacts = new ChatTranscriptArtifacts(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps opaque row and block fields when externalizing a tool result', async () => {
    const textBlock: PersistedChatBlock = {
      type: 'text',
      text: 'ordinary',
    };
    const toolBlock: PersistedChatBlock = {
      type: 'tool_result',
      toolUseId: 'call',
      toolName: 'shell',
      output: 'large'.repeat(30_000),
      isError: false,
    };
    const message: PersistedChatMessage = {
      id: 'opaque',
      role: 'assistant',
      timestamp: 1,
      blocks: [textBlock, toolBlock],
    };
    // Preserve unknown legacy properties at the untyped storage boundary.
    Reflect.set(message, 'opaqueRow', { nested: ['row'] });
    Reflect.set(textBlock, 'opaqueBlock', { nested: ['text'] });
    Reflect.set(toolBlock, 'opaqueBlock', { nested: ['tool'] });
    const stored = await artifacts.externalize('chat-1', message);
    expect(stored).toMatchObject({ opaqueRow: { nested: ['row'] } });
    expect(stored.blocks[0]).toMatchObject({
      opaqueBlock: { nested: ['text'] },
    });
    expect(stored.blocks[1]).toMatchObject({
      opaqueBlock: { nested: ['tool'] },
    });
  });

  it('exports exact serialized row-byte accounting for the block-page guard', async () => {
    const artifactModule = await import('../lib/chat-transcript-artifacts');
    const measureRowBytes: unknown = Reflect.get(
      artifactModule,
      'transcriptRowByteLength',
    );

    expect(typeof measureRowBytes).toBe('function');
    if (typeof measureRowBytes !== 'function')
      throw new Error('Missing transcript row byte-length helper');

    const message: PersistedChatMessage = {
      id: 'measure',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'body' }],
    };
    Reflect.set(message, 'opaqueRow', { escaped: '\n🌲' });
    const measured: unknown = Reflect.apply(measureRowBytes, undefined, [
      message,
    ]);

    expect(measured).toBe(Buffer.byteLength(JSON.stringify(message), 'utf8'));
  });

  it('reuses the same lossless reference across repeated writes and a fresh reader', async () => {
    const output = 'repeated output 🌲\n'.repeat(8000);
    const first = await artifacts.put('chat-1', output);
    const second = await artifacts.put('chat-1', output);

    expect(second).toEqual(first);
    expect(await readdir(join(root, 'tool-output', 'chat-1'))).toEqual([
      `${first.artifactId}.txt`,
    ]);
    const freshReader = new ChatTranscriptArtifacts(root);
    await freshReader.verify('chat-1', second);
    let restored = '';
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await freshReader.readRange('chat-1', second, offset);
      restored += page.text;
      offset = page.nextOffset;
    }
    expect(restored).toBe(output);
  });

  it('repairs corrupt content at a matching artifact path before returning its reference', async () => {
    const output = 'durable output 🌲\n'.repeat(8000);
    const ref = await artifacts.put('chat-1', output);
    const replacement = Buffer.alloc(ref.byteLength, 0x78);
    await writeFile(
      join(root, 'tool-output', 'chat-1', `${ref.artifactId}.txt`),
      replacement,
    );

    expect(await artifacts.put('chat-1', output)).toEqual(ref);
    await new ChatTranscriptArtifacts(root).verify('chat-1', ref);
    expect(await readdir(join(root, 'tool-output', 'chat-1'))).toEqual([
      `${ref.artifactId}.txt`,
    ]);
  });

  it('keeps a duplicate destination copy lossless and repairs equal-size destination corruption', async () => {
    const output = 'copied output 🌲\n'.repeat(8000);
    const ref = await artifacts.put('source', output);
    const destination = new ChatTranscriptArtifacts(join(root, 'destination'));
    await artifacts.copyToChat('source', 'target', ref, destination);
    await artifacts.copyToChat('source', 'target', ref, destination);
    const targetPath = join(
      root,
      'destination',
      'tool-output',
      'target',
      `${ref.artifactId}.txt`,
    );
    expect(
      await readdir(join(root, 'destination', 'tool-output', 'target')),
    ).toEqual([`${ref.artifactId}.txt`]);
    // Allocate beside the existing file so corruption changes its inode even
    // when the filesystem gives rapid writes identical mtime/ctime values.
    const corruptPath = `${targetPath}.corrupt`;
    await writeFile(corruptPath, Buffer.alloc(ref.byteLength, 0x78));
    await rename(corruptPath, targetPath);
    await expect(
      new ChatTranscriptArtifacts(join(root, 'destination')).verify(
        'target',
        ref,
      ),
    ).rejects.toThrow('integrity validation');
    await artifacts.copyToChat('source', 'target', ref, destination);
    await rm(join(root, 'tool-output', 'source'), { recursive: true });
    await new ChatTranscriptArtifacts(join(root, 'destination')).verify(
      'target',
      ref,
    );
  });

  it('keeps the event loop responsive while writing a fresh multi-megabyte artifact', async () => {
    const output = 'fresh output 🌲\n'.repeat(550_000);
    type HashPass = {
      totalBytes: number;
      bytesSinceTurn: number;
      maxBytesBetweenTurns: number;
      tickScheduled: boolean;
    };
    const hashPasses: HashPass[] = [];
    const byHash = new WeakMap<crypto.Hash, HashPass>();
    const update: unknown = Reflect.get(crypto.Hash.prototype, 'update');
    if (typeof update !== 'function')
      throw new Error('Hash update method is unavailable');
    jest.spyOn(crypto.Hash.prototype, 'update').mockImplementation(function (
      this: crypto.Hash,
      data: crypto.BinaryLike,
      encoding?: BufferEncoding,
    ) {
      let pass = byHash.get(this);
      if (!pass) {
        pass = {
          totalBytes: 0,
          bytesSinceTurn: 0,
          maxBytesBetweenTurns: 0,
          tickScheduled: false,
        };
        byHash.set(this, pass);
        hashPasses.push(pass);
      }
      const bytes =
        typeof data === 'string'
          ? Buffer.byteLength(data, encoding)
          : data.byteLength;
      pass.totalBytes += bytes;
      pass.bytesSinceTurn += bytes;
      pass.maxBytesBetweenTurns = Math.max(
        pass.maxBytesBetweenTurns,
        pass.bytesSinceTurn,
      );
      if (!pass.tickScheduled) {
        pass.tickScheduled = true;
        setImmediate(() => {
          pass.bytesSinceTurn = 0;
          pass.tickScheduled = false;
        });
      }
      const result: unknown = Reflect.apply(update, this, [data, encoding]);
      if (!(result instanceof crypto.Hash))
        throw new Error('Hash update did not return its handle');
      return result;
    });

    const ref = await artifacts.put('chat-1', output);
    const substantialPasses = hashPasses.filter(
      (pass) => pass.totalBytes > 2 * 1024 * 1024,
    );
    expect(substantialPasses.length).toBeGreaterThan(0);
    for (const pass of substantialPasses)
      expect(pass.maxBytesBetweenTurns).toBeLessThanOrEqual(1024 * 1024);
    jest.restoreAllMocks();
    await new ChatTranscriptArtifacts(root).verify('chat-1', ref);
  });

  it('does not stage or publish an already verified artifact again', async () => {
    const output = 'duplicate output 🌲\n'.repeat(8000);
    const ref = await artifacts.put('chat-1', output);
    const open = jest.spyOn(fsPromises, 'open');
    const rename = jest.spyOn(fsPromises, 'rename');

    expect(await artifacts.put('chat-1', output)).toEqual(ref);
    expect(
      open.mock.calls.filter(([path]) => String(path).endsWith('.tmp')),
    ).toHaveLength(0);
    expect(rename).not.toHaveBeenCalled();
  });

  it('does not copy or publish an already verified destination artifact again', async () => {
    const ref = await artifacts.put(
      'source',
      'duplicate copy 🌲\n'.repeat(8000),
    );
    const destination = new ChatTranscriptArtifacts(join(root, 'destination'));
    await artifacts.copyToChat('source', 'target', ref, destination);
    const copyFile = jest.spyOn(fsPromises, 'copyFile');
    const rename = jest.spyOn(fsPromises, 'rename');

    await artifacts.copyToChat('source', 'target', ref, destination);
    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects a cold matching artifact when its directory cannot be made durable', async () => {
    const output = 'cold existing output 🌲\n'.repeat(8000);
    const ref = await artifacts.put('chat-1', output);
    const directory = join(root, 'tool-output', 'chat-1');
    const syncDirectory = directorySync.fsyncDirectory;
    const sync = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (path) => {
        if (path === directory)
          throw new Error('cold artifact directory sync failed');
        await syncDirectory(path);
      });

    await expect(
      new ChatTranscriptArtifacts(root).put('chat-1', output),
    ).rejects.toThrow('cold artifact directory sync failed');
    sync.mockRestore();
    await new ChatTranscriptArtifacts(root).verify('chat-1', ref);
  });

  it('rejects a cold matching destination when its directory cannot be made durable', async () => {
    const ref = await artifacts.put(
      'source',
      'cold copied output 🌲\n'.repeat(8000),
    );
    const destinationRoot = join(root, 'destination');
    await artifacts.copyToChat(
      'source',
      'target',
      ref,
      new ChatTranscriptArtifacts(destinationRoot),
    );
    const directory = join(destinationRoot, 'tool-output', 'target');
    const syncDirectory = directorySync.fsyncDirectory;
    const sync = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (path) => {
        if (path === directory)
          throw new Error('cold destination directory sync failed');
        await syncDirectory(path);
      });

    await expect(
      new ChatTranscriptArtifacts(root).copyToChat(
        'source',
        'target',
        ref,
        new ChatTranscriptArtifacts(destinationRoot),
      ),
    ).rejects.toThrow('cold destination directory sync failed');
    sync.mockRestore();
    await new ChatTranscriptArtifacts(destinationRoot).verify('target', ref);
  });

  it.each(['tool-output', 'transcripts'])(
    'rejects a cross-scope copy when the destination %s directory cannot be synced, then retries losslessly',
    async (failedDirectory) => {
      const output = 'retained cross-scope output 🌲\n'.repeat(4000);
      const ref = await artifacts.put('source', output);
      const destinationRoot = join(root, 'destination');
      const destination = new ChatTranscriptArtifacts(destinationRoot);
      const failedPath =
        failedDirectory === 'tool-output'
          ? join(destinationRoot, 'tool-output')
          : destinationRoot;
      const syncDirectory = directorySync.fsyncDirectory;
      const sync = jest
        .spyOn(directorySync, 'fsyncDirectory')
        .mockImplementation(async (directory) => {
          if (directory === failedPath)
            throw new Error('directory sync failed');
          await syncDirectory(directory);
        });

      await expect(
        artifacts.copyToChat('source', 'target', ref, destination),
      ).rejects.toThrow('directory sync failed');
      await artifacts.verify('source', ref);
      await expect(destination.verify('target', ref)).rejects.toThrow();

      sync.mockRestore();
      const syncedFiles = enforceWindowsFileSync();
      await artifacts.copyToChat('source', 'target', ref, destination);
      expect(syncedFiles.some((path) => path.endsWith('.tmp'))).toBe(true);
      await rm(join(root, 'tool-output', 'source'), { recursive: true });
      await destination.verify('target', ref);
      expect((await destination.readRange('target', ref)).text).toContain(
        'retained cross-scope output 🌲',
      );
    },
  );

  it('retains canonical receipts outside a large tool output preview', async () => {
    const receipt = {
      version: 1,
      kind: 'automation',
      operation: 'automation.create',
      dedupeKey: 'canopy:automation:global:a1',
      createdAt: '2026-10-16T00:00:00.000Z',
      activityId: 'a1',
      name: 'Daily',
      enabled: true,
      running: false,
      schedule: 'daily',
      actionKind: 'app_advisor_prompt',
      targetSummary: 'App Advisor',
      ifCommandConfigured: false,
      navigationTarget: { kind: 'automation_editor', activityId: 'a1' },
    };
    const output = JSON.stringify({
      ok: true,
      result: {
        head: 'x'.repeat(100000),
        agentArtifacts: [receipt],
        tail: 'y'.repeat(100000),
      },
    });
    const stored = await artifacts.externalize('chat-1', {
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 't1',
          toolName: 'mcp__canopy__DispatchAction',
          output,
          isError: false,
        },
      ],
    });
    expect(stored.blocks[0]).toMatchObject({
      outputTruncated: true,
      agentArtifacts: [receipt],
    });
    const again = await artifacts.externalize('chat-1', stored);
    expect(again).toEqual(stored);
    const legacy: PersistedChatMessage = {
      ...stored,
      blocks: stored.blocks.map((block) => {
        if (block.type !== 'tool_result') return block;
        const result = { ...block };
        delete result.agentArtifacts;
        return result;
      }),
    };
    const upgraded = await artifacts.hydrateAgentArtifacts('chat-1', legacy);
    expect(upgraded.blocks[0]).toMatchObject({ agentArtifacts: [receipt] });
    const projected = projectAgentArtifacts([
      {
        id: 'u1',
        role: 'user',
        timestamp: 0,
        blocks: [{ type: 'text', text: 'Save automation' }],
      },
      {
        id: 'call1',
        role: 'assistant',
        timestamp: 0,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 't1',
            toolName: 'mcp__canopy__DispatchAction',
            input: '{}',
          },
        ],
      },
      upgraded,
    ]);
    expect(projected.byTurn.u1).toEqual([receipt]);
  });

  it('round trips UTF-8 output through bounded previews and deferred ranges', async () => {
    const output = 'begin\n' + '🌲字\n'.repeat(30_000) + '\nend';
    const stored = await artifacts.externalize('chat-1', {
      id: 'message-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          toolName: 'shell',
          output,
          isError: false,
        },
      ],
    });
    const block = stored.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing artifact');
    expect(Buffer.byteLength(block.output)).toBeLessThanOrEqual(
      TOOL_OUTPUT_INLINE_BYTES,
    );
    expect(block.output.startsWith('begin\n')).toBe(true);
    expect(block.output.endsWith('\nend')).toBe(true);
    let restored = '';
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await artifacts.readRange(
        'chat-1',
        block.fullOutputRef,
        offset,
        8191,
      );
      restored += page.text;
      offset = page.nextOffset;
    }
    expect(restored).toBe(output);
    await expect(
      artifacts.readRange('chat-2', block.fullOutputRef),
    ).rejects.toThrow();
  });

  it('fails explicitly for corrupt artifacts and invalid identities', async () => {
    const ref = await artifacts.put('chat-1', 'original');
    await writeFile(
      join(root, 'tool-output', 'chat-1', `${ref.artifactId}.txt`),
      'changed',
    );
    await expect(artifacts.readRange('chat-1', ref)).rejects.toThrow(
      'integrity',
    );
    await expect(artifacts.put('../escape', 'text')).rejects.toThrow(
      'identity',
    );
    await expect(
      artifacts.readRange('chat-1', { ...ref, artifactId: '../escape' }),
    ).rejects.toThrow('reference');
  });

  it('preserves unpaired UTF-16 code units without replacement characters', async () => {
    const output = 'start\ud800'.repeat(12_000) + '\udfffend';
    const ref = await artifacts.put('chat-1', output);
    let restored = '';
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await artifacts.readRange('chat-1', ref, offset, 8191);
      restored += page.text;
      offset = page.nextOffset;
    }
    expect(restored === output).toBe(true);
  });

  it('refuses a UTF-16 offset inside a surrogate pair and allows lone halves', async () => {
    // Byte offsets in UTF-16LE: a 0, lone \ud800 2, b 4, \ud83c\udf32 6-9 (its low
    // half at 8), lone \udfff 10, c 12.
    const ref = await artifacts.put('chat-1', 'a\ud800b\ud83c\udf32\udfffc');
    expect(ref.encoding).toBe('utf-16le');
    await expect(artifacts.readRange('chat-1', ref, 8, 16)).rejects.toThrow(
      'Tool output offset splits a UTF-16 code unit',
    );
    expect((await artifacts.readRange('chat-1', ref, 2, 16)).text).toBe(
      '\ud800b\ud83c\udf32\udfffc',
    );
    expect((await artifacts.readRange('chat-1', ref, 6, 16)).text).toBe(
      '\ud83c\udf32\udfffc',
    );
    expect((await artifacts.readRange('chat-1', ref, 10, 16)).text).toBe(
      '\udfffc',
    );
  });

  it.each([
    ['three-byte UTF-8 characters', '\u0800'.repeat(16_385), 'utf8'],
    [
      'a UTF-8 surrogate pair at the chunk boundary',
      'x'.repeat(16_383) + '🌲' + '界'.repeat(16_390),
      'utf8',
    ],
    [
      'unpaired UTF-16 code units at the chunk boundary',
      'x'.repeat(16_383) + '\ud800🌲\udfff' + '界'.repeat(16_390),
      'utf16le',
    ],
  ] as const)(
    'stores %s with exact bytes and digest',
    async (_name, output, encoding) => {
      const ref = await artifacts.put('chat-1', output);
      const expected = Buffer.from(output, encoding);
      const actual = await readFile(
        join(root, 'tool-output', 'chat-1', `${ref.artifactId}.txt`),
      );
      expect(ref.encoding).toBe(encoding === 'utf8' ? 'utf-8' : 'utf-16le');
      expect(ref.byteLength).toBe(expected.length);
      expect(ref.sha256).toBe(
        crypto.createHash('sha256').update(expected).digest('hex'),
      );
      expect(actual).toEqual(expected);

      const freshReader = new ChatTranscriptArtifacts(root);
      let restored = '';
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page = await freshReader.readRange('chat-1', ref, offset, 8191);
        restored += page.text;
        offset = page.nextOffset;
      }
      expect(restored).toBe(output);
    },
  );

  it('keeps explicit Buffer allocation bounded as fresh output grows', async () => {
    const requestedBytes = async (
      chatId: string,
      output: string,
    ): Promise<number> => {
      const from = jest.spyOn(Buffer, 'from');
      const alloc = jest.spyOn(Buffer, 'alloc');
      const allocUnsafe = jest.spyOn(Buffer, 'allocUnsafe');
      const allocUnsafeSlow = jest.spyOn(Buffer, 'allocUnsafeSlow');
      try {
        await artifacts.put(chatId, output);
        return [from, alloc, allocUnsafe, allocUnsafeSlow]
          .flatMap((spy) => spy.mock.results)
          .reduce(
            (bytes, result) =>
              bytes +
              (result.type === 'return' && Buffer.isBuffer(result.value)
                ? result.value.length
                : 0),
            0,
          );
      } finally {
        from.mockRestore();
        alloc.mockRestore();
        allocUnsafe.mockRestore();
        allocUnsafeSlow.mockRestore();
      }
    };

    const small = '界'.repeat(Math.ceil((1024 * 1024) / 3));
    const large = '界'.repeat(Math.ceil((8 * 1024 * 1024) / 3));
    const smallBytes = await requestedBytes('small', small);
    const largeBytes = await requestedBytes('large', large);
    expect(largeBytes - smallBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('keeps the legacy externalize result and artifacts byte-identical (oracle)', async () => {
    // Oracle captured from the unchanged phase 06 implementation: a format 2/3
    // row offloads tool output only and leaves every other field untouched.
    const message = legacyOracleFixture();
    const before = JSON.stringify(message);
    const implicit = await artifacts.externalize('chat-1', message);
    const explicit = await new ChatTranscriptArtifacts(root).externalize(
      'chat-1',
      message,
      undefined,
      { kind: 'legacy' },
    );
    expect(JSON.stringify(message)).toBe(before);
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(implicit))
      .digest('hex');
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
    expect(digest).toBe(
      '429c1a0ae4826d193f8073e0895fd42fac8d534d72eb761f17c761d23701b1a5',
    );
    expect((await readdir(join(root, 'tool-output', 'chat-1'))).sort()).toEqual(
      [
        'sha256-v1-f354d0801f1d7425ca04c9b8435be340b43c4a578303935b5ed610888c94bca1.txt',
      ],
    );
  });

  it('stores, verifies, copies, and reads exact visual bytes including split UTF-8 ranges', async (): Promise<void> => {
    const html = 'A🌲B';
    const created = new CreatedArtifacts();
    const artifact = await artifacts.putVisual('chat-1', html, created);
    const ref = makeVisualReference(artifact);
    const storedReference: PersistedArtifactReference = {
      family: 'visual',
      reference: ref,
    };

    expect(created.size).toBe(1);
    expect(artifact.byteLength).toBe(Buffer.byteLength(html, 'utf8'));
    expect(artifact.sha256).toBe(
      crypto
        .createHash('sha256')
        .update(Buffer.from(html, 'utf8'))
        .digest('hex'),
    );
    await artifacts.verifyVisual('chat-1', ref);
    await artifacts.copyArtifactToChat('chat-1', 'chat-2', storedReference);
    await artifacts.verifyArtifact('chat-2', storedReference);

    const expectedBytes = Buffer.from(html, 'utf8');
    const splitRange = await artifacts.readVisualRange('chat-1', ref, 2, 2);
    expect(splitRange).toEqual({
      bytes: expectedBytes.subarray(2, 4),
      offset: 2,
      length: 2,
      byteLength: expectedBytes.length,
      sha256: artifact.sha256,
    });
    expect(splitRange.bytes.toString('hex')).toBe('9f8c');

    const atEnd = await artifacts.readVisualRange(
      'chat-1',
      ref,
      artifact.byteLength,
      100,
    );
    expect(atEnd.length).toBe(0);
    expect(atEnd.bytes).toEqual(Buffer.alloc(0));
    await expect(
      artifacts.readVisualRange('chat-1', ref, artifact.byteLength + 1, 1),
    ).rejects.toThrow('Invalid visual range');
    await expect(artifacts.verifyVisual('chat-3', ref)).rejects.toThrow();
  });

  it('reuses verified visual bytes and stores identical content in separate chats', async (): Promise<void> => {
    const html = '<main>same 🌿</main>';
    const first = await artifacts.putVisual('chat-1', html);
    const open = jest.spyOn(fsPromises, 'open');
    const rename = jest.spyOn(fsPromises, 'rename');

    expect(await artifacts.putVisual('chat-1', html)).toEqual(first);
    expect(
      open.mock.calls.filter(([path]) => String(path).endsWith('.tmp')),
    ).toHaveLength(0);
    expect(rename).not.toHaveBeenCalled();

    const second = await artifacts.putVisual('chat-2', html);
    expect(second).toEqual(first);
    await artifacts.verifyVisual('chat-2', makeVisualReference(second));
    expect(
      await readFile(
        join(root, 'visuals', 'chat-1', `${first.artifactId}.html`),
      ),
    ).toEqual(Buffer.from(html, 'utf8'));
    expect(
      await readFile(
        join(root, 'visuals', 'chat-2', `${second.artifactId}.html`),
      ),
    ).toEqual(Buffer.from(html, 'utf8'));
  });

  it('rejects invalid visual references and detects artifact tampering', async (): Promise<void> => {
    const html = '<section>verified</section>';
    const artifact = await artifacts.putVisual('chat-1', html);
    const ref = makeVisualReference(artifact);
    await expect(
      artifacts.verifyVisual('chat-1', { ...ref, visualId: 'bad' }),
    ).rejects.toThrow('Invalid visual reference');
    await expect(
      artifacts.verifyVisual('chat-1', {
        ...ref,
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('Invalid visual reference');
    await expect(
      artifacts.verifyVisual('chat-1', {
        ...ref,
        byteLength: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow('Invalid visual reference');

    await writeFile(
      join(root, 'visuals', 'chat-1', `${ref.artifactId}.html`),
      '<section>tampered</section>',
    );
    await expect(artifacts.verifyVisual('chat-1', ref)).rejects.toThrow(
      'Visual artifact failed integrity validation',
    );
  });

  it('reuses a verified visual at a copied destination', async (): Promise<void> => {
    const artifact = await artifacts.putVisual('source', '<p>copied</p>');
    const ref = makeVisualReference(artifact);
    const storedReference: PersistedArtifactReference = {
      family: 'visual',
      reference: ref,
    };
    const destination = new ChatTranscriptArtifacts(join(root, 'destination'));
    await artifacts.copyArtifactToChat(
      'source',
      'target',
      storedReference,
      destination,
    );
    const copyFile = jest.spyOn(fsPromises, 'copyFile');
    const rename = jest.spyOn(fsPromises, 'rename');

    await artifacts.copyArtifactToChat(
      'source',
      'target',
      storedReference,
      destination,
    );
    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-16 and oversized visual HTML', async (): Promise<void> => {
    await expect(artifacts.putVisual('chat-1', 'bad\ud800')).rejects.toThrow(
      'well-formed UTF-8',
    );
    await expect(
      artifacts.putVisual('chat-1', 'x'.repeat(VISUAL_PREPARED_MAX_BYTES + 1)),
    ).rejects.toThrow('prepared byte limit');
  });

  it.each([
    ['Claude text output', `${visualId}\nRendered`, visualId],
    [
      'Codex head-capped output',
      `${visualId}\n… more output omitted`,
      visualId,
    ],
    [
      'Cursor JSON-stringified output',
      JSON.stringify({ output: `\n${visualId}\nrendered` }),
      visualId,
    ],
  ])(
    'promotes staged visuals from %s',
    async (_name: string, output: string, id: string): Promise<void> => {
      const html = '<article>promoted</article>';
      const staged = makeStagedVisual(html);
      const context = makeVisualContext(staged);
      const result = await artifacts.externalizeWithVisuals(
        'chat-1',
        makeVisualResultMessage(output),
        new CreatedArtifacts(),
        { kind: 'legacy' },
        context,
      );
      const block = result.message.blocks[0];
      if (block?.type !== 'tool_result' || !block.visualRef)
        throw new Error('Visual was not promoted');
      expect(block.visualRef.visualId).toBe(id);
      expect(block.visualRef.title).toBe(staged.sidecar.title);
      expect(result.promotedVisuals).toEqual([
        { chatId: 'chat-1', visualId: id, reference: block.visualRef },
      ]);
      await artifacts.verifyVisual('chat-1', block.visualRef);
    },
  );

  it('does not claim staged visuals without context or when staging reports no entries', async (): Promise<void> => {
    const staged = makeStagedVisual('<p>not claimed</p>');
    const message = makeVisualResultMessage(visualId);
    const withoutContext = await artifacts.externalizeWithVisuals(
      'chat-1',
      message,
    );
    const blockWithoutContext = withoutContext.message.blocks[0];
    if (blockWithoutContext?.type !== 'tool_result')
      throw new Error('Missing result block');
    expect(blockWithoutContext.visualRef).toBeUndefined();

    const readStaged = jest.fn(
      (): Promise<StagedVisual | undefined> => Promise.resolve(staged),
    );
    const noEntries = makeVisualContext(staged, {
      hasStagedEntries: () => false,
      readStaged,
    });
    const result = await artifacts.externalizeWithVisuals(
      'chat-1',
      message,
      undefined,
      { kind: 'legacy' },
      noEntries,
    );
    const blockWithoutEntry = result.message.blocks[0];
    if (blockWithoutEntry?.type !== 'tool_result')
      throw new Error('Missing result block');
    expect(blockWithoutEntry.visualRef).toBeUndefined();
    expect(readStaged).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown identity', { resolveToolKey: (): undefined => undefined }],
    [
      'a different owner',
      {
        ownerOf: (): VisualOwnerFence => ({
          messageId: 'other-message',
          toolUseId: 'other-tool',
          claimedAt: 100,
        }),
      },
    ],
    [
      'a mismatched Codex call id',
      {
        linkedToolCall: (toolUseId: string): LinkedToolCall => ({
          toolUseId,
          toolName: 'show_visual',
          codexCallId: 'other-codex-call',
        }),
      },
    ],
  ])(
    'does not claim a staged visual with %s',
    async (
      _name: string,
      overrides: Partial<ExternalizeVisualContext>,
    ): Promise<void> => {
      const staged = makeStagedVisual('<p>not claimed</p>', 'codex-call');
      const context = makeVisualContext(staged, overrides);
      const result = await artifacts.externalizeWithVisuals(
        'chat-1',
        makeVisualResultMessage(visualId),
        undefined,
        { kind: 'legacy' },
        context,
      );
      const block = result.message.blocks[0];
      if (block?.type !== 'tool_result')
        throw new Error('Missing result block');
      expect(block.visualRef).toBeUndefined();
      expect(result.promotedVisuals).toEqual([]);
    },
  );

  it('keeps promoted references byte-identical on repeated externalization', async (): Promise<void> => {
    const staged = makeStagedVisual('<p>repeat</p>');
    const readStaged = jest.fn(
      (): Promise<StagedVisual> => Promise.resolve(staged),
    );
    const context = makeVisualContext(staged, { readStaged });
    const created = new CreatedArtifacts();
    const first = await artifacts.externalizeWithVisuals(
      'chat-1',
      makeVisualResultMessage(visualId),
      created,
      { kind: 'legacy' },
      context,
    );
    const second = await artifacts.externalizeWithVisuals(
      'chat-1',
      first.message,
      created,
      { kind: 'legacy' },
      context,
    );
    const firstBlock = first.message.blocks[0];
    const secondBlock = second.message.blocks[0];
    if (
      firstBlock?.type !== 'tool_result' ||
      !firstBlock.visualRef ||
      secondBlock?.type !== 'tool_result' ||
      !secondBlock.visualRef
    ) {
      throw new Error('Visual reference was not retained');
    }
    expect(secondBlock.visualRef).toEqual(firstBlock.visualRef);
    expect(second.promotedVisuals).toEqual([]);
    expect(readStaged).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, 'visuals', 'chat-1'))).toEqual([
      `${firstBlock.visualRef.artifactId}.html`,
    ]);
  });

  it('promotes a visual while externalizing a large full output', async (): Promise<void> => {
    const staged = makeStagedVisual('<p>large output companion</p>');
    const message = makeVisualResultMessage(
      `${visualId}\n${'large output '.repeat(TOOL_OUTPUT_INLINE_BYTES)}`,
    );
    const result = await artifacts.externalizeWithVisuals(
      'chat-1',
      message,
      undefined,
      { kind: 'legacy' },
      makeVisualContext(staged),
    );
    const block = result.message.blocks[0];
    if (
      block?.type !== 'tool_result' ||
      !block.visualRef ||
      !block.fullOutputRef
    )
      throw new Error('Full output and visual references were not retained');
    await artifacts.verifyVisual('chat-1', block.visualRef);
    await artifacts.verify('chat-1', block.fullOutputRef);
  });
});

interface Carrier {
  name: string;
  refKey: 'textRef' | 'inputRef' | 'partialTextRef' | 'finalTextRef';
  block: (value: string) => PersistedChatBlock;
  read: (block: PersistedChatBlock | undefined) => {
    value: string | undefined;
    ref: PersistedToolOutputReference | undefined;
  };
}

const carriers: Carrier[] = [
  {
    name: 'text',
    refKey: 'textRef',
    block: (text): PersistedChatBlock => {
      const block = { type: 'text' as const, text, opaqueBlock: 1 };
      return block;
    },
    read: (block) =>
      block?.type === 'text'
        ? { value: block.text, ref: block.textRef }
        : { value: undefined, ref: undefined },
  },
  {
    name: 'thinking',
    refKey: 'textRef',
    block: (text) => ({ type: 'thinking', text }),
    read: (block) =>
      block?.type === 'thinking'
        ? { value: block.text, ref: block.textRef }
        : { value: undefined, ref: undefined },
  },
  {
    name: 'tool input',
    refKey: 'inputRef',
    block: (input) => ({
      type: 'tool_use',
      toolUseId: 'call-1',
      toolName: 'shell',
      input,
      display: { toolName: 'Shell', input: 'short' },
    }),
    read: (block) =>
      block?.type === 'tool_use'
        ? { value: block.input, ref: block.inputRef }
        : { value: undefined, ref: undefined },
  },
  {
    name: 'delegated partial answer',
    refKey: 'partialTextRef',
    block: (partialText) => delegatedCard({ partialText }),
    read: (block) =>
      block?.type === 'delegated_agent_call'
        ? { value: block.partialText, ref: block.partialTextRef }
        : { value: undefined, ref: undefined },
  },
  {
    name: 'delegated final answer',
    refKey: 'finalTextRef',
    block: (finalText) => delegatedCard({ finalText }),
    read: (block) =>
      block?.type === 'delegated_agent_call'
        ? { value: block.finalText, ref: block.finalTextRef }
        : { value: undefined, ref: undefined },
  },
];

/** Exactly 65,536 UTF-8 bytes of multibyte text, and one byte more. */
const edges: Array<[string, string, string]> = [
  ['three-byte', '界'.repeat(21_845) + 'a', '界'.repeat(21_845) + 'ab'],
  ['four-byte', '🌲'.repeat(16_384), '🌲'.repeat(16_384) + 'a'],
];

function row(blocks: PersistedChatBlock[], fields = {}): PersistedChatMessage {
  return { id: 'row', role: 'assistant', timestamp: 1, ...fields, blocks };
}

function toolResult(output: string, toolUseId = 'call-1'): PersistedChatBlock {
  return {
    type: 'tool_result',
    toolUseId,
    toolName: 'shell',
    output,
    isError: false,
  };
}

function rowBytes(message: PersistedChatMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

describe('format 4 field references (phase 07 new feature)', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;
  const final: TranscriptFieldPolicy = { kind: 'format4', final: true };
  const open: TranscriptFieldPolicy = { kind: 'format4', final: false };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-field-refs-'));
    artifacts = new ChatTranscriptArtifacts(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const artifactFiles = async (chatId = 'chat-1'): Promise<string[]> => {
    try {
      return await readdir(join(root, 'tool-output', chatId));
    } catch {
      return [];
    }
  };

  const restore = async (
    ref: PersistedToolOutputReference,
  ): Promise<string> => {
    const reader = new ChatTranscriptArtifacts(root);
    let restored = '';
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await reader.readRange('chat-1', ref, offset, 65_536);
      restored += page.text;
      offset = page.nextOffset;
    }
    return restored;
  };

  describe.each(carriers)('$name', (carrier) => {
    it.each(edges)(
      'keeps %s text of exactly the inline budget inline and offloads one byte more',
      async (_name, atBudget, overBudget) => {
        expect(Buffer.byteLength(atBudget)).toBe(TOOL_OUTPUT_INLINE_BYTES);
        const inline = row([carrier.block(atBudget)]);
        expect(
          await artifacts.externalize('chat-1', inline, undefined, final),
        ).toEqual(inline);
        expect(await artifactFiles()).toEqual([]);

        const input = carrier.block(overBudget);
        const created = new CreatedArtifacts();
        const stored = await artifacts.externalize(
          'chat-1',
          row([input]),
          created,
          final,
        );
        const { value, ref } = carrier.read(stored.blocks[0]);
        if (value === undefined || !ref) throw new Error('Missing reference');
        expect(Buffer.byteLength(value)).toBeLessThanOrEqual(
          TOOL_OUTPUT_INLINE_BYTES,
        );
        expect(value).toContain('[Full output stored separately]');
        expect(created.size).toBe(1);
        expect(await restore(ref)).toBe(overBudget);
        expect(Object.keys(stored.blocks[0] ?? {})).toEqual([
          ...Object.keys(input),
          carrier.refKey,
        ]);
      },
    );

    it('keeps an open row whole and publishes nothing for it', async () => {
      const value = edges[0][2];
      const input = row([carrier.block(value)]);
      const rename = jest.spyOn(fsPromises, 'rename');
      expect(
        await artifacts.externalize('chat-1', input, undefined, open),
      ).toEqual(input);
      expect(rename).not.toHaveBeenCalled();
      expect(await artifactFiles()).toEqual([]);
    });

    it('verifies an existing reference and never publishes it again', async () => {
      const stored = await artifacts.externalize(
        'chat-1',
        row([carrier.block(edges[1][2])]),
        undefined,
        final,
      );
      const rename = jest.spyOn(fsPromises, 'rename');
      for (const policy of [
        final,
        open,
        { kind: 'format4-verify' as const, final: true },
      ])
        expect(
          await new ChatTranscriptArtifacts(root).externalize(
            'chat-1',
            stored,
            undefined,
            policy,
          ),
        ).toEqual(stored);
      expect(rename).not.toHaveBeenCalled();

      const { ref } = carrier.read(stored.blocks[0]);
      if (!ref) throw new Error('Missing reference');
      await writeFile(
        join(root, 'tool-output', 'chat-1', `${ref.artifactId}.txt`),
        Buffer.alloc(ref.byteLength, 0x78),
      );
      await expect(
        new ChatTranscriptArtifacts(root).externalize(
          'chat-1',
          stored,
          undefined,
          final,
        ),
      ).rejects.toThrow('integrity');
    });

    it('rejects a referenced preview over the inline budget', async () => {
      const ref = await artifacts.put('chat-1', edges[0][2]);
      const block = { ...carrier.block(edges[0][2]), [carrier.refKey]: ref };
      for (const policy of [
        final,
        open,
        { kind: 'format4-verify' as const, final: false },
      ])
        await expect(
          artifacts.externalize('chat-1', row([block]), undefined, policy),
        ).rejects.toThrow('preview exceeds inline budget');
    });

    it('rejects an unbacked large field of a final row in verify mode only', async () => {
      const input = row([carrier.block(edges[0][2])]);
      await expect(
        artifacts.externalize('chat-1', input, undefined, {
          kind: 'format4-verify',
          final: true,
        }),
      ).rejects.toThrow('without a lossless artifact');
      expect(
        await artifacts.externalize('chat-1', input, undefined, {
          kind: 'format4-verify',
          final: false,
        }),
      ).toEqual(input);
      expect(await artifactFiles()).toEqual([]);
    });
  });

  it('offloads tool output of an open row exactly as the legacy path does', async () => {
    const output = 'open tool output 🌲\n'.repeat(8000);
    const text = 'open text 🌲\n'.repeat(8000);
    const stored = await artifacts.externalize(
      'chat-1',
      row([{ type: 'text', text }, toolResult(output)]),
      undefined,
      open,
    );
    const legacy = await artifacts.externalize(
      'chat-1',
      row([{ type: 'text', text }, toolResult(output)]),
    );
    expect(stored).toEqual(legacy);
    expect(stored.blocks[0]).toEqual({ type: 'text', text });
    expect(transcriptBodyReferences(stored).map(({ field }) => field)).toEqual([
      'output',
    ]);
  });

  it.each([true, false])(
    'rejects unbacked large tool output in verify mode (final %s)',
    async (isFinal) => {
      await expect(
        artifacts.externalize(
          'chat-1',
          row([toolResult('x'.repeat(TOOL_OUTPUT_INLINE_BYTES + 1))]),
          undefined,
          { kind: 'format4-verify', final: isFinal },
        ),
      ).rejects.toThrow('without a lossless artifact');
      expect(await artifactFiles()).toEqual([]);
    },
  );

  describe('preview reduction under the row guard', () => {
    const outputs = (count: number, unit = 'out'): PersistedChatBlock[] =>
      Array.from({ length: count }, (_, index) =>
        toolResult(`${index} ${unit} `.repeat(30_000), `call-${index}`),
      );
    const previews = (message: PersistedChatMessage): string[] =>
      message.blocks.flatMap((block) =>
        block.type === 'tool_result' ? [block.output] : [],
      );

    it('shrinks backed previews in block order until the row fits', async () => {
      const text = 'x'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 150 * 1024);
      const input = row([{ type: 'text', text }, ...outputs(4)]);
      const unreduced = await artifacts.externalize('chat-1', input);
      expect(rowBytes(unreduced)).toBeGreaterThan(MAX_TRANSCRIPT_ROW_BYTES);

      const stored = await artifacts.externalize(
        'chat-1',
        input,
        undefined,
        open,
      );
      expect(rowBytes(stored)).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
      expect(stored.blocks[0]).toEqual({ type: 'text', text });
      expect(transcriptBodyReferences(stored)).toEqual(
        transcriptBodyReferences(unreduced),
      );
      const reduced = previews(stored);
      const full = previews(unreduced);
      expect(Buffer.byteLength(reduced[0] ?? '')).toBeLessThan(4096);
      expect(reduced[0]?.startsWith('0 out')).toBe(true);
      expect(reduced[0]).toContain('[Full output stored separately]');
      expect(reduced[3]).toBe(full[3]);
      stored.blocks.forEach((block, index) =>
        expect(Object.keys(block)).toEqual(
          Object.keys(unreduced.blocks[index] ?? {}),
        ),
      );
      // Reduction is deterministic and idempotent.
      expect(
        await artifacts.externalize('chat-1', input, undefined, open),
      ).toEqual(stored);
      expect(
        await artifacts.externalize('chat-1', stored, undefined, open),
      ).toEqual(stored);
    });

    it('empties backed previews after the short tier and keeps every reference', async () => {
      const text = 'x'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 4 * 1024);
      const stored = await artifacts.externalize(
        'chat-1',
        row([{ type: 'text', text }, ...outputs(4)]),
        undefined,
        open,
      );
      expect(rowBytes(stored)).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
      expect(transcriptBodyReferences(stored)).toHaveLength(4);
      expect(previews(stored)[0]).toBe('');
      for (const block of stored.blocks)
        if (block.type === 'tool_result')
          expect(block).toMatchObject({ outputTruncated: true });
    });

    it('accounts for JSON escaping when shrinking previews', async () => {
      const text = 'x'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 500 * 1024);
      const escaped = Array.from({ length: 2 }, (_, index) =>
        toolResult(`${index}` + '\u0001'.repeat(70_000), `call-${index}`),
      );
      const stored = await artifacts.externalize(
        'chat-1',
        row([{ type: 'text', text }, ...escaped]),
        undefined,
        open,
      );
      const unreduced = await artifacts.externalize(
        'chat-1',
        row([{ type: 'text', text }, ...escaped]),
      );
      expect(rowBytes(unreduced)).toBeGreaterThan(MAX_TRANSCRIPT_ROW_BYTES);
      expect(rowBytes(stored)).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
      expect(previews(stored)[1]).toBe(previews(unreduced)[1]);
    });

    it('never shortens unbacked strings of a final row', async () => {
      const opaque = 'o'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 100 * 1024);
      const stored = await artifacts.externalize(
        'chat-1',
        row(
          [
            { type: 'text', text: 'large final text '.repeat(10_000) },
            { type: 'thinking', text: 'small thought' },
            ...outputs(2),
          ],
          { opaqueRow: opaque },
        ),
        undefined,
        final,
      );
      expect(rowBytes(stored)).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
      expect(stored).toMatchObject({ opaqueRow: opaque });
      expect(stored.blocks[1]).toEqual({
        type: 'thinking',
        text: 'small thought',
      });
      expect(
        transcriptBodyReferences(stored).map(({ field }) => field),
      ).toEqual(['text', 'output', 'output']);
    });

    it('leaves an irreducible row for the row guard to reject', async () => {
      const text = 'x'.repeat(MAX_TRANSCRIPT_ROW_BYTES + 1);
      const stored = await artifacts.externalize(
        'chat-1',
        row([{ type: 'text', text }, ...outputs(1)]),
        undefined,
        open,
      );
      expect(stored.blocks[0]).toEqual({ type: 'text', text });
      expect(previews(stored)).toEqual(['']);
      expect(transcriptBodyReferences(stored)).toHaveLength(1);
      expect(rowBytes(stored)).toBeGreaterThan(MAX_TRANSCRIPT_ROW_BYTES);
    });

    it('does not reduce previews in legacy or verify mode', async () => {
      const text = 'x'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 100 * 1024);
      const input = row([{ type: 'text', text }, ...outputs(2)]);
      const legacy = await artifacts.externalize('chat-1', input);
      expect(rowBytes(legacy)).toBeGreaterThan(MAX_TRANSCRIPT_ROW_BYTES);
      expect(
        await artifacts.externalize('chat-1', legacy, undefined, {
          kind: 'format4-verify',
          final: false,
        }),
      ).toEqual(legacy);
    });
  });
});

function delegatedCard(
  fields: Partial<DelegatedAgentCallBlock> = {},
): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    delegationId: 'child-1',
    status: 'completed',
    outputTruncated: false,
    agentBlockId: 'delegated-agent-child-1',
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'user-1',
    parentToolCallId: 'call-1',
    createdAt: 1000,
    selectedModelId: '',
    runtimeModelId: '',
    targetHarnessId: '',
    description: 'Review',
    prompt: 'Read the source.',
    executionMode: 'background',
    ...fields,
  };
}

function legacyOracleFixture(): PersistedChatMessage {
  const large = (label: string): string =>
    `${label} begin\n` + `${label} 🌲字\n`.repeat(9_000) + `${label} end`;
  // Opaque keys a newer writer may add; storage must carry them unchanged.
  const text = { type: 'text' as const, text: large('text'), opaqueBlock: 1 };
  const output = {
    type: 'tool_result' as const,
    toolUseId: 'call-1',
    toolName: 'shell',
    output: large('output'),
    isError: false,
    opaqueBlock: { nested: ['tool'] },
  };
  const blocks: PersistedChatBlock[] = [
    text,
    { type: 'thinking', text: large('thinking') },
    {
      type: 'tool_use',
      toolUseId: 'call-1',
      toolName: 'shell',
      input: large('input'),
      display: { toolName: 'Shell', input: 'short' },
    },
    output,
    {
      type: 'tool_result',
      toolUseId: 'call-2',
      toolName: 'shell',
      output: 'small output',
      isError: true,
    },
    delegatedCard({
      partialText: large('partial'),
      finalText: large('final'),
    }),
  ];
  const message = {
    id: 'oracle',
    role: 'assistant' as const,
    timestamp: 7,
    opaqueRow: { nested: ['row'] },
    blocks,
  };
  return message;
}
