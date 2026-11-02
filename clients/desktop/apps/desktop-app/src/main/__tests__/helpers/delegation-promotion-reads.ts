import type { CanopyHandlerContext } from '@canopy/core-runtime';
import { createCoreChatReadAdapter } from '../../canopy-runtime/core-chat-read-adapter';
import type { ChatStateService } from '../../services/chat-state-service';
import {
  H_BODIES,
  H_CHAT,
  H_CONTROL,
  H_ID,
  H_INLINE,
  H_LOG,
  H_PROMPTS,
  H_SCOPE,
  hTarget,
} from './delegation-promotion-fixture';

export const H_CONTEXT: CanopyHandlerContext = {
  requestId: 'h-public-read',
  caller: {
    principalId: 'test',
    clientInstanceId: 'test',
    authorityId: 'local-desktop',
    interfaceKind: 'test',
    grants: ['core.chat.read'],
  },
  metadata: {},
  signal: new AbortController().signal,
};
export function hPublic(
  service: ChatStateService,
): ReturnType<typeof createCoreChatReadAdapter> {
  return createCoreChatReadAdapter({ getPort: () => service });
}
export function hRequest(
  id = H_ID,
  generation = 1,
): {
  scope: { workspaceId: string; worktreeId: string; chatId: string };
  target: ReturnType<typeof hTarget>;
} {
  return {
    scope: {
      workspaceId: H_SCOPE.projectId,
      worktreeId: H_SCOPE.worktreeId,
      chatId: H_CHAT,
    },
    target: hTarget(id, generation),
  };
}

interface ExpectedRow {
  id: string;
  blocks: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; input: string }
    | { type: 'tool_result'; output: string }
  )[];
  author?: { kind: 'user' };
  delivery?: 'steer' | 'follow_up';
  truncated?: true;
}

/** Literal fixture expectations, independent of the converter/reader. */
function expectedRows(id: string, generation: number): ExpectedRow[] {
  const blockId = `delegated-agent-${id}${generation === 1 ? '' : `-run-${generation}`}`;
  if (id === H_INLINE)
    return [
      {
        id: `${blockId}:inline-text`,
        blocks: [{ type: 'text', text: 'Inline 🌲\ud800' }],
        author: { kind: 'user' },
        delivery: 'steer',
      },
      {
        id: `${blockId}:inline-tool`,
        blocks: [
          { type: 'tool_use', input: 'in🌲\ud800' },
          { type: 'tool_result', output: 'out漢\udc00' },
        ],
        truncated: true,
      },
    ];
  if (id === H_LOG)
    return [
      {
        id: `${blockId}:log-text`,
        blocks: [{ type: 'text', text: 'Latest log 漢\ud800' }],
        author: { kind: 'user' },
        delivery: 'follow_up',
      },
      {
        id: `${blockId}:log-tool`,
        blocks: [
          { type: 'tool_use', input: 'log input 漢' },
          { type: 'tool_result', output: 'log output 🌲' },
        ],
      },
    ];
  const rows: ExpectedRow[] = [];
  if (generation > 1)
    rows.push({
      id: `${blockId}:${H_CONTROL[generation]}`,
      blocks: [{ type: 'text', text: H_PROMPTS[generation] ?? '' }],
      author: { kind: 'user' },
      delivery: 'follow_up',
    });
  rows.push({
    id: `${blockId}:body-${generation}`,
    blocks: [{ type: 'text', text: H_BODIES[generation] ?? '' }],
  });
  return rows;
}

