import {
  PORTAL_COMMAND_TYPES,
  PORTAL_SMALL_RPC_COMMAND_TYPES,
  PortalChatContentReadPayloadSchema,
  PortalChatContentReadV2PayloadSchema,
  PortalChatTranscriptBlocksPagePayloadSchema,
  PortalChatTranscriptPagePayloadSchema,
  PortalTranscriptReadReplySchema,
  transcriptReadFailure,
} from '../index';

const target = {
  kind: 'delegation',
  chatId: 'chat-1',
  delegationId: 'delegation-1',
  runGeneration: 2,
} as const;
const worktree = {
  kind: 'worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
} as const;
const standalone = {
  kind: 'standalone',
  projectLocalId: 'project-1',
  chatId: 'chat-1',
} as const;
const content = {
  source: worktree,
  target,
  messageId: 'row-7',
  blockOrdinal: 3,
  field: 'output',
  offset: 0,
  limit: 65_536,
} as const;

describe('Portal transcript read commands', () => {
  it('registers every read as a small RPC command', () => {
    for (const type of [
      'portal.chat.transcript.page',
      'portal.chat.transcript.blocks.page',
      'portal.chat.content.read',
    ] as const) {
      expect(PORTAL_COMMAND_TYPES).toContain(type);
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(type)).toBe(true);
    }
  });

  it('accepts a delegation page for a worktree or standalone source', () => {
    expect(
      PortalChatTranscriptPagePayloadSchema.safeParse({
        source: worktree,
        target,
      }).success,
    ).toBe(true);
    expect(
      PortalChatTranscriptPagePayloadSchema.safeParse({
        source: { ...worktree, archivedContainerId: 'worktree-1' },
        target,
        cursor: 'opaque',
      }).success,
    ).toBe(true);
    expect(
      PortalChatTranscriptPagePayloadSchema.safeParse({
        source: standalone,
        target,
      }).success,
    ).toBe(true);
  });

  it('rejects primary targets, foreign target chats and mixed sources', () => {
    const page = PortalChatTranscriptPagePayloadSchema;
    const primary = page.safeParse({
      source: worktree,
      target: { kind: 'primary', chatId: 'chat-1' },
    });
    expect(primary.success).toBe(false);
    expect(JSON.stringify(primary.error?.issues)).toContain('target');
    const foreign = page.safeParse({
      source: worktree,
      target: { ...target, chatId: 'chat-2' },
    });
    expect(foreign.error?.issues[0]?.message).toBe(
      'The read target must belong to the source chat.',
    );
    expect(
      page.safeParse({
        source: { ...standalone, worktreeId: 'worktree-1' },
        target,
      }).success,
    ).toBe(false);
    expect(
      page.safeParse({ source: worktree, target, extra: true }).success,
    ).toBe(false);
  });

  it('bounds content reads to one field range', () => {
    const schema = PortalChatContentReadPayloadSchema;
    expect(schema.safeParse(content).success).toBe(true);
    expect(schema.safeParse({ ...content, limit: 65_537 }).success).toBe(false);
    expect(schema.safeParse({ ...content, limit: 3 }).success).toBe(false);
    expect(schema.safeParse({ ...content, field: 'digest' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...content, blockOrdinal: -1 }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...content, target: { ...target, chatId: 'chat-2' } })
        .success,
    ).toBe(false);
  });

  it('keeps v1 content reads to stored delegation fields', () => {
    const schema = PortalChatContentReadPayloadSchema;
    expect(
      schema.safeParse({
        ...content,
        target: { kind: 'primary', chatId: 'chat-1' },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...content, fieldSource: 'logical' }).success,
    ).toBe(false);
  });

  it('adds primary targets and logical fields in v2', () => {
    const schema = PortalChatContentReadV2PayloadSchema;
    expect(schema.safeParse(content).success).toBe(true);
    expect(
      schema.safeParse({
        ...content,
        source: standalone,
        target: { kind: 'primary', chatId: 'chat-1' },
        fieldSource: 'logical',
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...content,
        target: { kind: 'primary', chatId: 'chat-2' },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...content, fieldSource: 'inline' }).success,
    ).toBe(false);
  });

  it("pages a delegation row's blocks from a position or a cursor", () => {
    const schema = PortalChatTranscriptBlocksPagePayloadSchema;
    const blocks = { source: worktree, target, messageId: 'row-7', limit: 64 };
    expect(schema.safeParse(blocks).success).toBe(true);
    expect(
      schema.safeParse({ ...blocks, firstBlockOrdinal: 4, limit: 512 }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...blocks, cursor: 'opaque' }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...blocks, cursor: 'opaque', firstBlockOrdinal: 4 },
      { ...blocks, limit: 0 },
      { ...blocks, limit: 513 },
      { ...blocks, target: { kind: 'primary', chatId: 'chat-1' } },
      { ...blocks, target: { ...target, chatId: 'chat-2' } },
      // The desktop always answers in the bounded projection.
      { ...blocks, projection: 'bounded-v1' },
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
  });
});

describe('Portal transcript read reply', () => {
  it('carries a value or a closed failure reason, nothing else', () => {
    const reply = PortalTranscriptReadReplySchema;
    expect(reply.safeParse({ ok: true, value: { messages: [] } }).success).toBe(
      true,
    );
    expect(reply.safeParse({ ok: false, reason: 'stale' }).success).toBe(true);
    expect(reply.safeParse({ ok: false, reason: 'busy' }).success).toBe(false);
    expect(
      reply.safeParse({ ok: false, reason: 'failed', message: '/Users/x' })
        .success,
    ).toBe(false);
  });

  it('maps core error payloads to reasons', () => {
    expect(
      transcriptReadFailure({
        kind: 'failed_precondition',
        code: 'core.chat.transcript.page.staleCursor',
      }),
    ).toBe('stale');
    expect(
      transcriptReadFailure({
        kind: 'failed_precondition',
        code: 'core.chat.transcript.blocks.page.staleCursor',
      }),
    ).toBe('stale');
    expect(transcriptReadFailure({ kind: 'failed_precondition' })).toBe(
      'failed',
    );
    expect(transcriptReadFailure({ kind: 'unavailable' })).toBe('unavailable');
    expect(transcriptReadFailure({ kind: 'capability_unavailable' })).toBe(
      'unavailable',
    );
    expect(transcriptReadFailure({ kind: 'not_found' })).toBe('failed');
    expect(transcriptReadFailure('boom')).toBe('failed');
    expect(transcriptReadFailure(null)).toBe('failed');
  });
});
