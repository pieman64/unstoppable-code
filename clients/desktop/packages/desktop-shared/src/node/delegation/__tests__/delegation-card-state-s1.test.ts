import {
  CardStateV2Schema,
  type CardStateDraft,
} from '@canopy/protocol/canopy-core';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import type {
  DelegationTranscriptSettleAnswer,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptTarget,
} from '../transcript-port';

const target: DelegationTranscriptTarget = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'd',
  runGeneration: 1,
};
const draft: CardStateDraft = {
  version: 2,
  status: 'running',
  outputTruncated: false,
};
const reference = {
  version: 1,
  artifactId:
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  byteLength: 3,
  encoding: 'utf-8',
  mediaType: 'text/plain',
} as const;
const route: NonNullable<CardStateDraft['routeSnapshot']> = {
  selectedModelId: 'selected',
  runtimeModelId: 'runtime',
  harnessId: 'codex',
  runtimeKind: 'sdk',
  runnerRegistrationId: 'runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'agent',
  providerType: 'openai',
  assignmentRevision: '1',
  billingAuthority: 'local',
  aiCreditsRouted: false,
  capabilities: [],
  supportedThinkingLevels: [],
  capabilitySnapshotHash: 'hash',
  capabilityGeneration: 1,
  policyRevision: '1',
};
function settle(
  answer: DelegationTranscriptSettleAnswer,
): DelegationTranscriptSettleRequest {
  return {
    target,
    settlementKey: 'key',
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: 1 },
    finalChanges: [],
    answer,
  };
}
function port(): InMemoryDelegationTranscriptPort {
  return new InMemoryDelegationTranscriptPort({ owns: (): boolean => true });
}

