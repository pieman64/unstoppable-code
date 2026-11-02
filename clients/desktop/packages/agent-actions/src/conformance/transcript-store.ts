import type {
  CoreChatContentReadResult,
  CoreChatTranscriptBoundedBlocksPageResult,
} from '@canopy/protocol/canopy-core';
import type { AgentTranscriptReadTarget } from '../families/transcript-read/actions';
import { AgentPortError } from '../port/environment-port';
import type {
  AgentTranscriptBlocksInput,
  AgentTranscriptContentInput,
  AgentTranscriptPageInput,
  AgentTranscriptReadOwner,
} from '../port/transcript-read-port';
import type { ConformanceWorld } from './world';

type FixtureRow = ConformanceWorld['transcript']['rows'][number];
export interface ConformanceTranscriptPage {
  messages: (FixtureRow & { blocksOmitted?: { blockCount: number } })[];
  totalMessages: number;
  transcriptRevision: number;
  cursor?: string;
}
interface RawBlocksPage {
  messageId: string;
  firstBlockOrdinal: number;
  blocks: FixtureRow['blocks'];
  blockCount: number;
  transcriptRevision: number;
  nextBlockOrdinal?: number;
  cursor?: string;
}
export interface ConformanceTranscriptStore {
  readCount(): number;
  page(
    input: AgentTranscriptPageInput,
    owner: AgentTranscriptReadOwner,
  ): ConformanceTranscriptPage;
  content(
    input: AgentTranscriptContentInput,
    owner: AgentTranscriptReadOwner,
  ): CoreChatContentReadResult;
  blocks(
    input: AgentTranscriptBlocksInput,
    owner: AgentTranscriptReadOwner,
  ): CoreChatTranscriptBoundedBlocksPageResult;
  rawBlocks(
    input: AgentTranscriptBlocksInput,
    owner: AgentTranscriptReadOwner,
  ): RawBlocksPage;
}
let storeSequence = 0;

function targetKey(target: AgentTranscriptReadTarget): string {
  return JSON.stringify(
    target.kind === 'delegation'
      ? [target.kind, target.chatId, target.delegationId, target.runGeneration]
      : [target.kind, target.chatId],
  );
}

type CursorKind = 'rows' | 'blocks' | 'raw-blocks';
interface Cursor {
  kind: CursorKind;
  target: string;
  messageId?: string;
  position: number;
  revision: number;
}

