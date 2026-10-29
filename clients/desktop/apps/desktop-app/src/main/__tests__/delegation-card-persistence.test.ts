import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import {
  DelegationCardPersistence,
  persistedDelegationSnapshot,
} from '../agents/delegation/card-persistence';

const route = {
  selectedModelId: 'model',
  runtimeModelId: 'model',
  harnessId: 'claude',
};

function snapshot(
  change: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationSnapshot {
  return {
    delegationId: 'child',
    status: 'running',
    outputTruncated: false,
    routeSnapshot: route,
    ...change,
  };
}

function transcript(
  sequence: number,
  change: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationTranscript {
  return {
    delegationId: 'child',
    runGeneration: 1,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'spawn',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Review',
      executionMode: 'background',
    },
    transcript: [],
    snapshot: snapshot(change),
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('persistedDelegationSnapshot', () => {
  it('drops live-only progress from a running card', () => {
    expect(
      persistedDelegationSnapshot(
        snapshot({
          partialText: 'Reading files',
          phase: 'tool',
          queue: { id: 'queue', name: 'Queue' },
          approvalPending: true,
          stopRequested: { operationId: 'stop', status: 'accepted' },
          workspaceObservation: {
            consistency: 'consistent',
            dirty: false,
            headRevision: 'abc',
            observedAt: 1,
          },
          control: {
            operationId: 'steer',
            operation: 'steer',
            status: 'accepted',
          },
          usage: { inputTokens: 10, outputTokens: 1 },
          nativeSessionId: 'native',
        }),
      ),
    ).toEqual(snapshot({ nativeSessionId: 'native' }));
  });

  it('keeps a settled card’s usage and a finished control operation', () => {
    const settled = snapshot({
      status: 'completed',
      finalText: 'Done',
      usage: { inputTokens: 10, outputTokens: 1 },
      control: { operationId: 'apply', operation: 'apply', status: 'failed' },
    });
    expect(persistedDelegationSnapshot(settled)).toEqual(settled);
  });
});

describe('DelegationCardPersistence', () => {
  let published: AgentDelegationTranscript[];
  let persistence: DelegationCardPersistence;

  beforeEach(() => {
    published = [];
    persistence = new DelegationCardPersistence({
      publish: (card): void => {
        published.push(card);
      },
    });
  });

  it('publishes a card when it appears and when its projection changes', async () => {
    const logged = Promise.resolve();
    persistence.offer(transcript(1), logged);
    persistence.offer(transcript(2, { partialText: 'progress' }), logged);
    persistence.offer(transcript(3, { approvalPending: true }), logged);
    persistence.offer(transcript(4, { nativeSessionId: 'native' }), logged);
    await settle();
    expect(published.map((card) => card.sequence)).toEqual([1, 4]);
    expect(
      published.every((card) => card.transcriptStore === 'chat-log-v1'),
    ).toBe(true);
  });

  it('ignores an older snapshot that arrives late', async () => {
    persistence.offer(transcript(5), Promise.resolve());
    persistence.offer(
      transcript(4, { nativeSessionId: 'late' }),
      Promise.resolve(),
    );
    await settle();
    expect(published.map((card) => card.sequence)).toEqual([5]);
  });

  it('publishes a settled card only after its items are logged, in order', async () => {
    let release = (): void => undefined;
    const logged = new Promise<void>((resolve) => {
      release = resolve;
    });
    persistence.offer(transcript(1), Promise.resolve());
    persistence.offer(transcript(2, { status: 'completed' }), logged);
    await settle();
    expect(published.map((card) => card.sequence)).toEqual([1]);
    release();
    await persistence.flush();
    expect(published.map((card) => card.sequence)).toEqual([1, 2]);
  });

  it('still publishes a settled card when logging failed', async () => {
    const errors: unknown[] = [];
    persistence = new DelegationCardPersistence({
      publish: (card): void => {
        published.push(card);
      },
      onError: (error): void => {
        errors.push(error);
      },
    });
    persistence.offer(
      transcript(1, { status: 'failed' }),
      Promise.reject(new Error('scope deleted')),
    );
    await persistence.flush();
    expect(published.map((card) => card.sequence)).toEqual([1]);
    expect(errors).toHaveLength(1);
  });
});