describe('12a S1 memory evidence', () => {
  it.each([
    [
      'schema',
      {
        cardDraft: { ...draft, nativeSessionId: 'x'.repeat(1025) },
        cardRevision: 1,
      },
    ],
    [
      'unsafe counter',
      { cardDraft: draft, cardRevision: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ['negative counter', { cardDraft: draft, cardRevision: -1 }],
    ['draft without counter', { cardDraft: draft }],
    ['counter without draft', { cardRevision: 1 }],
  ] satisfies readonly [string, Partial<DelegationTranscriptSettleRequest>][])(
    'E6 malformed %s rejects before consuming an index, while keyed replay ignores it',
    async (_name, fields) => {
      const memory = port();
      await memory.open({ target });
      expect(await memory.settle({ ...settle(null), ...fields })).toMatchObject(
        { ok: false, error: { code: 'invalid_request' } },
      );
      expect(await memory.open({ target })).toMatchObject({
        ok: true,
        value: { streamRevision: 0, status: 'open' },
      });
      const accepted = await memory.settle(settle(null));
      expect(accepted).toMatchObject({
        ok: true,
        value: { result: { resultIndex: 1 } },
      });
      expect(await memory.settle({ ...settle(null), ...fields })).toMatchObject(
        { ok: true, value: { settlement: { replayed: true } } },
      );
    },
  );

  it.each([2, 3])(
    'E6 malformed schema is rejected even with stale/equal publication counter %s',
    async (cardRevision) => {
      const memory = port();
      await memory.open({ target });
      await memory.updateCardState({
        target,
        cardRevision: 3,
        cardDraft: draft,
      });
      expect(
        await memory.settle({
          ...settle(null),
          cardRevision,
          cardDraft: { ...draft, nativeSessionId: 'x'.repeat(1025) },
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(await memory.settle(settle(null))).toMatchObject({
        ok: true,
        value: { result: { resultIndex: 1 } },
      });
    },
  );

  it('E6 canonical-only error fitting records omission without creating a draft', async () => {
    const memory = port();
    await memory.open({ target });
    await memory.settle({
      ...settle(null),
      outcome: {
        status: 'failed',
        finishedAt: 1,
        error: {
          code: 'runtime_error',
          message: '\u0000'.repeat(1000),
          retryable: false,
        },
      },
    });
    const opened = await memory.open({ target });
    if (!opened.ok) throw new Error('open failed');
    expect(opened.value.cardState).toEqual({
      version: 2,
      cardRevision: 0,
      canonical: {
        status: 'failed',
        resultIndex: 1,
        detailOmitted: true,
        error: {
          code: 'runtime_error',
          message: '\u0000'.repeat(682),
          retryable: false,
        },
      },
    });
  });

  it('E5 latches settled detail omission while allowing later whole metadata drafts', async () => {
    const memory = port();
    await memory.open({ target });
    await memory.settle({ ...settle(null), cardRevision: 1, cardDraft: draft });
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: { ...draft, detailOmitted: true },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 3,
        cardDraft: { ...draft, workspaceDiscarded: true },
      }),
    ).toMatchObject({
      ok: true,
      value: { cardState: { detailOmitted: true, workspaceDiscarded: true } },
    });
  });

  it.each(['route', 'prompt', 'status'] as const)(
    'E6 first settle ignores inadmissible higher draft: %s',
    async (field) => {
      const memory = port();
      await memory.open({ target });
      const stored: CardStateDraft = {
        ...draft,
        routeSnapshot: route,
        prompt: 'locked',
      };
      await memory.updateCardState({
        target,
        cardRevision: 3,
        cardDraft: stored,
      });
      const supplied: CardStateDraft = { ...stored };
      if (field === 'route') delete supplied.routeSnapshot;
      if (field === 'prompt') delete supplied.prompt;
      if (field === 'status') supplied.status = 'pending';
      expect(
        await memory.settle({
          ...settle(null),
          cardRevision: 4,
          cardDraft: supplied,
        }),
      ).toMatchObject({ ok: true });
      const opened = await memory.open({ target });
      if (!opened.ok) throw new Error('open failed');
      expect(opened.value.cardState).toEqual({
        ...stored,
        cardRevision: 3,
        canonical: { status: 'completed', resultIndex: 1 },
      });
    },
  );

  it('E5 canonical-only settle admits a first later baseline and then freezes it', async () => {
    const memory = port();
    await memory.open({ target });
    await memory.settle(settle(null));
    const baseline: CardStateDraft = {
      ...draft,
      nativeSessionId: 'baseline',
      control: {
        operationId: 'apply',
        operation: 'apply',
        status: 'completed',
      },
    };
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: baseline,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        cardState: {
          ...baseline,
          cardRevision: 1,
          canonical: { status: 'completed', resultIndex: 1 },
        },
      },
    });
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: { ...baseline, nativeSessionId: 'changed' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
  });

  it.each([
    ['status', { status: 'pending' }],
    ['prompt', { prompt: 'changed' }],
    ['route', { routeSnapshot: { ...route, runtimeModelId: 'changed' } }],
    ['requested model', { requestedModelId: 'changed' }],
    ['session', { nativeSessionId: 'changed' }],
    ['cancelled', { cancelledByUser: false }],
    ['stopped by', { stoppedBy: { kind: 'agent', depth: 0 } }],
    ['truncation', { outputTruncated: true }],
  ] satisfies readonly [string, Partial<CardStateDraft>][])(
    'E5 settled freeze rejects changed %s without changing card revision',
    async (_name, change) => {
      const memory = port();
      await memory.open({ target });
      const frozen: CardStateDraft = {
        ...draft,
        prompt: 'original',
        routeSnapshot: route,
        requestedModelId: 'requested',
        nativeSessionId: 'native',
        cancelledByUser: true,
        stoppedBy: { kind: 'user' },
      };
      await memory.settle({
        ...settle(null),
        cardRevision: 1,
        cardDraft: frozen,
      });
      expect(
        await memory.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: { ...frozen, ...change },
        }),
      ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
      expect(await memory.open({ target })).toMatchObject({
        ok: true,
        value: { cardState: { ...frozen, cardRevision: 1 } },
      });
    },
  );

  it('E5 higher counters apply and identical reordered replay adds no revision or execution rows', async () => {
    const memory = port();
    await memory.open({ target });
    const first = await memory.updateCardState({
      target,
      cardRevision: 1,
      cardDraft: draft,
    });
    expect(first).toMatchObject({ ok: true, value: { streamRevision: 1 } });
    const next = await memory.updateCardState({
      target,
      cardRevision: 2,
      cardDraft: { ...draft, workspaceDiscarded: true },
    });
    expect(next).toMatchObject({ ok: true, value: { streamRevision: 2 } });
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: {
          workspaceDiscarded: true,
          outputTruncated: false,
          status: 'running',
          version: 2,
        },
      }),
    ).toEqual(next);
    expect(await memory.page({ target, streamRevision: 2 })).toMatchObject({
      ok: true,
      value: { rows: [] },
    });
    expect(await memory.open({ target })).toMatchObject({
      ok: true,
      value: { streamRevision: 2, latestRowTimestamp: null },
    });
  });

  it('E5 validates negative and fractional counters and targets; deletion refuses resurrection', async () => {
    const memory = port();
    await memory.open({ target });
    for (const cardRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        await memory.updateCardState({
          target,
          cardRevision,
          cardDraft: draft,
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(
      await memory.updateCardState({
        target: { ...target, runGeneration: 0 },
        cardRevision: 1,
        cardDraft: draft,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    memory.removeChat('chat');
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('E5 retains route source and historical prompt lock after reopen and settle', async () => {
    const memory = port();
    await memory.open({ target });
    const first = {
      ...draft,
      routeSnapshot: route,
      prompt: 'Amended',
      requestedModelId: 'requested',
    };
    await memory.updateCardState({ target, cardRevision: 1, cardDraft: first });
    await memory.open({ target });
    for (const changed of [
      { ...draft, prompt: 'Amended', requestedModelId: 'requested' },
      { ...first, status: 'pending' as const },
      { ...first, prompt: 'Changed' },
    ]) {
      expect(
        await memory.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: changed,
        }),
      ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
    }
    await memory.settle(settle(null));
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: { ...first, prompt: 'Changed' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
  });

  it('E5 failed apply, successful apply, discard, replay retain exact result, reference and content revision', async () => {
    const memory = port();
    await memory.open({ target });
    const accepted = await memory.settle({
      ...settle({ role: 'final', text: 'abc' }),
      cardRevision: 1,
      cardDraft: draft,
    });
    expect(accepted.ok).toBe(true);
    const canonical = {
      status: 'completed',
      resultIndex: 1,
      finalText: 'abc',
      finalTextRef: reference,
    };
    const controls: NonNullable<CardStateDraft['control']>[] = [
      {
        operationId: 'failed',
        operation: 'apply',
        status: 'failed',
        applyFailure: {
          reason: 'conflict',
          issues: [{ path: 'a', reason: 'parent_changed', parentDiff: 'diff' }],
          guidance: 'Retry',
        },
      },
      { operationId: 'success', operation: 'apply', status: 'completed' },
      { operationId: 'discard', operation: 'discard', status: 'completed' },
    ];
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      const update = {
        target,
        cardRevision: index + 2,
        cardDraft: {
          ...draft,
          control,
          isolatedWorkspace: {
            revision: `revision-${String(index)}`,
            dirtyParentChangesIncluded: false as const,
          },
          workspaceDiscarded: index === 2,
        },
      };
      const applied = await memory.updateCardState(update);
      expect(applied).toMatchObject({
        ok: true,
        value: { cardState: { canonical } },
      });
      expect(await memory.updateCardState(update)).toEqual(applied);
    }
    const replay = await memory.settle({
      ...settle({ role: 'final', text: 'abc' }),
      cardRevision: 99,
      cardDraft: { ...draft, prompt: 'ignored' },
    });
    if (!accepted.ok || !replay.ok) throw new Error('settlement failed');
    expect(replay.value.result).toEqual(accepted.value.result);
    expect(replay.value.settlement).toEqual({
      ...accepted.value.settlement,
      replayed: true,
    });
    expect(
      await memory.page({
        target,
        streamRevision: accepted.value.settlement.contentRevision,
      }),
    ).toMatchObject({ ok: true, value: { rows: [] } });
    expect(await memory.open({ target })).toMatchObject({
      ok: true,
      value: { cardState: { cardRevision: 4, canonical } },
    });
    expect(
      await memory.settle(settle({ role: 'final', text: 'different' })),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it.each([
    [null, { status: 'completed', resultIndex: 1 }],
    [
      { role: 'final', text: '' },
      { status: 'completed', resultIndex: 1, finalText: '' },
    ],
    [
      { role: 'partial', text: '' },
      { status: 'completed', resultIndex: 1, partialText: '' },
    ],
    [
      { role: 'final', text: 'abc' },
      {
        status: 'completed',
        resultIndex: 1,
        finalText: 'abc',
        finalTextRef: reference,
      },
    ],
    [
      { role: 'partial', text: 'abc' },
      {
        status: 'completed',
        resultIndex: 1,
        partialText: 'abc',
        partialTextRef: reference,
      },
    ],
    [
      { role: 'final', lost: { sha256: 'a'.repeat(64), length: 1 } },
      { status: 'completed', resultIndex: 1, answerUnavailable: true },
    ],
  ] satisfies readonly [DelegationTranscriptSettleAnswer, object][])(
    'E6 canonical answer literals have no opposite-role fields: %j',
    async (answer, canonical) => {
      const memory = port();
      await memory.open({ target });
      await memory.settle(settle(answer));
      const opened = await memory.open({ target });
      if (!opened.ok) throw new Error('open failed');
      expect(opened.value.cardState).toEqual({
        version: 2,
        cardRevision: 0,
        canonical,
      });
    },
  );

  it.each([
    [undefined, undefined, 0, undefined],
    [3, undefined, 3, 'stored'],
    [undefined, 4, 4, 'supplied'],
    [3, 2, 3, 'stored'],
    [3, 3, 3, 'stored'],
    [3, 4, 4, 'supplied'],
  ])(
    'E6 first settle chooses stored %s / supplied %s',
    async (stored, supplied, revision, native) => {
      const memory = port();
      await memory.open({ target });
      if (stored !== undefined)
        await memory.updateCardState({
          target,
          cardRevision: stored,
          cardDraft: { ...draft, nativeSessionId: 'stored' },
        });
      await memory.settle({
        ...settle(null),
        ...(supplied === undefined
          ? {}
          : {
              cardRevision: supplied,
              cardDraft: { ...draft, nativeSessionId: 'supplied' },
            }),
      });
      const opened = await memory.open({ target });
      if (!opened.ok) throw new Error('open failed');
      expect(opened.value.cardState).toEqual({
        version: 2,
        cardRevision: revision,
        ...(native === undefined ? {} : { ...draft, nativeSessionId: native }),
        canonical: { status: 'completed', resultIndex: 1 },
      });
    },
  );

  it('E6 fits terminal error and preview without changing accepted body, digest, usage or stop attribution', async () => {
    const memory = port();
    await memory.open({ target });
    const input: DelegationTranscriptSettleRequest = {
      ...settle({ role: 'partial', text: '\u0000'.repeat(9000) }),
      outcome: {
        status: 'cancelled',
        finishedAt: 2,
        error: {
          code: 'runtime_error',
          message: '\u0000'.repeat(1000),
          retryable: false,
        },
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 4,
          costUsd: 0.5,
        },
        stopReason: 'user_cancelled',
      },
      cardRevision: 1,
      cardDraft: {
        ...draft,
        cancelledByUser: true,
        stoppedBy: { kind: 'user' },
      },
    };
    const result = await memory.settle(input);
    const opened = await memory.open({ target });
    if (!result.ok || !opened.ok) throw new Error('settlement failed');
    const state = opened.value.cardState;
    expect(CardStateV2Schema.safeParse(state).success).toBe(true);
    expect(state?.version === 2 && state.canonical).toEqual({
      status: 'cancelled',
      resultIndex: 1,
      error: {
        code: 'runtime_error',
        message: '\u0000'.repeat(682),
        retryable: false,
      },
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        costUsd: 0.5,
      },
      stopReason: 'user_cancelled',
      partialText: '\u0000'.repeat(8192),
      detailOmitted: true,
      partialTextRef:
        result.value.result.answer.kind === 'body'
          ? result.value.result.answer.ref
          : undefined,
    });
    expect(state).toMatchObject({
      cancelledByUser: true,
      stoppedBy: { kind: 'user' },
      outputTruncated: false,
    });
    expect(
      await memory.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: {
          ...draft,
          cancelledByUser: true,
          stoppedBy: { kind: 'user' },
          workspaceDiscarded: true,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(result.value.result.outcome).toEqual(input.outcome);
    expect(await memory.settle(input)).toMatchObject({
      ok: true,
      value: { settlement: { replayed: true } },
    });
  });
});
