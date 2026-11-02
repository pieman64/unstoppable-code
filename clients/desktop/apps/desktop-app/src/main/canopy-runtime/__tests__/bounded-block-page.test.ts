import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTranscriptArtifacts } from '../../lib/chat-transcript-artifacts';
import {
  encodeChatTranscriptReadCursor,
  decodeChatTranscriptReadCursor,
} from '../../lib/chat-transcript-read-cursor';
import type { PersistedChatBlock } from '@canopy/agent-transcript';
import type {
  ChatTranscriptBlocksRequest,
  ChatTranscriptBlocksPage,
} from '@canopy/desktop-shared/types';
import {
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES,
  TRANSCRIPT_READ_WRAPPER_BYTES,
} from '@canopy/protocol/canopy-core';
import { fitBoundedBlockPage } from '../bounded-block-page';

const request: ChatTranscriptBlocksRequest = {
  projectId: 'p'.repeat(256),
  worktreeId: 'w'.repeat(256),
  chatId: 'c'.repeat(256),
  messageId: 'm'.repeat(512),
  limit: 512,
};

function reader(
  blocks: PersistedChatBlock[],
): jest.Mock<Promise<ChatTranscriptBlocksPage>, [ChatTranscriptBlocksRequest]> {
  return jest.fn(
    (input: ChatTranscriptBlocksRequest): Promise<ChatTranscriptBlocksPage> => {
      const start =
        input.cursor === undefined
          ? (input.firstBlockOrdinal ?? 0)
          : Number(input.cursor.split(':')[0]);
      const end = Math.min(start + input.limit, blocks.length);
      return Promise.resolve({
        messageId: input.messageId,
        firstBlockOrdinal: start,
        blocks: blocks.slice(start, end),
        blockCount: blocks.length,
        transcriptRevision: Number.MAX_SAFE_INTEGER,
        runTruncated: true as const,
        ...(end < blocks.length
          ? { nextBlockOrdinal: end, cursor: `${end}:`.padEnd(2048, 'c') }
          : {}),
      });
    },
  );
}