/** A neutral retained-run backend. Cursors are opaque, per-store capabilities, not grants. */
export function createConformanceTranscriptStore(
  world: ConformanceWorld,
): ConformanceTranscriptStore {
  const storeId = ++storeSequence;
  const fixture = world.transcript;
  const cursors = new Map<string, Cursor>();
  let reads = 0;
  const invalidCursor = (): never => {
    throw new AgentPortError('invalid_target', 'Restart without a cursor.');
  };
  const validate = (
    target: AgentTranscriptReadTarget,
    owner: AgentTranscriptReadOwner,
  ): void => {
    const chat = world.chats.find((row) => row.chatId === target.chatId);
    if (
      !chat ||
      owner.scope.workspaceId !== world.workspace.workspaceId ||
      owner.scope.worktreeId !== chat.worktreeId ||
      owner.scope.chatId !== target.chatId ||
      targetKey(target) !== targetKey(fixture.target)
    )
      throw new AgentPortError('not_found', 'Retained run not found.');
  };
  const nextCursor = (cursor: Cursor): string => {
    const token = `opaque-retained-${storeId}-${cursors.size + 1}`;
    cursors.set(token, cursor);
    return token;
  };
  const position = (
    kind: CursorKind,
    target: AgentTranscriptReadTarget,
    messageId: string | undefined,
    cursor: string | undefined,
    initial: number,
  ): number => {
    if (cursor === undefined) return initial;
    const stored = cursors.get(cursor);
    if (
      !stored ||
      stored.kind !== kind ||
      stored.target !== targetKey(target) ||
      stored.messageId !== messageId ||
      stored.revision !== fixture.revision
    )
      return invalidCursor();
    return stored.position;
  };
  const rowFor = (messageId: string): FixtureRow => {
    const row = fixture.rows.find((entry) => entry.id === messageId);
    if (!row) throw new AgentPortError('not_found', 'Retained row not found.');
    return row;
  };
  const page = (
    input: AgentTranscriptPageInput,
    owner: AgentTranscriptReadOwner,
  ): ConformanceTranscriptPage => {
    const end = position(
      'rows',
      input.target,
      undefined,
      input.cursor,
      fixture.rows.length,
    );
    validate(input.target, owner);
    const start = Math.max(0, end - fixture.pageSize);
    reads += 1;
    const messages = fixture.rows.slice(start, end).map((row) => {
      if (row.blocks.length <= fixture.blockPageSize) return row;
      return {
        ...row,
        blocks: [],
        blocksOmitted: { blockCount: row.blocks.length },
      };
    });
    return {
      messages,
      totalMessages: fixture.rows.length,
      transcriptRevision: fixture.revision,
      ...(start > 0
        ? {
            cursor: nextCursor({
              kind: 'rows',
              target: targetKey(input.target),
              position: start,
              revision: fixture.revision,
            }),
          }
        : {}),
    };
  };
  const content = (
    input: AgentTranscriptContentInput,
    owner: AgentTranscriptReadOwner,
  ): CoreChatContentReadResult => {
    validate(input.target, owner);
    const block = rowFor(input.messageId).blocks[input.blockOrdinal];
    if (!block || input.field !== 'text')
      throw new AgentPortError('not_found', 'Field not found.');
    const bytes = new TextEncoder().encode(block.text);
    if (input.offset > bytes.length || (bytes[input.offset] & 0xc0) === 0x80)
      throw new AgentPortError('invalid_target', 'Invalid byte offset.');
    let end = Math.min(bytes.length, input.offset + input.limit);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    reads += 1;
    return {
      text: new TextDecoder().decode(bytes.slice(input.offset, end)),
      byteLength: bytes.length,
      ...(end < bytes.length ? { nextOffset: end } : {}),
    };
  };
  const blockSlice = (
    input: AgentTranscriptBlocksInput,
    owner: AgentTranscriptReadOwner,
    kind: CursorKind,
  ): RawBlocksPage => {
    const first = position(
      kind,
      input.target,
      input.messageId,
      input.cursor,
      input.firstBlockOrdinal ?? 0,
    );
    validate(input.target, owner);
    const row = rowFor(input.messageId);
    const end = Math.min(
      row.blocks.length,
      first + Math.min(input.limit, fixture.blockPageSize),
    );
    reads += 1;
    return {
      messageId: row.id,
      firstBlockOrdinal: first,
      blocks: row.blocks.slice(first, end),
      blockCount: row.blocks.length,
      transcriptRevision: fixture.revision,
      ...(end < row.blocks.length
        ? {
            nextBlockOrdinal: end,
            cursor: nextCursor({
              kind,
              target: targetKey(input.target),
              messageId: row.id,
              position: end,
              revision: fixture.revision,
            }),
          }
        : {}),
    };
  };
  return {
    readCount: (): number => reads,
    page,
    content,
    blocks: (
      input: AgentTranscriptBlocksInput,
      owner: AgentTranscriptReadOwner,
    ): CoreChatTranscriptBoundedBlocksPageResult => {
      const { blocks, ...rest } = blockSlice(input, owner, 'blocks');
      return {
        ...rest,
        projection: 'bounded-v1',
        entries: blocks.map((block, index) => ({
          kind: 'block',
          ordinal: rest.firstBlockOrdinal + index,
          block,
        })),
      };
    },
    rawBlocks: (
      input: AgentTranscriptBlocksInput,
      owner: AgentTranscriptReadOwner,
    ): RawBlocksPage => blockSlice(input, owner, 'raw-blocks'),
  };
}
