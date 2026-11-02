import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  TranscriptBlocksReference,
} from '@canopy/agent-transcript/types';
import {
  encodeTranscriptBlockManifest,
  encodeTranscriptBlockPage,
  isTranscriptBlockManifest,
  isTranscriptBlockPage,
  isTranscriptBlocksReference,
  transcriptBodyReferences,
} from '@canopy/agent-transcript/transcript-storage';
import type {
  TranscriptBlockManifest,
  TranscriptBlockPage,
} from '@canopy/agent-transcript/transcript-storage';
import {
  ChatTranscriptArtifacts,
  CreatedArtifacts,
  type ChatTranscriptArtifactOptions,
  type TranscriptFieldPolicy,
} from '../lib/chat-transcript-artifacts';
import { TranscriptStreamStore } from '../lib/chat-transcript-log';
import { primaryTranscriptPaths } from '../lib/transcript-stream-paths';
import {
  isPersistedChatBlock,
  isPersistedChatMessage,
} from '../lib/persisted-chat-message-validation';
import { MAX_TRANSCRIPT_ROW_BYTES } from '../lib/chat-transcript-prefix-replace';
import { TOOL_OUTPUT_INLINE_BYTES } from '@canopy/agent-transcript/transcript-storage';

// Page and manifest artifacts are hashed and published on disk; several
// tests build tens of MiB, which exceeds Jest's 5 s default on a loaded host.
jest.setTimeout(120_000);

const artifactReference = (
  digit: string = 'a',
): PersistedToolOutputReference => ({
  version: 1,
  artifactId: `sha256-v1-${digit.repeat(64)}`,
  byteLength: 1,
  sha256: digit.repeat(64),
  encoding: 'utf-8',
  mediaType: 'text/plain',
});

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
const originalJsonStringify = JSON.stringify;

const row = (
  blocks: PersistedChatBlock[],
  fields: Record<string, unknown> = {},
): PersistedChatMessage => ({
  id: 'row',
  role: 'assistant',
  timestamp: 1,
  ...fields,
  blocks,
});

function withLegacyExtension<T extends PersistedChatBlock>(
  block: T,
  field: 'opaqueBlock' | 'opaquePayload',
  value: unknown,
): T {
  // Legacy transcript extensions remain present at runtime despite not being in the current DTO.
  Reflect.set(block, field, value);
  return block;
}

const toolResult = (output: string, ordinal: number): PersistedChatBlock =>
  withLegacyExtension(
    {
      type: 'tool_result',
      toolUseId: `call-${ordinal}`,
      toolName: 'shell',
      output,
      isError: false,
    },
    'opaqueBlock',
    { ordinal },
  );

function isNonemptyTranscriptRow(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  const blocks: unknown = Reflect.get(value, 'blocks');
  return typeof id === 'string' && Array.isArray(blocks) && blocks.length > 0;
}

async function readArtifact(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  reference: PersistedToolOutputReference,
): Promise<string> {
  let text = '';
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await artifacts.readRange(chatId, reference, offset);
    text += page.text;
    offset = page.nextOffset;
  }
  return text;
}

async function pagedRow(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  blocks: PersistedChatBlock[],
): Promise<{
  message: PersistedChatMessage;
  pageReference: PersistedToolOutputReference;
  manifestReference: PersistedToolOutputReference;
}> {
  const page: TranscriptBlockPage = {
    version: 1,
    kind: 'transcript-block-page',
    firstBlockOrdinal: 0,
    blocks,
  };
  const pageReference = await artifacts.put(
    chatId,
    encodeTranscriptBlockPage(page),
  );
  const manifest: TranscriptBlockManifest = {
    version: 1,
    kind: 'transcript-block-manifest',
    firstBlockOrdinal: 0,
    blockCount: blocks.length,
    entries: [
      {
        kind: 'page',
        firstBlockOrdinal: 0,
        blockCount: blocks.length,
        reference: pageReference,
      },
    ],
  };
  const manifestReference = await artifacts.put(
    chatId,
    encodeTranscriptBlockManifest(manifest),
  );
  const message = row([], {
    blocksRef: {
      version: 1,
      manifest: manifestReference,
      blockCount: blocks.length,
    },
  });
  return { message, pageReference, manifestReference };
}

