import {
  TranscriptTargetSchema,
  TranscriptStreamDescriptorSchema,
  TranscriptStreamCatalogSchema,
  CardStateV1Schema,
  TranscriptStreamDescriptorUpdateSchema,
} from '../core/chat/transcript';

describe('portable stream contracts', () => {
  it('accepts distinct delegation identities and rejects future fields', () => {
    const target = {
      kind: 'delegation',
      chatId: 'Legacy_Chat.ID',
      delegationId: 'opaque:id',
      runGeneration: 0,
    };
    expect(TranscriptTargetSchema.parse(target)).toEqual(target);
    expect(() =>
      TranscriptTargetSchema.parse({ ...target, extra: true }),
    ).toThrow();
    expect(() =>
      TranscriptTargetSchema.parse({ ...target, runGeneration: 1.5 }),
    ).toThrow();
  });

  it('reserves null card state and rejects unknown catalog fields', () => {
    const descriptor = {
      version: 1,
      target: {
        kind: 'delegation',
        chatId: 'chat',
        delegationId: 'd',
        runGeneration: 0,
      },
      streamKey: 'a'.repeat(64),
      checkpointRevision: 0,
      status: 'open',
      streamRevision: 0,
      committedRowCount: 0,
      latestRowTimestamp: null,
      committedByteLength: 0,
      committedSha256: 'e'.repeat(64),
      settleReceipt: null,
      cardState: null,
    };
    expect(TranscriptStreamDescriptorSchema.parse(descriptor)).toEqual(
      descriptor,
    );
    expect(() =>
      TranscriptStreamDescriptorSchema.parse({ ...descriptor, cardState: {} }),
    ).toThrow();
    expect(() =>
      TranscriptStreamCatalogSchema.parse({
        version: 1,
        checkpointRevision: 0,
        parents: {},
        future: true,
      }),
    ).toThrow();
  });
  it('keeps descriptor version one and accepts only typed card state and target-addressed updates', () => {
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const state = {
      version: 1 as const,
      status: 'running' as const,
      resultIndex: null,
      error: null,
      usage: null,
      workspaceRevision: null,
      workspaceDiscarded: false,
      stopOutcome: null,
      controlOutcome: null,
      attribution: null,
      capabilitySummary: null,
      nestedChildSummary: null,
      partialPreview: null,
      finalPreview: null,
    };
    expect(CardStateV1Schema.parse(state)).toEqual(state);
    expect(() => CardStateV1Schema.parse({ ...state, future: true })).toThrow();
    const update = {
      version: 1 as const,
      target,
      expectedStreamRevision: 0,
      nextStreamRevision: 1,
      cardState: state,
    };
    expect(TranscriptStreamDescriptorUpdateSchema.parse(update)).toEqual(
      update,
    );
    expect(() =>
      TranscriptStreamDescriptorUpdateSchema.parse({ ...update, future: true }),
    ).toThrow();
  });
});
