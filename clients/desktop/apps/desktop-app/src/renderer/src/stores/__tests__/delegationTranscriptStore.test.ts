/**
 * @jest-environment jsdom
 */
import type {
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  DELEGATION_TRANSCRIPT_RUN_LIMIT,
  delegationRunKey,
  holdDelegationRun,
  useDelegationTranscriptStore,
} from '../delegationTranscriptStore';

const TARGET = { projectId: 'project', worktreeId: 'tree', chatId: 'chat' };
const RUN = { delegationId: 'child', runGeneration: 1 };
const KEY = delegationRunKey(TARGET, RUN);

function text(
  id: string,
  sequence: number,
  value: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text: value };
}

function snapshot(
  sequence: number,
  transcript: AgentDelegationTranscriptItem[],
  patch = false,
): AgentDelegationTranscript {
  return {
    ...RUN,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'spawn',
    createdAt: 1,
    transcriptStore: 'chat-log-v1',
    task: {
      description: 'Review',
      prompt: 'Review',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: RUN.delegationId,
      status: 'running',
      outputTruncated: false,
    },
    transcript,
    ...(patch ? { transcriptMode: 'patch' as const } : {}),
  };
}

function liveItems(): string[] {
  return (
    useDelegationTranscriptStore
      .getState()
      .runs[
        KEY
      ]?.live?.transcript.map((item) => `${item.id}:${item.type === 'text' ? item.text : ''}`) ??
    []
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe('useDelegationTranscriptStore', () => {
  let transcript: jest.Mock;

  beforeEach(() => {
    useDelegationTranscriptStore.getState().reset();
    transcript = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcript } },
    });
  });

  it('merges a patch of changed items into the items it holds', () => {
    const { applyLive } = useDelegationTranscriptStore.getState();
    applyLive(TARGET, snapshot(1, [text('a', 1, 'x'), text('b', 2, 'y')]));
    applyLive(
      TARGET,
      snapshot(2, [text('b', 2, 'yz'), text('c', 3, 'w')], true),
    );
    expect(liveItems()).toEqual(['a:x', 'b:yz', 'c:w']);
    expect(transcript).not.toHaveBeenCalled();
  });

  it('reads the delegate log for a patch whose earlier items it never saw', async () => {
    transcript.mockResolvedValue({
      ok: true,
      items: [text('a', 1, 'logged'), text('b', 2, 'old')],
    });
    useDelegationTranscriptStore
      .getState()
      .applyLive(TARGET, snapshot(4, [text('b', 2, 'new')], true));
    await settle();
    expect(transcript).toHaveBeenCalledWith({ ...TARGET, ...RUN });
    // The live item is newer than its logged version.
    expect(liveItems()).toEqual(['a:logged', 'b:new']);
  });

  it('reads the delegate log for a card-only patch', async () => {
    transcript.mockResolvedValue({ ok: true, items: [text('a', 1, 'x')] });
    useDelegationTranscriptStore
      .getState()
      .applyLive(TARGET, snapshot(3, [], true));
    await settle();
    expect(transcript).toHaveBeenCalledTimes(1);
    expect(liveItems()).toEqual(['a:x']);
  });

  it('keeps an archived or history copy of the chat apart from the live chat', async () => {
    transcript.mockResolvedValue({
      ok: true,
      items: [text('a', 1, 'archived')],
    });
    useDelegationTranscriptStore
      .getState()
      .applyLive(TARGET, snapshot(1, [text('a', 1, 'live')]));
    const archived = { ...TARGET, archivedContainerId: 'archive' };
    const history = { ...TARGET, standaloneHistory: true };
    expect(
      new Set([
        KEY,
        delegationRunKey(archived, RUN),
        delegationRunKey(history, RUN),
      ]).size,
    ).toBe(3);
    useDelegationTranscriptStore.getState().load(archived, RUN);
    await settle();
    expect(transcript).toHaveBeenCalledWith({
      ...TARGET,
      ...RUN,
      archivedContainerId: 'archive',
    });
    const { runs } = useDelegationTranscriptStore.getState();
    expect(runs[delegationRunKey(archived, RUN)]?.logged).toEqual([
      text('a', 1, 'archived'),
    ]);
    expect(liveItems()).toEqual(['a:live']);
  });

  it('keeps a held run past the run limit and evicts runs no card holds', () => {
    const release = holdDelegationRun(KEY);
    try {
      const { applyLive } = useDelegationTranscriptStore.getState();
      applyLive(TARGET, snapshot(1, [text('a', 1, 'held')]));
      const others = Array.from(
        { length: DELEGATION_TRANSCRIPT_RUN_LIMIT + 1 },
        (_, index) => `other-${String(index)}`,
      );
      for (const delegationId of others)
        applyLive(TARGET, {
          ...snapshot(1, [text('a', 1, delegationId)]),
          delegationId,
        });
      const { runs, order } = useDelegationTranscriptStore.getState();
      expect(liveItems()).toEqual(['a:held']);
      expect(order).toHaveLength(DELEGATION_TRANSCRIPT_RUN_LIMIT);
      // The oldest runs no card holds were evicted.
      expect(
        runs[delegationRunKey(TARGET, { ...RUN, delegationId: 'other-0' })],
      ).toBeUndefined();
    } finally {
      release();
    }
  });

  it('replaces its items with a whole transcript', () => {
    const { applyLive } = useDelegationTranscriptStore.getState();
    applyLive(TARGET, snapshot(1, [text('a', 1, 'x'), text('b', 2, 'y')]));
    applyLive(TARGET, snapshot(2, [text('a', 1, 'x2')]));
    expect(liveItems()).toEqual(['a:x2']);
  });
});