async function readBlockTree(
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  rootReference: PersistedToolOutputReference,
): Promise<{
  pages: Array<{
    reference: PersistedToolOutputReference;
    value: TranscriptBlockPage;
    firstBlockOrdinal: number;
    blockCount: number;
  }>;
  manifests: Array<{
    reference: PersistedToolOutputReference;
    value: TranscriptBlockManifest;
  }>;
}> {
  const pages: Array<{
    reference: PersistedToolOutputReference;
    value: TranscriptBlockPage;
    firstBlockOrdinal: number;
    blockCount: number;
  }> = [];
  const manifests: Array<{
    reference: PersistedToolOutputReference;
    value: TranscriptBlockManifest;
  }> = [];

  async function visitManifest(
    reference: PersistedToolOutputReference,
  ): Promise<void> {
    const encoded = await readArtifact(artifacts, chatId, reference);
    const parsed: unknown = JSON.parse(encoded);
    if (!isTranscriptBlockManifest(parsed))
      throw new Error('Invalid block manifest in test traversal');
    manifests.push({ reference, value: parsed });
    for (const entry of parsed.entries) {
      if (entry.kind === 'manifest') {
        await visitManifest(entry.reference);
      } else {
        const pageText = await readArtifact(artifacts, chatId, entry.reference);
        const parsedPage: unknown = JSON.parse(pageText);
        if (!isTranscriptBlockPage(parsedPage, isPersistedChatBlock))
          throw new Error('Invalid block page in test traversal');
        pages.push({
          reference: entry.reference,
          value: parsedPage,
          firstBlockOrdinal: entry.firstBlockOrdinal,
          blockCount: entry.blockCount,
        });
      }
    }
  }

  await visitManifest(rootReference);
  return { pages, manifests };
}

function withTargets(
  root: string,
  targets: ChatTranscriptArtifactOptions,
): ChatTranscriptArtifacts {
  return new ChatTranscriptArtifacts(root, false, targets);
}

