import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  DELEGATION_LOG_FLUSH_INTERVAL_MS,
  DelegationLogWriter,
} from '../agents/delegation/log-writer';
import type { DelegationRun } from '../lib/chat-delegation-log';

function item(
  id: string,
  sequence: number,
  text: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text };
}

function snapshot(
  sequence: number,
  transcript: AgentDelegationTranscriptItem[],
  status: AgentDelegationSnapshot['status'] = 'running',
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
    transcript,
    snapshot: { delegationId, status, outputTruncated: false },
  };
}

describe('DelegationLogWriter', () => {
  let appended: Array<{ run: DelegationRun; ids: string[] }>;
  let calls: number;
  let fail: boolean;
  let writer: DelegationLogWriter;
  let errors: unknown[];

  beforeEach(() => {
    jest.useFakeTimers();
    appended = [];
    calls = 0;
    errors = [];
    fail = false;
    writer = new DelegationLogWriter({
      append: (runs): Promise<void> => {
        if (fail) return Promise.reject(new Error('scope is deleting'));
        calls += 1;
        for (const { run, items } of runs)
          appended.push({ run, ids: items.map((entry) => entry.id) });
        return Promise.resolve();
      },
      onError: (error): void => {
        errors.push(error);
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('appends every run pending in a window in one call', async () => {
    void writer.offer(snapshot(1, [item('a', 1, 'x')], 'running', 'one'));
    void writer.offer(snapshot(1, [item('b', 1, 'y')], 'running', 'two'));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(calls).toBe(1);
    expect(appended).toEqual([
      { run: { delegationId: 'one', runGeneration: 1 }, ids: ['a'] },
      { run: { delegationId: 'two', runGeneration: 1 }, ids: ['b'] },
    ]);
  });

  it('does not rewrite a settled run when it reports again', async () => {
    const items = [item('a', 1, 'x'), item('b', 2, 'y')];
    await writer.offer(snapshot(1, items, 'completed'));
    // A settled run still reports, for example when its result reaches the
    // parent; its items are already in the log.
    await writer.offer(snapshot(2, items, 'completed'));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(appended).toEqual([
      { run: { delegationId: 'child', runGeneration: 1 }, ids: ['a', 'b'] },
    ]);
  });

  it('writes one batch per window with only new and changed items', async () => {
    void writer.offer(snapshot(1, [item('a', 1, 'x')]));
    void writer.offer(snapshot(2, [item('a', 1, 'x'), item('b', 2, 'y')]));
    void writer.offer(snapshot(3, [item('a', 1, 'x'), item('b', 2, 'yz')]));
    expect(appended).toEqual([]);
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(appended).toEqual([
      { run: { delegationId: 'child', runGeneration: 1 }, ids: ['a', 'b'] },
    ]);

    // An unchanged snapshot writes nothing.
    void writer.offer(snapshot(4, [item('a', 1, 'x'), item('b', 2, 'yz')]));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(appended).toHaveLength(1);
  });

  it('writes a settled run at once and resolves when it is in the log', async () => {
    void writer.offer(snapshot(1, [item('a', 1, 'x')]));
    const settled = writer.offer(
      snapshot(2, [item('a', 1, 'x'), item('b', 2, 'done')], 'completed'),
    );
    await settled;
    expect(appended).toEqual([
      { run: { delegationId: 'child', runGeneration: 1 }, ids: ['a', 'b'] },
    ]);
  });

  it('rewrites what a failed write held on the run’s next snapshot', async () => {
    fail = true;
    void writer.offer(snapshot(1, [item('a', 1, 'x')]));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(errors).toHaveLength(1);
    fail = false;
    void writer.offer(snapshot(2, [item('a', 1, 'x')]));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(appended).toEqual([
      { run: { delegationId: 'child', runGeneration: 1 }, ids: ['a'] },
    ]);
  });

  it('writes an item changed in place, whatever part of it changed', async () => {
    const head = 'a'.repeat(200);
    const tail = 'b'.repeat(80);
    const tool = (toolName: string): AgentDelegationTranscriptItem => ({
      id: 'tool',
      sequence: 2,
      occurredAt: 2,
      type: 'tool',
      toolName,
      input: '{}',
    });
    void writer.offer(snapshot(1, [item('a', 1, head + tail), tool('Read')]));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    // The same length and ending, corrected earlier in the text; and a tool
    // whose name changed.
    void writer.offer(
      snapshot(2, [item('a', 1, 'c'.repeat(200) + tail), tool('Grep')]),
    );
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(appended).toEqual([
      { run: { delegationId: 'child', runGeneration: 1 }, ids: ['a', 'tool'] },
      { run: { delegationId: 'child', runGeneration: 1 }, ids: ['a', 'tool'] },
    ]);
  });

  it('flushes pending items on dispose and then ignores snapshots', async () => {
    void writer.offer(snapshot(1, [item('a', 1, 'x')], 'running', 'one'));
    void writer.offer(snapshot(1, [item('b', 1, 'y')], 'running', 'two'));
    await writer.dispose();
    expect(appended.map((entry) => entry.run.delegationId)).toEqual([
      'one',
      'two',
    ]);
    void writer.offer(snapshot(2, [item('c', 2, 'z')]));
    await jest.advanceTimersByTimeAsync(DELEGATION_LOG_FLUSH_INTERVAL_MS);
    expect(appended).toHaveLength(2);
  });
});
