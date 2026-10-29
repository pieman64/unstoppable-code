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
import {
  ChatTranscriptArtifacts,
  CreatedArtifacts,
} from '../lib/chat-transcript-artifacts';
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
import { TOOL_OUTPUT_INLINE_BYTES } from '@canopy/agent-transcript/transcript-storage';
import type {
  PersistedChatMessage,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
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
    const update = Reflect.get(crypto.Hash.prototype, 'update');
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
      context,
    );
    const second = await artifacts.externalizeWithVisuals(
      'chat-1',
      first.message,
      created,
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