describe('chat transcript block pages', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-block-pages-'));
    artifacts = new ChatTranscriptArtifacts(root);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('expands a verified paged row and yields its complete reference closure', async () => {
    const blocks: PersistedChatBlock[] = [
      withLegacyExtension({ type: 'text', text: 'one' }, 'opaqueBlock', {
        keep: true,
      }),
      withLegacyExtension({ type: 'thinking', text: 'two' }, 'opaqueBlock', [
        'keep',
      ]),
    ];
    const fixture = await pagedRow(artifacts, 'chat', blocks);

    await expect(
      artifacts.expandBlocks('chat', fixture.message),
    ).resolves.toEqual(row(blocks));

    const closure: PersistedToolOutputReference[] = [];
    for await (const reference of artifacts.referenceClosure(
      'chat',
      fixture.message,
    ))
      closure.push(reference);
    expect(closure.map(({ artifactId }) => artifactId).sort()).toEqual(
      [fixture.pageReference, fixture.manifestReference]
        .map(({ artifactId }) => artifactId)
        .sort(),
    );
  });

  it('authorizes inline and paged tool references by wire identity across object prototypes', async () => {
    for (const paged of [false, true]) {
      const transcriptsRoot = join(
        root,
        paged ? 'paged-reference' : 'inline-reference',
      );
      const bounded = withTargets(transcriptsRoot, {
        pageTargetBytes: 4 * 1024,
        manifestTargetBytes: 1_200,
        rowTargetBytes: paged ? 8 * 1024 : 128 * 1024,
      });
      const log = new TranscriptStreamStore(
        primaryTranscriptPaths(transcriptsRoot),
        bounded,
      );
      const blocks: PersistedChatBlock[] = [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'shell',
          output: 'body '.repeat(20000),
          isError: false,
        },
        ...(paged
          ? Array.from({ length: 8 }, (_, ordinal) => ({
              type: 'text' as const,
              text: String(ordinal),
              opaqueBlock: 'x'.repeat(2500),
            }))
          : []),
      ];
      await log.initialize('chat');
      await log.append('chat', [row(blocks)], undefined, undefined, 'format4');
      const stored = await log.readMessage('chat', 'row');
      if (!stored) throw new Error('Missing stored row');
      expect(stored.blocksRef !== undefined).toBe(paged);
      const block = stored.blocksRef
        ? (await bounded.readBlocks('chat', stored, 0, 1))[0]
        : stored.blocks[0];
      if (block?.type !== 'tool_result' || !block.fullOutputRef)
        throw new Error('Missing stored body');
      const reference = structuredClone(block.fullOutputRef);
      Object.setPrototypeOf(reference, null);
      await expect(
        log.ownsToolOutputReference('chat', 'row', 'call', reference),
      ).resolves.toBe(true);
      const suppliedReference = {
        ...block.fullOutputRef,
        transportHint: undefined,
      };
      await expect(
        log.ownsToolOutputReference('chat', 'row', 'call', suppliedReference),
      ).resolves.toBe(true);
      for (const foreign of [
        { ...reference, byteLength: reference.byteLength + 1 },
        { ...reference, sha256: '0'.repeat(64) },
        { ...reference, artifactId: `sha256-v1-${'0'.repeat(64)}` },
      ])
        await expect(
          log.ownsToolOutputReference('chat', 'row', 'call', foreign),
        ).resolves.toBe(false);
    }
  });

  it('reads only overlapping block pages and lets iteration stop before later artifacts', async () => {
    const bounded = withTargets(root, {
      pageTargetBytes: 64 * 1024,
      manifestTargetBytes: 1_200,
      rowTargetBytes: 64 * 1024,
    });
    const blocks: PersistedChatBlock[] = Array.from(
      { length: 100 },
      (_, index) => ({
        type: 'text' as const,
        text: `block-${index}`,
        opaqueBlock: 'x'.repeat(20 * 1024),
      }),
    );
    const stored = await bounded.externalize('chat', row(blocks), undefined, {
      kind: 'format4',
      final: true,
    });
    if (!stored.blocksRef) throw new Error('Expected a paged transcript row');

    const tree = await readBlockTree(
      bounded,
      'chat',
      stored.blocksRef.manifest,
    );
    expect(tree.pages.length).toBeGreaterThan(1);
    const unrelatedManifest = tree.manifests.find(
      ({ value }) => value.firstBlockOrdinal > 0,
    );
    const unrelatedPage = tree.pages.find(
      ({ firstBlockOrdinal }) => firstBlockOrdinal > 0,
    );
    if (!unrelatedManifest || !unrelatedPage)
      throw new Error('Expected unrelated nested block artifacts');
    await unlink(
      join(
        root,
        'tool-output',
        'chat',
        `${unrelatedManifest.reference.artifactId}.txt`,
      ),
    );
    await unlink(
      join(
        root,
        'tool-output',
        'chat',
        `${unrelatedPage.reference.artifactId}.txt`,
      ),
    );

    const expandBlocks = jest
      .spyOn(bounded, 'expandBlocks')
      .mockRejectedValue(new Error('Ordinal reads must not expand a row'));
    try {
      await expect(bounded.readBlocks('chat', stored, 0, 1)).resolves.toEqual(
        blocks.slice(0, 1),
      );

      const firstBlock: PersistedChatBlock[] = [];
      for await (const block of bounded.iterateBlocks('chat', stored)) {
        firstBlock.push(block);
        break;
      }
      expect(firstBlock).toEqual(blocks.slice(0, 1));
      expect(expandBlocks).not.toHaveBeenCalled();
    } finally {
      expandBlocks.mockRestore();
    }
  });

  it('reads paged body ranges and exact repeated tool-output ownership without expanding blocks', async () => {
    const transcriptsRoot = join(root, 'transcripts');
    const bounded = withTargets(transcriptsRoot, {
      pageTargetBytes: 4 * 1024,
      manifestTargetBytes: 1_200,
      rowTargetBytes: 8 * 1024,
    });
    const log = new TranscriptStreamStore(
      primaryTranscriptPaths(transcriptsRoot),
      bounded,
    );
    const output = 'repeated tool output\n'.repeat(5_000);
    const blocks: PersistedChatBlock[] = Array.from(
      { length: 8 },
      (_, index) => {
        if (index === 2 || index === 7)
          return {
            type: 'tool_result',
            toolUseId: index === 2 ? 'call-first' : 'call-second',
            toolName: 'shell',
            output,
            isError: false,
            opaqueBlock: 'y'.repeat(2_500),
          };
        return {
          type: 'text',
          text: `block-${index}`,
          opaqueBlock: 'y'.repeat(2_500),
        };
      },
    );
    await log.initialize('chat');
    await log.append(
      'chat',
      [row(blocks, { id: 'paged-output' })],
      undefined,
      undefined,
      'format4',
    );
    const stored = await log.readMessage('chat', 'paged-output');
    if (!stored?.blocksRef)
      throw new Error('Expected a stored paged transcript row');
    const tree = await readBlockTree(
      bounded,
      'chat',
      stored.blocksRef.manifest,
    );
    expect(tree.pages.length).toBeGreaterThan(1);
    const firstStored = (await bounded.readBlocks('chat', stored, 2, 1))[0];
    const secondStored = (await bounded.readBlocks('chat', stored, 7, 1))[0];
    if (
      firstStored?.type !== 'tool_result' ||
      secondStored?.type !== 'tool_result' ||
      !firstStored.fullOutputRef ||
      !secondStored.fullOutputRef
    )
      throw new Error('Expected repeated tool-output references');
    expect(secondStored.fullOutputRef).toEqual(firstStored.fullOutputRef);

    const expandBlocks = jest
      .spyOn(bounded, 'expandBlocks')
      .mockRejectedValue(new Error('Point reads must not expand a row'));
    try {
      await expect(
        log.ownsToolOutputReference(
          'chat',
          'paged-output',
          'call-first',
          firstStored.fullOutputRef,
        ),
      ).resolves.toBe(true);
      await expect(
        log.ownsToolOutputReference(
          'chat',
          'paged-output',
          'call-second',
          secondStored.fullOutputRef,
        ),
      ).resolves.toBe(true);
      await expect(
        log.ownsToolOutputReference(
          'chat',
          'paged-output',
          'wrong-call',
          firstStored.fullOutputRef,
        ),
      ).resolves.toBe(false);
      await expect(
        log.ownsToolOutputReference(
          'chat',
          'another-message',
          'call-second',
          secondStored.fullOutputRef,
        ),
      ).resolves.toBe(false);
      await expect(
        log.ownsToolOutputReference('chat', 'paged-output', 'call-second', {
          ...secondStored.fullOutputRef,
          byteLength: secondStored.fullOutputRef.byteLength + 1,
        }),
      ).resolves.toBe(false);

      const targetPage = tree.pages.find(
        ({ firstBlockOrdinal, blockCount }) =>
          firstBlockOrdinal <= 7 && 7 < firstBlockOrdinal + blockCount,
      );
      const unrelatedPage = tree.pages.find((page) => page !== targetPage);
      if (!targetPage || !unrelatedPage)
        throw new Error('Expected an unrelated page for the point read');
      await unlink(
        join(
          transcriptsRoot,
          'tool-output',
          'chat',
          `${unrelatedPage.reference.artifactId}.txt`,
        ),
      );
      await expect(
        log.readFieldRange(
          'chat',
          'paged-output',
          { blockOrdinal: 7, field: 'output' },
          0,
          30,
        ),
      ).resolves.toMatchObject({ text: output.slice(0, 30) });
      expect(expandBlocks).not.toHaveBeenCalled();
    } finally {
      expandBlocks.mockRestore();
    }
  });

  it('keeps first-tier reduction inline when the production row guard is sufficient', async () => {
    const input = row(
      Array.from({ length: 4 }, (_, index) =>
        toolResult(`output-${index} 🌲\n`.repeat(20_000), index),
      ),
      { opaqueRow: 'x'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 180 * 1024) },
    );
    const stored = await artifacts.externalize('chat', input, undefined, {
      kind: 'format4',
      final: true,
    });

    expect(stored.blocksRef).toBeUndefined();
    expect(stored.blocks).toHaveLength(4);
    expect(
      Buffer.byteLength(JSON.stringify(stored), 'utf8'),
    ).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
    for (const block of stored.blocks) {
      if (block.type !== 'tool_result') continue;
      expect(block.output).toContain('[Full output stored separately]');
      expect(block.output).not.toBe('');
    }
  });

  it('bounds a production-sized unbacked row without changing its logical blocks', async () => {
    const unbackedBlocks: PersistedChatBlock[] = Array.from(
      { length: 4_400 },
      (_, index) => ({
        type: 'text' as const,
        text: `${index}:` + 'u'.repeat(3_900),
        opaqueBlock: { index },
      }),
    );
    const maximumPreviewOutput = 'p'.repeat(TOOL_OUTPUT_INLINE_BYTES + 1);
    const referencedBlocks = Array.from({ length: 32 }, (_, index) =>
      toolResult(maximumPreviewOutput, 5_000 + index),
    );
    const blocks = [...unbackedBlocks, ...referencedBlocks];
    const input = row(blocks, { opaqueRow: { source: 'unbacked' } });
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeGreaterThan(
      MAX_TRANSCRIPT_ROW_BYTES,
    );

    const stringify = jest.spyOn(JSON, 'stringify');
    stringify.mockImplementation((value: unknown) => {
      if (isNonemptyTranscriptRow(value))
        throw new Error('Must not stringify the complete transcript row');
      return originalJsonStringify(value);
    });
    let stored: PersistedChatMessage;
    try {
      stored = await artifacts.externalize('chat', input, undefined, {
        kind: 'format4',
        final: true,
      });
    } finally {
      stringify.mockRestore();
    }

    if (!stored.blocksRef) throw new Error('Expected a paged transcript row');
    expect(stored.blocks).toEqual([]);
    expect(
      Buffer.byteLength(JSON.stringify(stored), 'utf8'),
    ).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
    const expanded = await artifacts.expandBlocks('chat', stored);
    expect(expanded.blocks).toHaveLength(blocks.length);
    expect(expanded.blocks.slice(0, unbackedBlocks.length)).toEqual(
      unbackedBlocks,
    );
    expect(Reflect.get(expanded, 'opaqueRow')).toEqual({ source: 'unbacked' });
    const expandedToolResults = expanded.blocks.filter(
      (block) => block.type === 'tool_result',
    );
    expect(expandedToolResults).toHaveLength(referencedBlocks.length);
    for (const block of expandedToolResults) {
      if (block.type !== 'tool_result') continue;
      expect(block.output).not.toBe('');
      expect(block.outputTruncated).toBe(true);
      expect(Buffer.byteLength(block.output, 'utf8')).toBeLessThan(4_096);
    }

    const rootManifestValue: unknown = JSON.parse(
      await readArtifact(artifacts, 'chat', stored.blocksRef.manifest),
    );
    if (!isTranscriptBlockManifest(rootManifestValue))
      throw new Error('Expected a valid production manifest');
    expect(rootManifestValue.blockCount).toBe(blocks.length);
    expect(rootManifestValue.entries.length).toBeGreaterThan(1);
    for (const entry of rootManifestValue.entries) {
      expect(entry.kind).toBe('page');
      expect(entry.reference.byteLength).toBeLessThanOrEqual(1024 * 1024);
    }
  }, 20_000);

  it('keeps first-tier previews and opaque block metadata in bounded nested pages', async () => {
    const budgeted = withTargets(root, {
      pageTargetBytes: 4_096,
      manifestTargetBytes: 1_200,
      rowTargetBytes: 20_000,
    });
    const blocks: PersistedChatBlock[] = [
      ...Array.from({ length: 240 }, (_, index) =>
        withLegacyExtension(
          {
            type: 'text' as const,
            text: `${index}:` + 'x'.repeat(500),
          },
          'opaqueBlock',
          { index, nested: ['preserve'] },
        ),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        toolResult(`output-${index} 🌲\n`.repeat(9_000), 300 + index),
      ),
    ];
    const input = row(blocks, {
      opaqueRow: { nested: ['row', { preserve: true }] },
    });

    const stored = await budgeted.externalize('chat', input, undefined, {
      kind: 'format4',
      final: true,
    });

    if (!stored.blocksRef) throw new Error('Expected nested block manifests');
    expect(stored.blocks).toEqual([]);
    const expanded = await budgeted.expandBlocks('chat', stored);
    expect(Reflect.get(expanded, 'opaqueRow')).toEqual(
      Reflect.get(input, 'opaqueRow'),
    );
    expect(expanded.blocks.slice(0, 240)).toEqual(blocks.slice(0, 240));
    const previews = expanded.blocks.filter(
      (block) => block.type === 'tool_result',
    );
    expect(previews).toHaveLength(5);
    for (let index = 0; index < previews.length; index += 1) {
      const block = previews[index];
      if (!block || block.type !== 'tool_result') continue;
      const expectedBlock = blocks[240 + index];
      if (!expectedBlock || expectedBlock.type !== 'tool_result')
        throw new Error('Expected a matching source tool result');
      expect(block.outputTruncated).toBe(true);
      expect(block.output).toContain('[Full output stored separately]');
      expect(block.output).not.toBe('');
      expect(Buffer.byteLength(block.output, 'utf8')).toBeLessThan(4_096);
      expect(Reflect.get(block, 'opaqueBlock')).toEqual(
        Reflect.get(expectedBlock, 'opaqueBlock'),
      );
    }

    const tree = await readBlockTree(
      artifacts,
      'chat',
      stored.blocksRef.manifest,
    );
    expect(tree.manifests.length).toBeGreaterThan(1);
    expect(tree.pages.length).toBeGreaterThan(2);
    expect(tree.manifests[0]?.value.blockCount).toBe(blocks.length);
    for (const manifest of tree.manifests) {
      expect(isTranscriptBlockManifest(manifest.value)).toBe(true);
      expect(
        manifest.value.entries.reduce(
          (count, entry) => count + entry.blockCount,
          0,
        ),
      ).toBe(manifest.value.blockCount);
      for (const entry of manifest.value.entries) {
        if (entry.kind === 'page') {
          expect(entry.blockCount).toBeGreaterThan(0);
          const page = tree.pages.find(
            (candidate) =>
              candidate.reference.artifactId === entry.reference.artifactId,
          );
          expect(page?.firstBlockOrdinal).toBe(entry.firstBlockOrdinal);
          expect(page?.blockCount).toBe(entry.blockCount);
        } else {
          const child = tree.manifests.find(
            (candidate) =>
              candidate.reference.artifactId === entry.reference.artifactId,
          );
          expect(child?.value.firstBlockOrdinal).toBe(entry.firstBlockOrdinal);
          expect(child?.value.blockCount).toBe(entry.blockCount);
        }
      }
      expect(manifest.reference.byteLength).toBeLessThanOrEqual(1_200);
    }
    for (const page of tree.pages) {
      expect(page.value.firstBlockOrdinal).toBe(page.firstBlockOrdinal);
      expect(page.value.blocks).toHaveLength(page.blockCount);
      expect(page.reference.byteLength).toBeLessThanOrEqual(4_096);
    }

    const closure: PersistedToolOutputReference[] = [];
    for await (const reference of budgeted.referenceClosure('chat', stored))
      closure.push(reference);
    const bodyReferences = transcriptBodyReferences(expanded).map(
      ({ reference }) => reference,
    );
    const expectedClosure = [
      ...tree.manifests.map(({ reference }) => reference),
      ...tree.pages.map(({ reference }) => reference),
      ...bodyReferences,
    ];
    expect(
      Array.from(new Set(closure.map(({ artifactId }) => artifactId))).sort(),
    ).toEqual(
      Array.from(
        new Set(expectedClosure.map(({ artifactId }) => artifactId)),
      ).sort(),
    );
  });

  it('computes deterministic page references in dry-run mode without publishing', async () => {
    const budgeted = withTargets(root, {
      pageTargetBytes: 1_024,
      manifestTargetBytes: 1_200,
      rowTargetBytes: 10_000,
    });
    const open = row(
      Array.from({ length: 35 }, (_, index) =>
        withLegacyExtension(
          {
            type: 'text' as const,
            text: `${index}:` + 'd'.repeat(400),
          },
          'opaqueBlock',
          { index },
        ),
      ),
      { opaqueRow: { dryRun: true } },
    );
    const rename = jest.spyOn(fsPromises, 'rename');

    const dryRun = await budgeted.externalize('chat', open, undefined, {
      kind: 'format4',
      final: true,
      dryRun: true,
    });
    const afterDryRun = await readdir(join(root, 'tool-output', 'chat')).catch(
      () => [],
    );
    expect(afterDryRun).toEqual([]);
    expect(rename).not.toHaveBeenCalled();
    rename.mockClear();
    const committed = await budgeted.externalize('chat', open, undefined, {
      kind: 'format4',
      final: true,
    });

    expect(rename).toHaveBeenCalled();
    expect(dryRun.blocksRef).toEqual(committed.blocksRef);
    expect(dryRun.blocks).toEqual(committed.blocks);
    rename.mockClear();
    expect(await budgeted.isFinalFormOf('chat', open, committed)).toBe(true);
    expect(rename).not.toHaveBeenCalled();
  });

  it('verifies without writes, rejects missing final references, and keeps committed legacy inline fields', async () => {
    const large = 'body '.repeat(Math.ceil((TOOL_OUTPUT_INLINE_BYTES + 1) / 5));
    const input = row([
      withLegacyExtension({ type: 'text', text: large }, 'opaqueBlock', 'keep'),
    ]);
    const rename = jest.spyOn(fsPromises, 'rename');

    await expect(
      artifacts.externalize('chat', input, undefined, {
        kind: 'format4-verify',
        final: true,
      }),
    ).rejects.toThrow('without a lossless artifact');
    expect(
      await readdir(join(root, 'tool-output', 'chat')).catch(() => []),
    ).toEqual([]);
    expect(rename).not.toHaveBeenCalled();

    await expect(
      artifacts.externalize('chat', input, undefined, {
        kind: 'format4-verify',
        final: true,
        committed: true,
      }),
    ).resolves.toEqual(input);

    const oversizedToolOutput = row([toolResult(large, 9)]);
    await expect(
      artifacts.externalize('chat', oversizedToolOutput, undefined, {
        kind: 'format4-verify',
        final: true,
        committed: true,
      }),
    ).rejects.toThrow('without a lossless artifact');
    expect(rename).not.toHaveBeenCalled();
  });

  it('verifies paged rows by identity for each format 4 finality and policy without publishing', async () => {
    const fixture = await pagedRow(artifacts, 'chat', [
      withLegacyExtension(
        { type: 'text', text: 'small verified field' },
        'opaqueBlock',
        { keep: true },
      ),
    ]);
    const policies: TranscriptFieldPolicy[] = [
      { kind: 'format4', final: true },
      { kind: 'format4', final: false },
      { kind: 'format4', final: true, dryRun: true },
      { kind: 'format4-verify', final: true },
      { kind: 'format4-verify', final: true, committed: true },
      { kind: 'format4-verify', final: false },
    ];
    const rename = jest.spyOn(fsPromises, 'rename');

    for (const policy of policies)
      expect(
        await artifacts.externalize('chat', fixture.message, undefined, policy),
      ).toBe(fixture.message);

    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects unbacked over-inline paged final fields unless committed, but never exempts tool output', async () => {
    const oversized = 't'.repeat(TOOL_OUTPUT_INLINE_BYTES + 1);
    const textFixture = await pagedRow(artifacts, 'chat', [
      { type: 'text', text: oversized },
    ]);
    const finalVerification: TranscriptFieldPolicy = {
      kind: 'format4-verify',
      final: true,
    };

    await expect(
      artifacts.externalize(
        'chat',
        textFixture.message,
        undefined,
        finalVerification,
      ),
    ).rejects.toThrow('without a lossless artifact');
    await expect(
      artifacts.externalize('chat', textFixture.message, undefined, {
        ...finalVerification,
        committed: true,
      }),
    ).resolves.toBe(textFixture.message);

    const outputFixture = await pagedRow(artifacts, 'chat', [
      toolResult(oversized, 44),
    ]);
    await expect(
      artifacts.externalize('chat', outputFixture.message, undefined, {
        ...finalVerification,
        committed: true,
      }),
    ).rejects.toThrow('without a lossless artifact');
  });

  it('tracks and rolls back every page and manifest artifact it creates', async () => {
    const budgeted = withTargets(root, {
      pageTargetBytes: 1_024,
      manifestTargetBytes: 1_200,
      rowTargetBytes: 1_000,
    });
    const created = new CreatedArtifacts();
    const input = row(
      Array.from({ length: 40 }, (_, index) => ({
        type: 'text' as const,
        text: `${index}:` + 'r'.repeat(500),
      })),
    );

    const stored = await budgeted.externalize('chat', input, created, {
      kind: 'format4',
      final: true,
    });

    expect(stored.blocksRef).toBeDefined();
    expect(created.size).toBeGreaterThan(1);
    expect(await readdir(join(root, 'tool-output', 'chat'))).not.toHaveLength(
      0,
    );
    await created.discard();
    expect(await readdir(join(root, 'tool-output', 'chat'))).toEqual([]);
  }, 20_000);

  it('honors cancellation before traversing a block manifest', async () => {
    const fixture = await pagedRow(artifacts, 'chat', [
      { type: 'text', text: 'cancel me' },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      artifacts.expandBlocks('chat', fixture.message, controller.signal),
    ).rejects.toThrow();
  });

  it('detects a recursive manifest reference without requiring a hash fixed point', async () => {
    const rootReference = await artifacts.put('chat', 'cycle seed');
    const manifest: TranscriptBlockManifest = {
      version: 1,
      kind: 'transcript-block-manifest',
      firstBlockOrdinal: 0,
      blockCount: 1,
      entries: [
        {
          kind: 'manifest',
          firstBlockOrdinal: 0,
          blockCount: 1,
          reference: rootReference,
        },
      ],
    };
    const readBlockArtifact = jest.spyOn(
      Object.getPrototypeOf(artifacts),
      'readBlockArtifact',
    );
    readBlockArtifact.mockResolvedValue(manifest);
    const cyclicRow = row([], {
      blocksRef: {
        version: 1,
        manifest: rootReference,
        blockCount: 1,
      },
    });

    await expect(artifacts.expandBlocks('chat', cyclicRow)).rejects.toThrow();
    expect(readBlockArtifact).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing page', 'missing'],
    ['damaged page', 'damaged'],
  ])('rejects a %s while expanding a row', async (_name, mode) => {
    const fixture = await pagedRow(artifacts, 'chat', [
      { type: 'text', text: 'integrity target' },
    ]);
    const pagePath = join(
      root,
      'tool-output',
      'chat',
      `${fixture.pageReference.artifactId}.txt`,
    );
    if (mode === 'missing') await unlink(pagePath);
    else await writeFile(pagePath, 'altered page body');

    await expect(
      artifacts.expandBlocks('chat', fixture.message),
    ).rejects.toThrow(/integrity|ENOENT|no such file/i);
  });

  it.each([
    [
      'wrong manifest kind',
      (reference: PersistedToolOutputReference): Record<string, unknown> => ({
        version: 1,
        kind: 'wrong-kind',
        firstBlockOrdinal: 0,
        blockCount: 1,
        entries: [
          {
            kind: 'page',
            firstBlockOrdinal: 0,
            blockCount: 1,
            reference,
          },
        ],
      }),
    ],
    [
      'wrong manifest version',
      (reference: PersistedToolOutputReference): Record<string, unknown> => ({
        version: 2,
        kind: 'transcript-block-manifest',
        firstBlockOrdinal: 0,
        blockCount: 1,
        entries: [
          {
            kind: 'page',
            firstBlockOrdinal: 0,
            blockCount: 1,
            reference,
          },
        ],
      }),
    ],
    [
      'manifest gap',
      (reference: PersistedToolOutputReference): Record<string, unknown> => ({
        version: 1,
        kind: 'transcript-block-manifest',
        firstBlockOrdinal: 0,
        blockCount: 2,
        entries: [
          {
            kind: 'page',
            firstBlockOrdinal: 1,
            blockCount: 1,
            reference,
          },
        ],
      }),
    ],
    [
      'manifest overlap',
      (reference: PersistedToolOutputReference): Record<string, unknown> => ({
        version: 1,
        kind: 'transcript-block-manifest',
        firstBlockOrdinal: 0,
        blockCount: 3,
        entries: [
          {
            kind: 'page',
            firstBlockOrdinal: 0,
            blockCount: 2,
            reference,
          },
          {
            kind: 'page',
            firstBlockOrdinal: 1,
            blockCount: 1,
            reference,
          },
        ],
      }),
    ],
    [
      'manifest count mismatch',
      (reference: PersistedToolOutputReference): Record<string, unknown> => ({
        version: 1,
        kind: 'transcript-block-manifest',
        firstBlockOrdinal: 0,
        blockCount: 2,
        entries: [
          {
            kind: 'page',
            firstBlockOrdinal: 0,
            blockCount: 1,
            reference,
          },
        ],
      }),
    ],
  ])('rejects a %s envelope', async (_name, makeManifest) => {
    const page = {
      version: 1,
      kind: 'transcript-block-page',
      firstBlockOrdinal: 0,
      blocks: [{ type: 'text', text: 'body' }],
    };
    const pageReference = await artifacts.put('chat', JSON.stringify(page));
    const malformed = makeManifest(pageReference);
    const manifestReference = await artifacts.put(
      'chat',
      JSON.stringify(malformed),
    );
    const message = row([], {
      blocksRef: {
        version: 1,
        manifest: manifestReference,
        blockCount: 1,
      },
    });

    await expect(artifacts.expandBlocks('chat', message)).rejects.toThrow();
  });

  it.each([
    [
      'wrong page kind',
      {
        version: 1,
        kind: 'wrong-kind',
        firstBlockOrdinal: 0,
        blocks: [{ type: 'text', text: 'body' }],
      },
    ],
    [
      'wrong page version',
      {
        version: 2,
        kind: 'transcript-block-page',
        firstBlockOrdinal: 0,
        blocks: [{ type: 'text', text: 'body' }],
      },
    ],
    [
      'page gap',
      {
        version: 1,
        kind: 'transcript-block-page',
        firstBlockOrdinal: 1,
        blocks: [{ type: 'text', text: 'body' }],
      },
    ],
    [
      'page count mismatch',
      {
        version: 1,
        kind: 'transcript-block-page',
        firstBlockOrdinal: 0,
        blocks: [
          { type: 'text', text: 'body' },
          { type: 'thinking', text: 'extra' },
        ],
      },
    ],
  ])('rejects a %s envelope', async (_name, page) => {
    const pageReference = await artifacts.put('chat', JSON.stringify(page));
    const manifest: TranscriptBlockManifest = {
      version: 1,
      kind: 'transcript-block-manifest',
      firstBlockOrdinal: 0,
      blockCount: 1,
      entries: [
        {
          kind: 'page',
          firstBlockOrdinal: 0,
          blockCount: 1,
          reference: pageReference,
        },
      ],
    };
    const manifestReference = await artifacts.put(
      'chat',
      encodeTranscriptBlockManifest(manifest),
    );
    const message = row([], {
      blocksRef: {
        version: 1,
        manifest: manifestReference,
        blockCount: 1,
      },
    });

    await expect(artifacts.expandBlocks('chat', message)).rejects.toThrow();
  });

  it('rejects legacy writes of a paged row without mutating the caller object', async () => {
    const fixture = await pagedRow(artifacts, 'chat', [
      { type: 'text', text: 'legacy is not block-page aware' },
    ]);
    const original = JSON.stringify(fixture.message);

    await expect(
      artifacts.externalize('chat', fixture.message),
    ).rejects.toThrow();
    expect(JSON.stringify(fixture.message)).toBe(original);
    const expanded = await artifacts.expandBlocks('chat', fixture.message);
    const reexternalized = await artifacts.externalize(
      'chat',
      expanded,
      undefined,
      { kind: 'format4', final: true },
    );
    expect(reexternalized.blocks).toEqual(expanded.blocks);
    expect(reexternalized.blocksRef).toBeUndefined();
    expect(JSON.stringify(fixture.message)).toBe(original);
  });

  it('rejects a single irreducible oversized block with the exact row-guard error', async () => {
    const created = new CreatedArtifacts();
    const input = row([
      withLegacyExtension(
        { type: 'text', text: 'small visible body' },
        'opaquePayload',
        'z'.repeat(MAX_TRANSCRIPT_ROW_BYTES + 1),
      ),
    ]);

    await expect(
      artifacts.externalize('chat', input, created, {
        kind: 'format4',
        final: true,
      }),
    ).rejects.toThrow('Transcript row exceeds maximum size');
    expect(created.size).toBe(0);
    expect(
      await readdir(join(root, 'tool-output', 'chat')).catch(() => []),
    ).toEqual([]);
  }, 20_000);

  it('validates blocksRef before accepting a desktop persisted message', () => {
    const reference = artifactReference();
    const blocksRef: TranscriptBlocksReference = {
      version: 1,
      manifest: reference,
      blockCount: 3,
    };
    const message = {
      id: 'paged',
      role: 'assistant',
      timestamp: 1,
      blocks: [],
      blocksRef,
    };

    expect(isTranscriptBlocksReference(blocksRef)).toBe(true);
    expect(isPersistedChatMessage(message)).toBe(true);
    expect(
      isPersistedChatMessage({
        id: 'inline',
        role: 'assistant',
        timestamp: 1,
        blocks: [],
      }),
    ).toBe(true);
    expect(isTranscriptBlocksReference(undefined)).toBe(false);
    expect(isTranscriptBlocksReference(null)).toBe(false);
    expect(isPersistedChatMessage({ ...message, blocksRef: undefined })).toBe(
      false,
    );
    expect(isPersistedChatMessage({ ...message, blocksRef: null })).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocks: [{ type: 'text', text: 'inline' }],
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, extra: true },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, version: 2 },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, blockCount: 0 },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, blockCount: -1 },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, blockCount: 1.5 },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, blockCount: Number.NaN },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, blockCount: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, manifest: { ...reference, sha256: 'bad' } },
      }),
    ).toBe(false);
    expect(
      isPersistedChatMessage({
        ...message,
        blocksRef: { ...blocksRef, manifest: { ...reference, extra: true } },
      }),
    ).toBe(false);
  });
});