describe('bounded block fitter', () => {
  it('uses three reads for a 46-block row stopped inside its second batch', async () => {
    const read = reader(
      Array.from({ length: 46 }, () => ({
        type: 'compaction_info',
        timestamp: 1,
        provider: 'claude',
        interfaceMode: 'canopy',
        summary: 'm'.repeat(30000),
      })),
    );
    const parse = jest.spyOn(
      CoreChatTranscriptBoundedBlocksPageResultSchema,
      'parse',
    );
    try {
      const page = await fitBoundedBlockPage(request, read);
      expect(page.entries).toHaveLength(26);
      expect(page.nextBlockOrdinal).toBe(26);
      expect(read.mock.calls.map(([input]) => input.limit)).toEqual([
        16, 16, 10,
      ]);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(page.cursor).toMatch(/^26:/);
      const next = await fitBoundedBlockPage(
        { ...request, cursor: page.cursor, limit: 1 },
        read,
      );
      expect(next.entries[0]?.ordinal).toBe(26);
    } finally {
      parse.mockRestore();
    }
  });

  it.each(['revision', 'count', 'ordinal'])(
    'rejects a cross-batch %s change as stale',
    async (change) => {
      const read = reader(
        Array.from({ length: 46 }, () => ({ type: 'text', text: 'short' })),
      );
      const original = read.getMockImplementation();
      if (!original) throw new Error('Missing reader');
      read.mockImplementation(async (input) => {
        const page = await original(input);
        if (input.cursor !== undefined) {
          if (change === 'revision') page.transcriptRevision = 2;
          if (change === 'count') page.blockCount = 47;
          if (change === 'ordinal') page.firstBlockOrdinal += 1;
        }
        return page;
      });
      await expect(fitBoundedBlockPage(request, read)).rejects.toThrow(
        'Stale transcript blocks cursor',
      );
    },
  );

  it('rejects a revision change during the shortened cursor reread', async () => {
    const read = reader(
      Array.from({ length: 46 }, () => ({
        type: 'compaction_info',
        timestamp: 1,
        provider: 'claude',
        interfaceMode: 'canopy',
        summary: 'm'.repeat(30000),
      })),
    );
    const original = read.getMockImplementation();
    if (!original) throw new Error('Missing reader');
    read.mockImplementation(async (input) => {
      const page = await original(input);
      if (input.limit === 10) page.transcriptRevision = 2;
      return page;
    });
    await expect(fitBoundedBlockPage(request, read)).rejects.toThrow(
      'Stale transcript blocks cursor',
    );
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('uses no cursor reread at an exact batch boundary', async () => {
    const read = reader(
      Array.from({ length: 46 }, () => ({ type: 'text', text: 'short' })),
    );
    const page = await fitBoundedBlockPage({ ...request, limit: 16 }, read);
    expect(page.entries).toHaveLength(16);
    expect(page.nextBlockOrdinal).toBe(16);
    expect(read.mock.calls.map(([input]) => input.limit)).toEqual([16]);
  });

  it('reuses the previous batch cursor when its next first entry exceeds the budget', async () => {
    const read = reader(
      Array.from({ length: 46 }, () => ({
        type: 'compaction_info',
        timestamp: 1,
        provider: 'claude',
        interfaceMode: 'canopy',
        summary: 'm'.repeat(48700),
      })),
    );
    const page = await fitBoundedBlockPage(request, read);
    expect(page.entries).toHaveLength(16);
    expect(page.nextBlockOrdinal).toBe(16);
    expect(page.cursor).toMatch(/^16:/);
    expect(read.mock.calls.map(([input]) => input.limit)).toEqual([16, 16]);
  });

  it('reaches the true end in three reads and reads an empty end once', async () => {
    const read = reader(
      Array.from({ length: 46 }, () => ({ type: 'text', text: 'short' })),
    );
    const page = await fitBoundedBlockPage(request, read);
    expect(page.entries).toHaveLength(46);
    expect(page.cursor).toBeUndefined();
    expect(page.nextBlockOrdinal).toBeUndefined();
    expect(read.mock.calls.map(([input]) => input.limit)).toEqual([16, 16, 16]);
    read.mockClear();
    const end = await fitBoundedBlockPage(
      { ...request, firstBlockOrdinal: 46 },
      read,
    );
    expect(end.entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('measures escaped final JSON with maximum message id/cursor and continues exactly', async () => {
    const blocks: PersistedChatBlock[] = Array.from({ length: 512 }, () => ({
      type: 'tool_use',
      toolUseId: 't'.repeat(512),
      toolName: 'shell',
      input: '"\\\n\u0000'.repeat(1000),
    }));
    const read = reader(blocks);
    const first = await fitBoundedBlockPage(request, read);
    expect(first.entries).toHaveLength(62);
    expect(first.nextBlockOrdinal).toBe(62);
    expect(first.cursor).toMatch(/^62:/);
    expect(
      CoreChatTranscriptBoundedBlocksPageResultSchema.safeParse(first).success,
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBe(784865);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES,
    );
    // renderer-relay/relay.ts returns this exact successful invoke envelope.
    expect(Buffer.byteLength(JSON.stringify({ ok: true, value: first }))).toBe(
      784885,
    );
    expect(
      Buffer.byteLength(JSON.stringify({ ok: true, value: first })),
    ).toBeLessThanOrEqual(TRANSCRIPT_READ_WRAPPER_BYTES);
    const second = await fitBoundedBlockPage(
      { ...request, cursor: first.cursor },
      read,
    );
    expect(second.firstBlockOrdinal).toBe(62);
    expect(second.entries[0]?.ordinal).toBe(62);
    expect(read.mock.calls.every(([input]) => input.limit <= 16)).toBe(true);
  });

  it('pages physical blocksRef storage in small batches and accepts its true end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bounded-block-artifacts-'));
    try {
      const artifacts = new ChatTranscriptArtifacts(root, false, {
        rowTargetBytes: 1000,
        pageTargetBytes: 3000,
        manifestTargetBytes: 3000,
      });
      const row = await artifacts.externalize(
        'chat',
        {
          id: 'row',
          role: 'assistant',
          timestamp: 1,
          blocks: Array.from({ length: 3 }, () => ({
            type: 'text',
            text: 'x'.repeat(2000),
          })),
        },
        undefined,
        { kind: 'format4', final: true },
      );
      expect(row.blocksRef).toBeDefined();
      const base = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        messageId: 'row',
        limit: 1,
      };
      const read = jest.fn(async (input: ChatTranscriptBlocksRequest) => {
        const first =
          input.cursor === undefined
            ? (input.firstBlockOrdinal ?? 0)
            : decodeChatTranscriptReadCursor(
                input.cursor,
                'blocks',
                base,
                'row',
              ).position;
        const blocks = await artifacts.readBlocks(
          'chat',
          row,
          first,
          input.limit,
        );
        const end = first + blocks.length;
        return {
          messageId: 'row',
          firstBlockOrdinal: first,
          blocks,
          blockCount: 3,
          transcriptRevision: 1,
          ...(end < 3
            ? {
                nextBlockOrdinal: end,
                cursor: encodeChatTranscriptReadCursor(base, {
                  kind: 'blocks',
                  revision: 1,
                  position: end,
                  messageId: 'row',
                }),
              }
            : {}),
        };
      });
      const first = await fitBoundedBlockPage(base, read);
      expect(first.entries).toEqual([
        {
          kind: 'block',
          ordinal: 0,
          block: { type: 'text', text: 'x'.repeat(2000) },
        },
      ]);
      expect(first.nextBlockOrdinal).toBe(1);
      const next = await fitBoundedBlockPage(
        { ...base, cursor: first.cursor, limit: 2 },
        read,
      );
      expect(next.entries.map((entry) => entry.ordinal)).toEqual([1, 2]);
      expect(next.cursor).toBeUndefined();
      const end = await fitBoundedBlockPage(
        { ...base, firstBlockOrdinal: 3 },
        read,
      );
      expect(end.entries).toEqual([]);
      expect(read.mock.calls.every(([input]) => input.limit <= 16)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not set loss flags while cutting display fields or leak nested references', async () => {
    const read = reader([
      { type: 'text', text: 'a'.repeat(4001) },
      {
        type: 'tool_use',
        toolUseId: 'call',
        toolName: 'shell',
        input: 'whole',
        inputRef: {
          version: 1,
          artifactId: 'a'.repeat(64),
          byteLength: 5,
          encoding: 'utf-8',
          sha256: 'b'.repeat(64),
          mediaType: 'text/plain',
        },
      },
    ]);
    const result = await fitBoundedBlockPage({ ...request, limit: 1 }, read);
    expect(result.entries).toEqual([
      {
        kind: 'preview',
        ordinal: 0,
        block: { type: 'text', text: 'a'.repeat(4000) },
        omittedFields: ['text'],
      },
    ]);
    expect(result).not.toHaveProperty('truncated');
    expect(result.runTruncated).toBe(true);
    const last = await fitBoundedBlockPage(
      { ...request, cursor: result.cursor },
      read,
    );
    expect(last.entries).toEqual([
      {
        kind: 'preview',
        ordinal: 1,
        block: {
          type: 'tool_use',
          toolUseId: 'call',
          toolName: 'shell',
          input: 'whole',
        },
        omittedFields: ['input'],
      },
    ]);
    expect(last.cursor).toBeUndefined();
    expect(last.nextBlockOrdinal).toBeUndefined();
    const end = await fitBoundedBlockPage(
      { ...request, firstBlockOrdinal: 2 },
      read,
    );
    expect(end.entries).toEqual([]);
    expect(end.firstBlockOrdinal).toBe(2);
  });
});
