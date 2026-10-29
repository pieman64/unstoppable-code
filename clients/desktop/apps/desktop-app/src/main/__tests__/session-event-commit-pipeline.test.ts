/**
 * `SessionEventCommitPipeline`: the next provider event's commit may start
 * once the previous one holds its place in commit order, while delivery
 * stays in provider order and follows durability (phase 11, group commit).
 */
import {
  SessionEventCommitPipeline,
  isOverlappableProviderEvent,
} from '../lib/session-event-commit-pipeline';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

describe('isOverlappableProviderEvent', () => {
  it.each([
    [{ type: 'codex', event: { type: 'item.started', item: {} } }],
    [{ type: 'codex', event: { type: 'item.updated', item: {} } }],
    [{ type: 'codex', event: { type: 'item.completed', item: {} } }],
    [{ type: 'assistant', message: { content: [] } }],
    [{ type: 'user', message: { content: [] } }],
    [{ type: 'stream_event', event: {} }],
  ])('admits streamed turn content %j', (event) => {
    expect(isOverlappableProviderEvent(event)).toBe(true);
  });

  it.each([
    [{ type: 'codex', event: { type: 'turn.started' } }],
    [{ type: 'codex', event: { type: 'turn.completed' } }],
    [{ type: 'codex', event: { type: 'turn.failed' } }],
    [{ type: 'codex', event: { type: 'thread.started' } }],
    [{ type: 'codex' }],
    [{ type: 'result', result: 'done' }],
    [{ type: 'error', error: 'boom' }],
    [{ type: 'system', subtype: 'init' }],
    [{ type: 'assistant', error: 'authentication_failed' }],
    [{ type: 'user', is_error: true }],
    [{ type: 'assistant', canopy_turn_revival: true }],
    [{ type: 'canopy_input_delivery', phase: 'picked-up' }],
    [{ type: 'canopy_user_prompt' }],
    [{ type: 'canopy_auth_failure' }],
    [{ type: 'canopy_delegation' }],
    [{ type: 'turn_diff' }],
    ['text'],
    [null],
  ])('keeps %j alone', (event) => {
    expect(isOverlappableProviderEvent(event)).toBe(false);
  });
});

describe('isOverlappableProviderEvent with an errored tool result', () => {
  // A paired `canopy_auth_failure` follows an errored tool result. It is
  // queued when that event is delivered, so the event must run alone: an
  // event queued behind it (a turn's terminal event) would otherwise settle
  // the turn first, and the failure notice would be skipped.
  it.each([
    [
      'a Claude tool_result with is_error',
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'ok', is_error: false },
            { type: 'tool_result', tool_use_id: 'failed', is_error: true },
          ],
        },
      },
    ],
    [
      'a failed Codex dynamic tool call',
      {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            type: 'dynamic_tool_call',
            id: 'call-1',
            tool: 'canopy_watch_github_items',
            status: 'failed',
            success: false,
          },
        },
      },
    ],
  ])('does not overlap %s', (_label, event) => {
    expect(isOverlappableProviderEvent(event)).toBe(false);
  });

  it('still overlaps successful tool results', () => {
    expect(
      isOverlappableProviderEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'ok', is_error: false },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isOverlappableProviderEvent({
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            type: 'dynamic_tool_call',
            id: 'call-2',
            tool: 'canopy_watch_github_items',
            status: 'completed',
            success: true,
          },
        },
      }),
    ).toBe(true);
  });
});

describe('SessionEventCommitPipeline', () => {
  it('lets the next commit start once this one is queued, and delivers in order after durability', async () => {
    const pipeline = new SessionEventCommitPipeline();
    const log: string[] = [];
    const commits = [deferred<boolean>(), deferred<boolean>()];
    const submit = (
      index: number,
    ): ReturnType<SessionEventCommitPipeline['overlap']> =>
      pipeline.overlap(
        (markQueued) => {
          log.push(`commit ${index} started`);
          // The repository queues the commit's lease turn synchronously.
          markQueued();
          return commits[index].promise;
        },
        (outcome): void => {
          log.push(`delivered ${index} ${outcome.status}`);
        },
      );
    const first = submit(0);
    await first.queued;
    // The first commit is not durable, yet the second may start.
    const second = submit(1);
    await second.queued;
    expect(log).toEqual(['commit 0 started', 'commit 1 started']);
    expect(pipeline.pending).toBe(true);
    // The second commit settles first (same batch, or a faster path):
    // nothing is delivered before the first is durable.
    commits[1].resolve(true);
    await flush();
    expect(log).toEqual(['commit 0 started', 'commit 1 started']);
    commits[0].resolve(true);
    await Promise.all([first.completed, second.completed]);
    expect(log.slice(2)).toEqual([
      'delivered 0 fulfilled',
      'delivered 1 fulfilled',
    ]);
    expect(pipeline.pending).toBe(false);
  });

  it('holds the caller until the commit settles when it is never queued', async () => {
    const pipeline = new SessionEventCommitPipeline();
    const commit = deferred<boolean>();
    let queued = false;
    const submitted = pipeline.overlap(
      () => commit.promise,
      () => undefined,
    );
    void submitted.queued.then(() => {
      queued = true;
    });
    await flush();
    // No signal: one commit at a time, as without the pipeline.
    expect(queued).toBe(false);
    commit.resolve(true);
    await submitted.completed;
    expect(queued).toBe(true);
  });

  it('passes a failed commit to its completion and keeps the order', async () => {
    const pipeline = new SessionEventCommitPipeline();
    const log: string[] = [];
    const failing = deferred<boolean>();
    const first = pipeline.overlap(
      (markQueued) => {
        markQueued();
        return failing.promise;
      },
      (outcome): void => {
        log.push(`first ${outcome.status}`);
        if (outcome.status === 'rejected') throw outcome.reason;
      },
    );
    const second = pipeline.overlap(
      (markQueued) => {
        markQueued();
        return Promise.resolve(true);
      },
      (outcome): void => {
        log.push(`second ${outcome.status}`);
      },
    );
    failing.reject(new Error('batch failed'));
    await expect(first.completed).rejects.toThrow('batch failed');
    await second.completed;
    expect(log).toEqual(['first rejected', 'second fulfilled']);
    // A commit that throws synchronously is a rejected outcome, not a throw.
    const thrown = pipeline.overlap(
      (): Promise<boolean> => {
        throw new Error('sync failure');
      },
      (outcome): void => {
        log.push(`third ${outcome.status}`);
      },
    );
    await thrown.queued;
    await thrown.completed;
    expect(log).toEqual([
      'first rejected',
      'second fulfilled',
      'third rejected',
    ]);
    await pipeline.drained();
    expect(pipeline.pending).toBe(false);
  });

  it('drains every overlapped completion before an event that runs alone', async () => {
    const pipeline = new SessionEventCommitPipeline();
    const log: string[] = [];
    const commits = [deferred<boolean>(), deferred<boolean>()];
    commits.forEach((commit, index): void => {
      pipeline.overlap(
        (markQueued) => {
          markQueued();
          return commit.promise;
        },
        async (): Promise<void> => {
          await Promise.resolve();
          log.push(`delivered ${index}`);
        },
      );
    });
    const alone = pipeline.drained().then(() => log.push('alone'));
    commits[1].resolve(true);
    await flush();
    expect(log).toEqual([]);
    commits[0].resolve(true);
    await alone;
    expect(log).toEqual(['delivered 0', 'delivered 1', 'alone']);
  });
});
