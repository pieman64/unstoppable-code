import { TrackedPlanImplementationSchema } from '../chat-plan-review';
import { CoreChatUpdateParamsSchema } from '../core/chat/commands-lifecycle';
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

  it('requires an explicit move anchor or null tail while retaining revision checks', () => {
    for (const beforeEntryId of ['entry-2', null]) {
      expect(
        CoreChatQueueEntryUpdateParamsSchema.parse({
          ...base,
          entryId: 'entry-1',
          expectedRevision: 8,
          mutation: { kind: 'move', beforeEntryId },
        }),
      ).toMatchObject({
        expectedRevision: 8,
        mutation: { kind: 'move', beforeEntryId },
      });
    }
    for (const mutation of [
      { kind: 'move' },
      { kind: 'move', beforeEntryId: '' },
      { kind: 'move', beforeEntryId: null, text: 'extra' },
    ]) {
      expect(
        CoreChatQueueEntryUpdateParamsSchema.safeParse({
          ...base,
          entryId: 'entry-1',
          mutation,
        }).success,
      ).toBe(false);
    }
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

  it('accepts identity-only delivery rejection and rejects caller-supplied terminal outcomes', () => {
    const params = {
      projectId: 'project',
      worktreeId: 'worktree',
      commandId: 'reject',
      _meta: { idempotencyKey: 'reject' },
      action: {
        type: 'chat.reject_plan_implementation_delivery',
        chatId: 'chat-1',
        userMessageId: 'message-1',
      },
    };
    expect(CoreChatUpdateParamsSchema.safeParse(params).success).toBe(true);
    expect(
      CoreChatUpdateParamsSchema.safeParse({
        ...params,
        action: { ...params.action, outcome: 'completed' },
      }).success,
    ).toBe(false);
  });

  it('core.chat.update distinguishes persisted terminal pairs from writable identity and accepts legacy omission or clear', () => {
    const link = {
      planId: 'plan-1',
      revisionNumber: 2,
      userMessageId: 'message-1',
      startedAt: '2026-08-07T12:00:00.000Z',
    };
    const update = (trackedPlanImplementation: unknown): boolean =>
      CoreChatUpdateParamsSchema.safeParse({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'cmd',
        _meta: { idempotencyKey: 'cmd' },
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { trackedPlanImplementation },
        },
      }).success;
    for (const value of [undefined, null, link])
      expect(update(value)).toBe(true);
    for (const outcome of ['completed', 'failed', 'cancelled']) {
      const settled = { ...link, outcome, endedAt: '2026-08-07T12:01:00.000Z' };
      expect(TrackedPlanImplementationSchema.safeParse(settled).success).toBe(
        true,
      );
      expect(update(settled)).toBe(false);
      expect(
        TrackedPlanImplementationSchema.safeParse({ ...link, outcome }).success,
      ).toBe(false);
    }
    expect(
      TrackedPlanImplementationSchema.safeParse({
        ...link,
        endedAt: link.startedAt,
      }).success,
    ).toBe(false);
  });

  it('accepts implementation identity only for the exact sent message and rejects forged outcomes', () => {
    const trackedPlanImplementation = {
      planId: 'plan-1',
      revisionNumber: 2,
      userMessageId: 'message-1',
      startedAt: '2026-08-07T12:00:00.000Z',
    };
    const message = {
      ...base,
      messageId: 'message-1',
      text: 'Implement.',
      trackedPlanImplementation,
    };
    expect(CoreChatMessageSendParamsSchema.parse(message)).toEqual(message);
    for (const invalid of [
      { ...trackedPlanImplementation, userMessageId: 'other' },
      { ...trackedPlanImplementation, planId: '../plan' },
      { ...trackedPlanImplementation, revisionNumber: 0 },
      { ...trackedPlanImplementation, startedAt: 'yesterday' },
      { ...trackedPlanImplementation, outcome: 'completed' },
    ])
      expect(
        CoreChatMessageSendParamsSchema.safeParse({
          ...message,
          trackedPlanImplementation: invalid,
        }).success,
      ).toBe(false);
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
