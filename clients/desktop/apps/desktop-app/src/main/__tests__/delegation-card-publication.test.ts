/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import {
  DELEGATION_CARD_ACTIVE_INTERVAL_MS,
  DELEGATION_CARD_SETTLED_INTERVAL_MS,
  DelegationCardPublisher,
} from '../agents/delegation/card-publication';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type { ChatEvent } from '@canopy/desktop-shared/types';
import {
  ChatEventOutputDecoder,
  type ChatEventMessage,
} from '@canopy/desktop-shared/lib/chat-event-output';
import { runtimeChatEventToPortalMessage } from '@canopy/desktop-shared/portal/runtime-chat-projection';
import {
  applyClaudeTranscriptEvent,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';
import { ChatEventOutputDelivery } from '../ipc/chat-event-output';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';

function transcript(
  sequence: number,
  snapshot: Partial<AgentDelegationSnapshot> = {},
  delegationId = 'child',
): AgentDelegationTranscript {
  return {
    delegationId,
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
    transcript: [
      {
        id: `item-${String(sequence)}`,
        sequence,
        occurredAt: sequence,
        type: 'text',
        text: `progress ${String(sequence)}`,
      },
    ],
    snapshot: {
      delegationId,
      status: 'running',
      outputTruncated: false,
      partialText: `partial ${String(sequence)}`,
      ...snapshot,
    },
  };
}

describe('DelegationCardPublisher', () => {
  let clock: number;
  let timers: Array<{
    at: number;
    run: () => void;
    cleared: boolean;
    handle: ReturnType<typeof setTimeout>;
  }>;
  let published: AgentDelegationTranscript[];
  let parentActive: boolean;
  let publisher: DelegationCardPublisher;

  const advance = (ms: number): void => {
    clock += ms;
    for (const timer of timers.slice())
      if (!timer.cleared && timer.at <= clock) {
        timer.cleared = true;
        timer.run();
      }
  };
  const sequences = (): number[] => published.map((entry) => entry.sequence);

  beforeEach(() => {
    resetWorkCounters();
    clock = 1_000_000;
    timers = [];
    published = [];
    parentActive = false;
    publisher = new DelegationCardPublisher({
      publish: (entry) => published.push(entry),
      parentTurnActive: () => parentActive,
      now: () => clock,
      setTimer: (run, ms) => {
        const handle = setTimeout(() => undefined, 0);
        clearTimeout(handle);
        timers.push({ at: clock + ms, run, cleared: false, handle });
        return handle;
      },
      clearTimer: (handle) => {
        for (const timer of timers)
          if (timer.handle === handle) timer.cleared = true;
      },
    });
  });

  afterEach(() => publisher.dispose());

  it('coalesces active-parent progress to the 2 s deadline with the newest snapshot', () => {
    parentActive = true;
    publisher.offer(transcript(1));
    expect(sequences()).toEqual([1]);
    advance(800);
    publisher.offer(transcript(2));
    advance(900);
    publisher.offer(transcript(3));
    expect(sequences()).toEqual([1]);
    advance(DELEGATION_CARD_ACTIVE_INTERVAL_MS - 1_701);
    expect(sequences()).toEqual([1]);
    advance(1);
    expect(sequences()).toEqual([1, 3]);
    expect(published[1]).toEqual(transcript(3));
  });

  it('publishes active-parent prompt-visible changes and terminal results immediately', () => {
    parentActive = true;
    publisher.offer(transcript(1));

    publisher.offer(transcript(2, { status: 'pending' }));
    expect(sequences()).toEqual([1, 2]);
    publisher.offer(
      transcript(3, { status: 'pending', approvalPending: true }),
    );
    expect(sequences()).toEqual([1, 2, 3]);
    publisher.offer(
      transcript(4, {
        status: 'pending',
        approvalPending: true,
        control: { operationId: 'op', operation: 'steer', status: 'accepted' },
      }),
    );
    expect(sequences()).toEqual([1, 2, 3, 4]);
    publisher.offer(
      transcript(5, {
        status: 'pending',
        approvalPending: true,
        control: { operationId: 'op', operation: 'steer', status: 'accepted' },
        stopRequested: { operationId: 'stop', status: 'accepted' },
      }),
    );
    expect(sequences()).toEqual([1, 2, 3, 4, 5]);
    const terminal = transcript(6, { status: 'completed', finalText: 'Done' });
    publisher.offer(terminal);
    expect(published[published.length - 1]).toBe(terminal);
    expect(sequences()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('publishes an active-parent interruption at once and keeps the run cadenced after it', () => {
    // `interrupted` is settled but resumable, so it is not a terminal status:
    // it publishes as a status change and the run keeps its published state.
    parentActive = true;
    publisher.offer(transcript(1));
    advance(500);
    const interrupted = transcript(2, { status: 'interrupted' });
    publisher.offer(interrupted);
    expect(published[published.length - 1]).toBe(interrupted);
    expect(sequences()).toEqual([1, 2]);
    advance(500);
    publisher.offer(transcript(3, { status: 'interrupted' }));
    expect(sequences()).toEqual([1, 2]);
    advance(DELEGATION_CARD_ACTIVE_INTERVAL_MS - 500);
    expect(sequences()).toEqual([1, 2, 3]);
  });

  it('publishes active-parent progress immediately after a full interval without pending work', () => {
    parentActive = true;
    publisher.offer(transcript(1));
    advance(DELEGATION_CARD_ACTIVE_INTERVAL_MS);
    publisher.offer(transcript(2));
    expect(sequences()).toEqual([1, 2]);
  });

  it('shortens a settled pending deadline when a newer offer arrives while active', () => {
    publisher.offer(transcript(1));
    advance(1_000);
    publisher.offer(transcript(2));
    advance(500);
    parentActive = true;
    publisher.offer(transcript(3));
    expect(sequences()).toEqual([1]);
    advance(DELEGATION_CARD_ACTIVE_INTERVAL_MS - 1_501);
    expect(sequences()).toEqual([1]);
    advance(1);
    expect(sequences()).toEqual([1, 3]);
  });

  it('coalesces settled-parent progress to one publish per window with the newest snapshot', () => {
    publisher.offer(transcript(1));
    for (let sequence = 2; sequence <= 20; sequence += 1) {
      advance(400);
      publisher.offer(transcript(sequence));
    }
    // 19 progress events over 7.6 s: only the first appearance so far.
    expect(sequences()).toEqual([1]);
    advance(DELEGATION_CARD_SETTLED_INTERVAL_MS - 7_601);
    expect(sequences()).toEqual([1]);
    advance(1);
    expect(sequences()).toEqual([1, 20]);
    expect(published[1]).toEqual(transcript(20));
  });

  it('publishes prompt-visible changes immediately and supersedes the pending snapshot', () => {
    publisher.offer(transcript(1));
    publisher.offer(transcript(2));
    publisher.offer(transcript(3, { approvalPending: true }));
    publisher.offer(transcript(4, { approvalPending: true }));
    publisher.offer(transcript(5, { approvalPending: false }));
    publisher.offer(
      transcript(6, {
        control: { operationId: 'op', operation: 'steer', status: 'accepted' },
      }),
    );
    publisher.offer(
      transcript(7, {
        stopRequested: { operationId: 'stop', status: 'accepted' },
      }),
    );
    publisher.offer(transcript(8, { status: 'completed', finalText: 'Done' }));
    expect(sequences()).toEqual([1, 3, 5, 6, 7, 8]);
    advance(DELEGATION_CARD_SETTLED_INTERVAL_MS * 2);
    // The superseded progress snapshots never publish late over the result.
    expect(sequences()).toEqual([1, 3, 5, 6, 7, 8]);
  });

  it.each(['completed', 'failed', 'cancelled', 'deadline_exceeded'] as const)(
    'publishes the %s terminal snapshot at once and identically',
    (status) => {
      publisher.offer(transcript(1));
      publisher.offer(transcript(2));
      const terminal = transcript(3, { status });
      publisher.offer(terminal);
      expect(published[published.length - 1]).toBe(terminal);
    },
  );

  it('keeps runs independent and ignores out-of-order snapshots', () => {
    publisher.offer(transcript(1));
    publisher.offer(transcript(1, {}, 'sibling'));
    publisher.offer(transcript(3));
    publisher.offer(transcript(2));
    expect(published.map((entry) => entry.delegationId)).toEqual([
      'child',
      'sibling',
    ]);
    advance(DELEGATION_CARD_SETTLED_INTERVAL_MS);
    expect(sequences()).toEqual([1, 1, 3]);
  });

  it('rejects stale and duplicate snapshots after an immediate publish', () => {
    publisher.offer(transcript(2));
    publisher.offer(transcript(1));
    publisher.offer(transcript(2));
    publisher.flush();
    expect(sequences()).toEqual([2]);

    publisher.offer(transcript(3, { status: 'completed' }));
    publisher.offer(transcript(2, { status: 'running' }));
    publisher.flush();
    expect(sequences()).toEqual([2, 3]);
  });

  it('counts only accepted offers and counts a coalesced snapshot once when published', () => {
    publisher.offer(transcript(1));
    publisher.offer(transcript(1)); // stale sequence is discarded
    publisher.offer(transcript(2));
    publisher.offer(transcript(3));

    expect(snapshotWorkCounters().provider).toEqual({
      'delegationSnapshots.offered': 3,
      'delegationSnapshots.published': 1,
    });
    advance(DELEGATION_CARD_SETTLED_INTERVAL_MS);
    expect(snapshotWorkCounters().provider).toEqual({
      'delegationSnapshots.offered': 3,
      'delegationSnapshots.published': 2,
    });
  });

  it('flushes the latest pending snapshot immediately on flush()', () => {
    publisher.offer(transcript(1));
    publisher.offer(transcript(2));
    parentActive = true;
    publisher.offer(transcript(3));
    expect(sequences()).toEqual([1]);
    publisher.flush();
    expect(sequences()).toEqual([1, 3]);
    parentActive = false;
    advance(DELEGATION_CARD_SETTLED_INTERVAL_MS);
    publisher.offer(transcript(4));
    publisher.offer(transcript(5));
    publisher.flush();
    expect(sequences()).toEqual([1, 3, 4, 5]);
  });

  it('drops pending snapshots on dispose for restart recovery to reconcile', () => {
    publisher.offer(transcript(1));
    publisher.offer(transcript(2));
    publisher.dispose();
    advance(DELEGATION_CARD_SETTLED_INTERVAL_MS);
    publisher.offer(transcript(3, { status: 'completed' }));
    expect(sequences()).toEqual([1]);
  });
});

describe('delegate cards delivered to a page as transcript appends', () => {
  /** A child run's snapshots as the recorder grows them. */
  function growingRun(publications: number): AgentDelegationTranscript[] {
    const items: AgentDelegationTranscriptItem[] = [];
    const runs: AgentDelegationTranscript[] = [];
    let partial = '';
    for (let index = 0; index < publications; index += 1) {
      const last = items[items.length - 1];
      if (index % 5 === 0 || !last) {
        const sequence = items.length + 1;
        items.push(
          index % 10 === 5
            ? {
                id: `tool-${String(sequence)}`,
                sequence,
                occurredAt: sequence,
                type: 'tool',
                toolName: 'Bash',
                input: `run ${String(sequence)}`,
              }
            : {
                id: `text-${String(sequence)}`,
                sequence,
                occurredAt: sequence,
                type: 'text',
                text: `step ${String(sequence)} `,
              },
        );
      } else if (last.type === 'tool') {
        items[items.length - 1] = {
          ...last,
          output: `${last.output ?? ''}${'o'.repeat(300)}\n`,
          isError: false,
        };
      } else {
        items[items.length - 1] = {
          ...last,
          text: `${last.text}${'t'.repeat(300)} `,
        };
      }
      partial += `${'p'.repeat(300)} `;
      const base = transcript(index + 1);
      runs.push({
        ...base,
        // Each publication carries fresh objects, as the lifecycle reducer
        // rebuilds them; the segment's progress text keeps growing.
        transcript: items.map((item) => ({ ...item })),
        snapshot: { ...base.snapshot, partialText: partial },
      });
    }
    return runs;
  }

  function chatEvent(delegation: AgentDelegationTranscript): ChatEvent {
    return {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'parent',
      data: {
        type: 'canopy_delegation',
        delegation,
        canopy_turn_user_message_id: 'turn',
      },
    };
  }

  function deliver(events: readonly ChatEvent[]): {
    received: ChatEvent[];
    bytes: number[];
  } {
    const delivery = new ChatEventOutputDelivery();
    const target = {};
    const decoder = new ChatEventOutputDecoder({
      newEpoch: () => 'epoch-1',
      requestReset: (epoch) => {
        delivery.reset(target, epoch);
        return Promise.resolve();
      },
    });
    const received: ChatEvent[] = [];
    const bytes: number[] = [];
    for (const event of events) {
      const message = delivery.encode(target, event);
      bytes.push(Buffer.byteLength(JSON.stringify(message)));
      const decoded = decoder.decode(
        structuredClone(message) as ChatEventMessage,
      );
      if (decoded) received.push(decoded);
    }
    return { received, bytes };
  }

  /** The compatibility reducer's card, and the shared store's projection. */
  function materialized(events: readonly ChatEvent[]): unknown {
    let state: TranscriptReducerState = {
      messages: [],
      status: 'streaming',
      error: null,
      planMode: false,
    };
    const projected: unknown[] = [];
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1);
    try {
      for (const event of events) {
        if (typeof event.data !== 'object' || event.data === null) continue;
        state = applyClaudeTranscriptEvent(
          state,
          event.data as Record<string, unknown>,
          {
            now: 1,
            createMessageId: () => 'message',
            childToolLiveness: { kind: 'unknown' },
          },
        );
        projected.push(
          runtimeChatEventToPortalMessage({
            scope: 'worktree',
            workspaceLocalId: event.projectId,
            worktreeLocalId: event.worktreeId,
            chatId: event.chatId,
            data: event.data,
          }),
        );
      }
    } finally {
      nowSpy.mockRestore();
    }
    return { messages: state.messages, projected };
  }

  it('materializes the same card as full snapshots, with flat bytes per publication', () => {
    const published: AgentDelegationTranscript[] = [];
    const publisher = new DelegationCardPublisher({
      publish: (entry) => published.push(entry),
      parentTurnActive: () => true,
      activeIntervalMs: 0,
    });
    for (const run of growingRun(200)) publisher.offer(run);
    expect(published).toHaveLength(200);
    const events = published.map(chatEvent);

    const { received, bytes } = deliver(events);

    expect(received).toStrictEqual(events);
    expect(materialized(received)).toStrictEqual(materialized(events));
    const fullBytes = events.map((event) =>
      Buffer.byteLength(JSON.stringify(event)),
    );
    const sum = (values: number[]): number =>
      values.reduce((total, value) => total + value, 0);
    expect(
      sum(fullBytes.slice(-8)) / sum(fullBytes.slice(1, 9)),
    ).toBeGreaterThan(10);
    expect(sum(bytes.slice(-8)) / sum(bytes.slice(1, 9))).toBeLessThan(1.5);
  });

  it('keeps the stale and duplicate snapshot rules: the page sees what full snapshots show', () => {
    const runs = growingRun(12);
    const at = (index: number): AgentDelegationTranscript => {
      const run = runs[index];
      if (!run) throw new Error(`missing run ${String(index)}`);
      return run;
    };
    // The publisher drops a stale or repeated sequence before it is sent.
    const published: AgentDelegationTranscript[] = [];
    const publisher = new DelegationCardPublisher({
      publish: (entry) => published.push(entry),
      parentTurnActive: () => true,
      activeIntervalMs: 0,
    });
    for (const index of [0, 1, 2, 1, 2, 3]) publisher.offer(at(index));
    expect(published.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);

    // A stale or duplicate snapshot that reaches the channel anyway (another
    // publication path) is delivered exactly, and the card ignores it as it
    // ignores the full snapshot.
    const events = [0, 1, 2, 5, 3, 5, 5, 6, 11, 4, 11].map((index) =>
      chatEvent(at(index)),
    );
    const { received } = deliver(events);
    expect(received).toStrictEqual(events);
    expect(materialized(received)).toStrictEqual(materialized(events));
  });

  it('never shares an item object between decoded snapshots', () => {
    const events = growingRun(6).map(chatEvent);
    const { received } = deliver(events);
    const items = received.map((event) => {
      const data = event.data as { delegation: AgentDelegationTranscript };
      return data.delegation.transcript;
    });
    for (let index = 1; index < items.length; index += 1) {
      const previous = new Set<unknown>(items[index - 1]);
      for (const item of items[index] ?? [])
        expect(previous.has(item)).toBe(false);
    }
  });
});
