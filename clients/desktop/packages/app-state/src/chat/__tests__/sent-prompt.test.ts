import { detectSentPrompt, type SentPromptSummary } from '../sent-prompt';

function summary(
  latest: { id: string; timestamp: number } | null,
  promptCount: number,
  queuedCount = 0,
): SentPromptSummary {
  return { latest, promptCount, queuedCount };
}

describe('detectSentPrompt', () => {
  const first = { id: 'u1', timestamp: 1_000 };

  it('detects a new human prompt that grows the total', () => {
    expect(
      detectSentPrompt(
        summary(first, 1),
        summary({ id: 'u2', timestamp: 2_000 }, 2),
      ),
    ).toBe(true);
  });

  it('accepts a new prompt with the same timestamp as the previous one', () => {
    expect(
      detectSentPrompt(
        summary(first, 1),
        summary({ id: 'u2', timestamp: 1_000 }, 2),
      ),
    ).toBe(true);
  });

  it('detects the first prompt of a chat with none', () => {
    expect(detectSentPrompt(summary(null, 0), summary(first, 1))).toBe(true);
  });

  it('detects a prompt queued behind a running turn', () => {
    expect(detectSentPrompt(summary(first, 1, 0), summary(first, 1, 1))).toBe(
      true,
    );
  });

  it('detects a prompt queued alongside one moving into the transcript', () => {
    expect(
      detectSentPrompt(
        summary(first, 1, 1),
        summary({ id: 'u2', timestamp: 2_000 }, 2, 2),
      ),
    ).toBe(true);
  });

  it('detects replacement of a queued prompt without a count change', () => {
    const previous = { ...summary(first, 1, 1), queuedIds: ['q1'] };
    const next = { ...summary(first, 1, 1), queuedIds: ['q2'] };
    expect(detectSentPrompt(previous, next)).toBe(true);
  });

  it('detects a dequeue batched with a new enqueue at the same queue count', () => {
    const previous = { ...summary(first, 1, 1), queuedIds: ['q1'] };
    const next = {
      ...summary({ id: 'u2', timestamp: 2_000 }, 2, 1),
      queuedIds: ['q2'],
    };
    expect(detectSentPrompt(previous, next)).toBe(true);
  });

  it('ignores queue reorder and edits with stable identities', () => {
    const previous = { ...summary(first, 1, 2), queuedIds: ['q1', 'q2'] };
    const next = { ...summary(first, 1, 2), queuedIds: ['q2', 'q1'] };
    expect(detectSentPrompt(previous, next)).toBe(false);
  });

  it('ignores restoration of an observed queue entry but detects a fresh enqueue', () => {
    const previous = {
      ...summary(first, 1),
      queuedIds: [],
      seenQueuedIds: new Set(['q1']),
    };
    expect(
      detectSentPrompt(previous, {
        ...summary(first, 1, 1),
        queuedIds: ['q1'],
      }),
    ).toBe(false);
    expect(
      detectSentPrompt(previous, {
        ...summary(first, 1, 1),
        queuedIds: ['q2'],
      }),
    ).toBe(true);
  });

  it('ignores a previously queued send delivered after queue removal', () => {
    const previous = {
      ...summary(first, 1),
      seenQueuedPromptIds: new Set(['u2']),
    };
    expect(
      detectSentPrompt(previous, summary({ id: 'u2', timestamp: 2_000 }, 2)),
    ).toBe(false);
    expect(
      detectSentPrompt(previous, summary({ id: 'u3', timestamp: 3_000 }, 2)),
    ).toBe(true);
  });

  it('ignores a queued prompt moving into the transcript', () => {
    expect(
      detectSentPrompt(
        summary(first, 1, 1),
        summary({ id: 'u2', timestamp: 2_000 }, 2, 0),
      ),
    ).toBe(false);
  });

  it('ignores an optimistic row trading its id for the persisted one', () => {
    expect(
      detectSentPrompt(
        summary({ id: 'optimistic-1', timestamp: 2_000 }, 2),
        summary({ id: 'u2', timestamp: 2_001 }, 2),
      ),
    ).toBe(false);
  });

  it('ignores older history loading in above', () => {
    expect(detectSentPrompt(summary(first, 1), summary(first, 5))).toBe(false);
  });

  it('ignores updates that leave the human prompts unchanged', () => {
    expect(detectSentPrompt(summary(first, 1, 1), summary(first, 1, 1))).toBe(
      false,
    );
  });

  it('ignores prompts and queue entries going away', () => {
    expect(
      detectSentPrompt(
        summary({ id: 'u2', timestamp: 2_000 }, 2, 1),
        summary(first, 1, 0),
      ),
    ).toBe(false);
    expect(detectSentPrompt(summary(first, 1), summary(null, 0))).toBe(false);
  });

  it('ignores a latest prompt older than the previous one', () => {
    expect(
      detectSentPrompt(
        summary({ id: 'u2', timestamp: 2_000 }, 2),
        summary({ id: 'u0', timestamp: 500 }, 3),
      ),
    ).toBe(false);
  });
});
