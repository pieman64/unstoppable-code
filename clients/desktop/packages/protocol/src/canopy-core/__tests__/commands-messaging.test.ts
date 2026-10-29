import {
  CoreChatCommandReceiptSchema,
  CoreChatMessageSendParamsSchema,
  CoreChatQueueEntryCancelParamsSchema,
  CoreChatQueueEntryForceParamsSchema,
  CoreChatQueueEntryUpdateParamsSchema,
} from '../core/chat/commands-messaging';

const base = {
  scope: { workspaceId: 'project', worktreeId: 'worktree' },
  commandId: 'command-1',
  _meta: { idempotencyKey: 'command-1' },
  chatId: 'chat-1',
};

describe('chat message command contracts', () => {
  it('requires keyed metadata in every messaging parameter schema', () => {
    const { _meta, ...withoutMetadata } = base;
    void _meta;
    for (const [schema, fields] of [
      [
        CoreChatMessageSendParamsSchema,
        { messageId: 'message-1', text: 'Hello' },
      ],
      [CoreChatQueueEntryCancelParamsSchema, { entryId: 'entry-1' }],
      [CoreChatQueueEntryForceParamsSchema, { entryId: 'entry-1' }],
      [
        CoreChatQueueEntryUpdateParamsSchema,
        { entryId: 'entry-1', mutation: { kind: 'steer' } },
      ],
    ] as const) {
      expect(schema.safeParse({ ...withoutMetadata, ...fields }).success).toBe(
        false,
      );
      expect(
        schema.safeParse({
          ...base,
          ...fields,
          _meta: { idempotencyKey: 'command-1' },
        }).success,
      ).toBe(true);
    }
  });

  it('preserves absent and explicit aggregate revisions for queued commands', () => {
    for (const schema of [
      CoreChatQueueEntryCancelParamsSchema,
      CoreChatQueueEntryForceParamsSchema,
    ]) {
      expect(schema.parse({ ...base, entryId: 'entry-1' })).toEqual({
        ...base,
        entryId: 'entry-1',
      });
      expect(
        schema.parse({ ...base, entryId: 'entry-1', expectedRevision: 7 }),
      ).toMatchObject({ expectedRevision: 7 });
      expect(
        schema.safeParse({ ...base, entryId: 'entry-1', expectedRevision: -1 })
          .success,
      ).toBe(false);
    }
  });

  it('keeps edit and steer queue mutations distinct', () => {
    expect(
      CoreChatQueueEntryUpdateParamsSchema.parse({
        ...base,
        entryId: 'entry-1',
        mutation: { kind: 'steer' },
      }).mutation,
    ).toEqual({ kind: 'steer' });
    expect(
      CoreChatQueueEntryUpdateParamsSchema.safeParse({
        ...base,
        entryId: 'entry-1',
        mutation: { kind: 'edit' },
      }).success,
    ).toBe(false);
  });

  it('distinguishes terminal initial prompts from normal sends', () => {
    const message = { ...base, messageId: 'message-1', text: 'Hello' };
    expect(CoreChatMessageSendParamsSchema.parse(message)).toEqual(message);
    expect(
      CoreChatMessageSendParamsSchema.parse({
        ...message,
        origin: {
          kind: 'terminalInitialPrompt',
          turnTimerMessageId: 'timer-1',
        },
      }).origin,
    ).toMatchObject({ kind: 'terminalInitialPrompt' });
  });

  it('carries a bounded plan review identity with an implementation message', () => {
    const message = {
      ...base,
      messageId: 'implementation',
      text: 'Implement the plan.',
    };
    const planReviewApproval = {
      requestId: 'review',
      planId: 'plan',
      revisionNumber: 2,
    };
    expect(
      CoreChatMessageSendParamsSchema.safeParse({
        ...message,
        planReviewApproval,
      }).success,
    ).toBe(true);
    expect(
      CoreChatMessageSendParamsSchema.safeParse({
        ...message,
        planReviewApproval,
        origin: {
          kind: 'terminalInitialPrompt',
          turnTimerMessageId: 'timer-1',
        },
      }).success,
    ).toBe(false);
    for (const invalid of [
      { ...planReviewApproval, requestId: '' },
      { ...planReviewApproval, planId: '../plan' },
      { ...planReviewApproval, revisionNumber: 0 },
      { ...planReviewApproval, revisionNumber: 1.5 },
      { ...planReviewApproval, hiddenPath: '/private/plan.md' },
    ]) {
      expect(
        CoreChatMessageSendParamsSchema.safeParse({
          ...message,
          planReviewApproval: invalid,
        }).success,
      ).toBe(false);
    }
  });

  it('validates the exact legacy receipt fields', () => {
    expect(
      CoreChatCommandReceiptSchema.parse({
        commandId: 'command-1',
        revision: 8,
        outcome: 'already_applied',
        messageId: 'message-1',
      }),
    ).toMatchObject({ outcome: 'already_applied', revision: 8 });
  });

  it('preserves additive JSON receipt fields', () => {
    const receipt = {
      commandId: 'command-1',
      revision: 8,
      outcome: 'applied' as const,
      queueEntryId: 'entry-1',
    };
    expect(CoreChatCommandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      CoreChatCommandReceiptSchema.safeParse({ ...receipt, extra: () => 1 })
        .success,
    ).toBe(false);
  });
});
