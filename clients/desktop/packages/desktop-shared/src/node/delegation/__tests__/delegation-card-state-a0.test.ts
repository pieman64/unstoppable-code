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

function request(
  answer: DelegationTranscriptSettleAnswer,
): DelegationTranscriptSettleRequest {
  return {
    target,
    settlementKey: 'settle-1',
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: 1 },
    finalChanges: [],
    answer,
  };
}

describe('12a A0 memory card-state contract', () => {
  it('E5 rejects wrong generations, foreign owners and exhausted publication counters', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (candidate): boolean => candidate.chatId === 'chat',
    });
    await port.open({ target });
    expect(
      await port.updateCardState({
        target: { ...target, runGeneration: 2 },
        cardRevision: 1,
        cardDraft: { version: 2, status: 'pending', outputTruncated: false },
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(
      await port.updateCardState({
        target: { ...target, chatId: 'foreign' },
        cardRevision: 1,
        cardDraft: { version: 2, status: 'pending', outputTruncated: false },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(
      await port.updateCardState({
        target,
        cardRevision: 9007199254740992,
        cardDraft: { version: 2, status: 'pending', outputTruncated: false },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('E6 binds the exact canonical answer reference and leaves keyed replay immutable', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    await port.open({ target });
    const first = await port.settle({
      ...request({ role: 'final', text: 'abc' }),
      cardRevision: 1,
      cardDraft: { version: 2, status: 'running', outputTruncated: false },
    });
    expect(first.ok).toBe(true);
    expect(await port.open({ target })).toMatchObject({
      ok: true,
      value: {
        cardState: {
          canonical: {
            status: 'completed',
            resultIndex: 1,
            finalText: 'abc',
            finalTextRef: {
              version: 1,
              artifactId:
                'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
              sha256:
                'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
              byteLength: 3,
              encoding: 'utf-8',
              mediaType: 'text/plain',
            },
          },
        },
      },
    });
    const replay = await port.settle({
      ...request({ role: 'final', text: 'abc' }),
      cardRevision: 99,
      cardDraft: {
        version: 2,
        status: 'pending',
        outputTruncated: false,
        nativeSessionId: 'later',
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      value: { settlement: { replayed: true } },
    });
    expect(await port.open({ target })).toMatchObject({
      ok: true,
      value: { cardState: { cardRevision: 1, status: 'running' } },
    });
  });

  it('E5 admits metadata-only draft changes without parent rows', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    await port.open({ target });
    expect(
      await port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: { version: 2, status: 'pending', outputTruncated: false },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        streamRevision: 1,
        cardState: {
          version: 2,
          cardRevision: 1,
          status: 'pending',
          outputTruncated: false,
        },
      },
    });
  });

  it('E5 lower/equal/higher publication counters fence delayed drafts', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    await port.open({ target });
    const draft = {
      version: 2 as const,
      status: 'pending' as const,
      outputTruncated: false,
    };
    await port.updateCardState({ target, cardRevision: 2, cardDraft: draft });
    expect(
      await port.updateCardState({ target, cardRevision: 1, cardDraft: draft }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
    expect(
      await port.updateCardState({ target, cardRevision: 2, cardDraft: draft }),
    ).toMatchObject({ ok: true, value: { streamRevision: 1 } });
    expect(
      await port.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: { ...draft, workspaceDiscarded: true },
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('E5 freezes a queued prompt from the first running draft', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    await port.open({ target });
    await port.updateCardState({
      target,
      cardRevision: 1,
      cardDraft: {
        version: 2,
        status: 'pending',
        outputTruncated: false,
        prompt: 'First',
      },
    });
    await port.updateCardState({
      target,
      cardRevision: 2,
      cardDraft: {
        version: 2,
        status: 'running',
        outputTruncated: false,
        prompt: 'First',
      },
    });
    expect(
      await port.updateCardState({
        target,
        cardRevision: 3,
        cardDraft: {
          version: 2,
          status: 'running',
          outputTruncated: false,
          prompt: 'Changed',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
  });

  it.each(['follow_up', 'resume', 'steer', 'apply', 'discard'] as const)(
    'E5 permits post-settle failed %s details but freezes canonical answer',
    async (operation) => {
      const port = new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
      });
      await port.open({ target });
      await port.settle({
        ...request({ role: 'final', text: 'Retained' }),
        cardRevision: 1,
        cardDraft: { version: 2, status: 'running', outputTruncated: false },
      });
      expect(
        await port.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: {
            version: 2,
            status: 'running',
            outputTruncated: false,
            control: {
              operationId: 'op',
              operation,
              status: 'failed',
              error: 'No change',
            },
          },
        }),
      ).toMatchObject({
        ok: true,
        value: {
          cardState: {
            canonical: {
              status: 'completed',
              resultIndex: 1,
              finalText: 'Retained',
            },
            control: { operation, status: 'failed' },
          },
        },
      });
    },
  );

  it.each([
    {
      name: 'none',
      answer: null,
      canonical: { status: 'completed', resultIndex: 1 },
    },
    {
      name: 'empty',
      answer: { role: 'final', text: '' },
      canonical: { status: 'completed', resultIndex: 1, finalText: '' },
    },
    {
      name: 'final',
      answer: { role: 'final', text: 'Final answer' },
      canonical: {
        status: 'completed',
        resultIndex: 1,
        finalText: 'Final answer',
      },
    },
    {
      name: 'partial',
      answer: { role: 'partial', text: 'Partial answer' },
      canonical: {
        status: 'completed',
        resultIndex: 1,
        partialText: 'Partial answer',
      },
    },
    {
      name: 'lost',
      answer: { role: 'final', lost: { sha256: 'a'.repeat(64), length: 1 } },
      canonical: {
        status: 'completed',
        resultIndex: 1,
        answerUnavailable: true,
      },
    },
  ] satisfies readonly {
    name: string;
    answer: DelegationTranscriptSettleAnswer;
    canonical: object;
  }[])(
    'E6 derives $name canonical state inside first settle without a draft',
    async ({ answer, canonical }) => {
      const port = new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
      });
      await port.open({ target });
      const settled = await port.settle(request(answer));
      expect(settled.ok).toBe(true);
      const opened = await port.open({ target });
      expect(opened).toMatchObject({
        ok: true,
        value: {
          status: 'settled',
          cardState: { version: 2, cardRevision: 0, canonical },
        },
      });
    },
  );

  it('E6 stale settle draft never rejects settlement and newer stored draft wins', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    await port.open({ target });
    await port.updateCardState({
      target,
      cardRevision: 3,
      cardDraft: {
        version: 2,
        status: 'running',
        outputTruncated: false,
        nativeSessionId: 'new',
      },
    });
    expect(
      (
        await port.settle({
          ...request(null),
          cardRevision: 2,
          cardDraft: {
            version: 2,
            status: 'running',
            outputTruncated: false,
            nativeSessionId: 'old',
          },
        })
      ).ok,
    ).toBe(true);
    expect(await port.open({ target })).toMatchObject({
      ok: true,
      value: {
        cardState: {
          cardRevision: 3,
          nativeSessionId: 'new',
          canonical: { status: 'completed', resultIndex: 1 },
        },
      },
    });
  });
  it.each([
    [
      'status returning to pending',
      { version: 2, status: 'running', outputTruncated: false },
      { version: 2, status: 'pending', outputTruncated: false },
    ],
    [
      'a dropped prompt override',
      {
        version: 2,
        status: 'pending',
        outputTruncated: false,
        prompt: 'Amended',
      },
      { version: 2, status: 'pending', outputTruncated: false },
    ],
    [
      'a dropped requested model',
      {
        version: 2,
        status: 'running',
        outputTruncated: false,
        requestedModelId: 'model',
      },
      { version: 2, status: 'running', outputTruncated: false },
    ],
  ] as const)(
    'E5 amendment 3 refuses %s as stale and keeps the stored state',
    async (_name, first, second) => {
      const port = new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
      });
      await port.open({ target });
      expect(
        await port.updateCardState({
          target,
          cardRevision: 1,
          cardDraft: first,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await port.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: second,
        }),
      ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
      expect(await port.open({ target })).toMatchObject({
        ok: true,
        value: { cardState: { ...first, cardRevision: 1 } },
      });
    },
  );
});