export async function assertHRun(
  service: ChatStateService,
  id: string,
  generation: number,
  archive: { standaloneHistory?: true; archivedContainerId?: string } = {},
): Promise<void> {
  const handlers = hPublic(service);
  const request = { ...hRequest(id, generation), ...archive };
  const expected = expectedRows(id, generation);
  const rows: Array<
    Awaited<
      ReturnType<ChatStateService['getTranscriptPage']>
    >['messages'][number]
  > = [];
  let cursor: string | undefined;
  do {
    const page = await service.getTranscriptPage({
      ...H_SCOPE,
      chatId: H_CHAT,
      target: request.target,
      ...archive,
      ...(cursor ? { cursor } : {}),
    });
    if (id === H_INLINE || id === H_LOG) expect(page.runTruncated).toBe(true);
    else expect(page).not.toHaveProperty('runTruncated');
    rows.unshift(...page.messages);
    cursor = page.cursor;
  } while (cursor);
  expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
  expect(
    (
      await handlers['core.chat.transcript.page'](request, H_CONTEXT)
    ).messages.map((row) => row.id),
  ).toEqual(expected.map((row) => row.id));
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const wanted = expected[index];
    if (!wanted || !row) throw new Error('Unexpected H row');
    expect(row).toMatchObject({
      id: wanted.id,
      role: wanted.author?.kind === 'user' ? 'user' : 'assistant',
      parentBlockId: `delegated-agent-${id}${generation === 1 ? '' : `-run-${generation}`}`,
      ...(wanted.author
        ? {
            delegationAuthor: wanted.author,
            delegationDelivery: wanted.delivery,
          }
        : {}),
      ...(wanted.truncated ? { truncated: true } : {}),
    });
    if (!wanted.truncated) expect(row).not.toHaveProperty('truncated');
    if (!wanted.author) {
      expect(row).not.toHaveProperty('delegationAuthor');
      expect(row).not.toHaveProperty('delegationDelivery');
    }
    const blocks = await handlers['core.chat.transcript.blocks.page'](
      { ...request, messageId: row.id, limit: 1 },
      H_CONTEXT,
    );
    // These reads request raw blocks, never the bounded projection.
    if (!('blocks' in blocks)) throw new Error('Expected a raw block page');
    if (id === H_INLINE || id === H_LOG) expect(blocks.runTruncated).toBe(true);
    const logical = [...blocks.blocks];
    let blockCursor = blocks.cursor;
    while (blockCursor) {
      const next = await handlers['core.chat.transcript.blocks.page'](
        { ...request, messageId: row.id, limit: 1, cursor: blockCursor },
        H_CONTEXT,
      );
      if (!('blocks' in next)) throw new Error('Expected a raw block page');
      logical.push(...next.blocks);
      blockCursor = next.cursor;
    }
    expect(logical).toHaveLength(wanted.blocks.length);
    for (let ordinal = 0; ordinal < wanted.blocks.length; ordinal++) {
      const block = wanted.blocks[ordinal];
      if (!block) throw new Error('Missing expected H block');
      expect(logical[ordinal]).toMatchObject(block);
      expect(logical[ordinal]).not.toHaveProperty('fullTextRef');
      expect(logical[ordinal]).not.toHaveProperty('fullInputRef');
      expect(logical[ordinal]).not.toHaveProperty('fullOutputRef');
      const field =
        block.type === 'text'
          ? 'text'
          : block.type === 'tool_use'
            ? 'input'
            : 'output';
      const text =
        block.type === 'text'
          ? block.text
          : block.type === 'tool_use'
            ? block.input
            : block.output;
      if (id === H_ID && generation >= 4) {
        // Small stream fields have no full-body reference. Unlike the legacy
        // adapter, stream reads intentionally refuse those inline ranges.
        await expect(
          handlers['core.chat.content.read'](
            {
              ...request,
              messageId: row.id,
              blockOrdinal: ordinal,
              field,
              offset: 0,
              limit: 4096,
            },
            H_CONTEXT,
          ),
        ).rejects.toThrow('Transcript field has no stored body for this row');
        continue;
      }
      const content = await handlers['core.chat.content.read'](
        {
          ...request,
          messageId: row.id,
          blockOrdinal: ordinal,
          field,
          offset: 0,
          limit: 4096,
        },
        H_CONTEXT,
      );
      expect(content.text).toBe(text);
      if (id === H_INLINE || id === H_LOG)
        expect(content.runTruncated).toBe(true);
      const prefix = await handlers['core.chat.content.read'](
        {
          ...request,
          messageId: row.id,
          blockOrdinal: ordinal,
          field,
          offset: 0,
          limit: 4,
        },
        H_CONTEXT,
      );
      expect(prefix.text.length).toBeGreaterThan(0);
      expect(text.startsWith(prefix.text)).toBe(true);
    }
  }
}

export async function assertHLegacyReads(
  service: ChatStateService,
): Promise<void> {
  await assertHRun(service, H_INLINE, 1);
  await assertHRun(service, H_LOG, 1);
  for (const generation of [1, 2, 3])
    await assertHRun(service, H_ID, generation);
}
