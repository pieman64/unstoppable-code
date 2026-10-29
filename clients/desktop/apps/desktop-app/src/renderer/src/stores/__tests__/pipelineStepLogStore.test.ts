import type {
  IPCResult,
  StepLogReadResult,
  StepOutputEvent,
} from '@canopy/desktop-shared/types/pipeline';
import {
  STEP_LOG_DESCENDANT_MAX_BYTES,
  STEP_LOG_HEURISTIC_LIVE_MAX_BYTES,
  STEP_LOG_PENDING_MAX_BYTES,
  acquireStepLogInterest,
  getStepLogInterestCount,
  getStepLogView,
  hasStepLogInterestForExecution,
  inspectStepLogInterest,
  resetStepLogStoreForTests,
  resetStepLogsForExecution,
  routeStepOutputEvents,
  subscribeStepLog,
} from '../pipelineStepLogStore';

type ReadResponse = IPCResult<StepLogReadResult>;

interface PendingRead {
  locator: unknown;
  options: unknown;
  resolve: (response: ReadResponse) => void;
}

const reads: PendingRead[] = [];

function readStepLog(
  locator: unknown,
  options: unknown,
): Promise<ReadResponse> {
  return new Promise<ReadResponse>((resolve) => {
    reads.push({ locator, options, resolve });
  });
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function respond(index: number, data: StepLogReadResult): Promise<void> {
  reads[index].resolve({ success: true, data });
  await flushAsyncWork();
}

const IDENTITY = {
  executionId: 'exec-1',
  jobId: 'build',
  stepId: 'compile',
  attempt: 0,
};

function positioned(
  data: string,
  offset: number,
  generation = 1,
  overrides: Partial<StepOutputEvent> = {},
): StepOutputEvent {
  return {
    ...IDENTITY,
    jobName: 'Build',
    stepName: 'Compile',
    stream: 'stdout',
    data,
    logPosition: {
      generation,
      offset,
      byteLength: Buffer.byteLength(data, 'utf8'),
    },
    ...overrides,
  };
}

function unpositioned(
  data: string,
  overrides: Partial<StepOutputEvent> = {},
): StepOutputEvent {
  return {
    ...IDENTITY,
    jobName: 'Build',
    stepName: 'Compile',
    stream: 'stdout',
    data,
    ...overrides,
  };
}

function textSnapshot(text: string, generation?: number): StepLogReadResult {
  return {
    lines: [],
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    ...(generation !== undefined ? { generation } : {}),
  };
}

describe('pipelineStepLogStore', () => {
  beforeEach(() => {
    reads.length = 0;
    resetStepLogStoreForTests();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { pipelines: { readStepLog } },
    });
  });

  it('registers interest and buffers output before the snapshot read', async () => {
    expect(hasStepLogInterestForExecution('exec-1')).toBe(false);
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });

    expect(hasStepLogInterestForExecution('exec-1')).toBe(true);
    expect(reads).toHaveLength(1);
    expect(reads[0].options).toEqual({ format: 'text' });
    expect(getStepLogView(interest.key).status).toBe('loading');

    // Emitted while the read is in flight: one chunk the snapshot already
    // contains, one it does not.
    routeStepOutputEvents([positioned('one\n', 0), positioned('two\n', 4)]);
    expect(inspectStepLogInterest(interest.key)?.pendingEvents).toBe(2);

    await respond(0, textSnapshot('one\n', 1));

    expect(getStepLogView(interest.key)).toEqual({
      status: 'ready',
      lines: ['one', 'two'],
    });
    expect(inspectStepLogInterest(interest.key)?.pendingEvents).toBe(0);
    interest.release();
  });

  it('only accepts output for the exact attempt, iteration, and recovery', async () => {
    const interest = acquireStepLogInterest({
      identity: { ...IDENTITY, iteration: 2 },
      terminal: false,
    });
    await respond(0, textSnapshot(''));

    routeStepOutputEvents([
      unpositioned('iteration one\n', { iteration: 1 }),
      unpositioned('other attempt\n', { iteration: 2, attempt: 1 }),
      unpositioned('recovered\n', { iteration: 2, recovery: 1 }),
      unpositioned('other execution\n', {
        executionId: 'exec-2',
        iteration: 2,
      }),
      unpositioned('mine\n', { iteration: 2 }),
    ]);

    expect(getStepLogView(interest.key).lines).toEqual(['mine']);
    interest.release();
  });

  it('keeps the previous textual merge for unpositioned sources', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    await respond(0, { lines: ['persisted'] });

    routeStepOutputEvents([unpositioned('live-1\nli'), unpositioned('ve-2\n')]);

    expect(getStepLogView(interest.key).lines).toEqual([
      'persisted',
      'live-1',
      'live-2',
    ]);
    interest.release();
  });

  it('shows buffered live output when the first read fails', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    routeStepOutputEvents([unpositioned('streamed\n')]);
    reads[0].resolve({ success: false, error: 'EACCES' });
    await flushAsyncWork();

    expect(getStepLogView(interest.key)).toEqual({
      status: 'ready',
      lines: ['streamed'],
    });
    interest.release();
  });

  it('bounds buffered output by bytes and recovers with one authoritative re-read', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    const chunk = 'x'.repeat(64 * 1024);
    const chunkCount = Math.ceil(STEP_LOG_PENDING_MAX_BYTES / chunk.length) + 1;
    const events = Array.from({ length: chunkCount }, (_, index) =>
      positioned(chunk, index * chunk.length),
    );

    routeStepOutputEvents(events);

    const retained = inspectStepLogInterest(interest.key);
    expect(retained?.pendingBytes).toBeLessThanOrEqual(
      STEP_LOG_PENDING_MAX_BYTES,
    );
    expect(retained?.pendingEvents).toBeLessThan(chunkCount);

    // The read that overflowed is discarded: its join would be incomplete.
    await respond(0, textSnapshot('stale snapshot\n', 1));
    expect(reads).toHaveLength(2);
    expect(getStepLogView(interest.key).status).toBe('loading');

    const authoritative = `${chunk.repeat(chunkCount)}\n`;
    await respond(1, textSnapshot(authoritative, 1));
    expect(getStepLogView(interest.key).lines).toEqual([
      chunk.repeat(chunkCount),
    ]);
    expect(reads).toHaveLength(2);
    interest.release();
  });

  it('re-reads once while a positioned log is stale and joins the retained buffer', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    await respond(0, textSnapshot('a\n', 1));
    expect(getStepLogView(interest.key).lines).toEqual(['a']);

    // A chunk past the snapshot end: its preceding bytes were never observed.
    routeStepOutputEvents([positioned('c\n', 4)]);
    expect(inspectStepLogInterest(interest.key)).toMatchObject({
      stale: true,
      pendingEvents: 1,
      readInFlight: true,
    });
    routeStepOutputEvents([positioned('d\n', 6)]);
    expect(reads).toHaveLength(2);

    await respond(1, textSnapshot('a\nb\n', 1));
    expect(getStepLogView(interest.key).lines).toEqual(['a', 'b', 'c', 'd']);
    expect(inspectStepLogInterest(interest.key)).toMatchObject({
      stale: false,
      pendingEvents: 0,
    });
    interest.release();
  });

  it('re-reads exactly once when the step reaches a terminal state', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    await respond(0, { lines: ['persisted'] });
    routeStepOutputEvents([unpositioned('never persisted\n')]);
    expect(getStepLogView(interest.key).lines).toEqual([
      'persisted',
      'never persisted',
    ]);

    interest.setTerminal(true);
    interest.setTerminal(true);
    expect(reads).toHaveLength(2);

    // The settled log is the authority: output that was emitted but never
    // persisted does not survive the final read.
    await respond(1, { lines: ['persisted', 'final tail'] });
    expect(getStepLogView(interest.key).lines).toEqual([
      'persisted',
      'final tail',
    ]);
    expect(reads).toHaveLength(2);
    interest.release();
  });

  it('queues the terminal re-read behind an in-flight read', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    interest.setTerminal(true);
    expect(reads).toHaveLength(1);

    await respond(0, { lines: ['early'] });
    expect(reads).toHaveLength(2);
    await respond(1, { lines: ['early', 'late'] });
    expect(getStepLogView(interest.key).lines).toEqual(['early', 'late']);
    expect(reads).toHaveLength(2);
    interest.release();
  });

  it('does not re-read for an interest registered on an already settled step', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: true,
    });
    await respond(0, { lines: ['done'] });

    expect(reads).toHaveLength(1);
    expect(getStepLogView(interest.key).lines).toEqual(['done']);
    interest.release();
  });

  it('shares one interest between holders and discards it on the last release', async () => {
    const first = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    const second = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    expect(first.key).toBe(second.key);
    expect(reads).toHaveLength(1);
    expect(inspectStepLogInterest(first.key)?.refCount).toBe(2);

    first.release();
    first.release();
    expect(inspectStepLogInterest(first.key)?.refCount).toBe(1);

    second.release();
    expect(getStepLogInterestCount()).toBe(0);
    expect(hasStepLogInterestForExecution('exec-1')).toBe(false);

    // A late response after release is ignored, and output is dropped.
    await respond(0, { lines: ['late'] });
    routeStepOutputEvents([unpositioned('dropped\n')]);
    expect(getStepLogView(first.key)).toEqual({ status: 'loading', lines: [] });
  });

  it('publishes each log only to its own subscribers', async () => {
    const compile = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: false,
    });
    const test = acquireStepLogInterest({
      identity: { ...IDENTITY, stepId: 'test' },
      terminal: false,
    });
    await respond(0, textSnapshot(''));
    await respond(1, textSnapshot(''));
    const compileListener = jest.fn();
    const testListener = jest.fn();
    const unsubscribeCompile = subscribeStepLog(compile.key, compileListener);
    const unsubscribeTest = subscribeStepLog(test.key, testListener);

    routeStepOutputEvents([
      unpositioned('a\n'),
      unpositioned('b\n'),
      unpositioned('c\n'),
    ]);

    // One notification per frame batch, and none for the other log.
    expect(compileListener).toHaveBeenCalledTimes(1);
    expect(testListener).not.toHaveBeenCalled();
    const view = getStepLogView(compile.key);
    expect(getStepLogView(compile.key)).toBe(view);

    unsubscribeCompile();
    unsubscribeTest();
    compile.release();
    test.release();
  });

  it('a retry drops joined output and re-reads before new output merges onto it', async () => {
    const interest = acquireStepLogInterest({
      identity: IDENTITY,
      terminal: true,
    });
    await respond(0, { lines: ['first run'] });

    resetStepLogsForExecution('exec-1');
    expect(reads).toHaveLength(2);
    // The previous view stays until the new snapshot arrives.
    expect(getStepLogView(interest.key).lines).toEqual(['first run']);
    routeStepOutputEvents([unpositioned('second run\n')]);

    await respond(1, { lines: [] });
    expect(getStepLogView(interest.key).lines).toEqual(['second run']);
    interest.release();
  });
  describe('aggregated parent logs (composite and nested-pipeline steps)', () => {
    // The parent's own file holds only `[run]`/`[skip]` lines; its nested
    // steps' output reaches the parent only as live descendant events.
    function descendant(
      data: string,
      overrides: Partial<StepOutputEvent> = {},
    ): StepOutputEvent {
      return unpositioned(data, { stepId: 'compile/lint', ...overrides });
    }

    it('keeps descendant output across the terminal re-read', async () => {
      const interest = acquireStepLogInterest({
        identity: IDENTITY,
        terminal: false,
      });
      await respond(0, { lines: ['[run] lint'] });
      routeStepOutputEvents([
        descendant('lint output 1\n'),
        descendant('lint output 2\n'),
      ]);
      expect(getStepLogView(interest.key).lines).toEqual([
        '[run] lint',
        'lint output 1',
        'lint output 2',
      ]);

      interest.setTerminal(true);
      await respond(1, { lines: ['[run] lint', '[skip] test'] });

      expect(getStepLogView(interest.key).lines).toEqual([
        '[run] lint',
        '[skip] test',
        'lint output 1',
        'lint output 2',
      ]);
      interest.release();
    });

    it('does not duplicate descendant output the parent file already contains', async () => {
      const interest = acquireStepLogInterest({
        identity: IDENTITY,
        terminal: false,
      });
      await respond(0, { lines: ['[run] lint'] });
      routeStepOutputEvents([descendant('lint output\n')]);

      interest.setTerminal(true);
      await respond(1, { lines: ['[run] lint', 'lint output'] });

      expect(getStepLogView(interest.key).lines).toEqual([
        '[run] lint',
        'lint output',
      ]);
      interest.release();
    });

    it('keeps descendant output when a long unpositioned stream folds into a fresh read', async () => {
      const interest = acquireStepLogInterest({
        identity: IDENTITY,
        terminal: false,
      });
      await respond(0, { lines: ['[run] lint'] });
      routeStepOutputEvents([descendant('lint output\n')]);

      const ownLine = 'y'.repeat(1024 * 1024);
      // The last own line crosses the fold threshold, so no own output
      // arrives while the fold read is in flight.
      const ownLineCount = Math.ceil(
        STEP_LOG_HEURISTIC_LIVE_MAX_BYTES / (ownLine.length + 1),
      );
      routeStepOutputEvents(
        Array.from({ length: ownLineCount }, () =>
          unpositioned(`${ownLine}\n`),
        ),
      );
      expect(reads).toHaveLength(2);

      await respond(1, {
        lines: [
          '[run] lint',
          ...Array.from({ length: ownLineCount }, () => ownLine),
        ],
      });
      const lines = getStepLogView(interest.key).lines;
      expect(lines.filter((line) => line === 'lint output')).toHaveLength(1);
      expect(lines.filter((line) => line === ownLine)).toHaveLength(
        ownLineCount,
      );
      // The fold does not loop: retained descendant output is not own output.
      routeStepOutputEvents([descendant('lint output 2\n')]);
      expect(reads).toHaveLength(2);
      interest.release();
    });

    it('bounds retained descendant output by bytes, keeping the newest', async () => {
      const interest = acquireStepLogInterest({
        identity: IDENTITY,
        terminal: false,
      });
      await respond(0, { lines: ['[run] lint'] });
      const chunk = `${'z'.repeat(256 * 1024 - 1)}\n`;
      const chunkCount =
        Math.ceil(STEP_LOG_DESCENDANT_MAX_BYTES / chunk.length) + 2;
      for (let index = 0; index < chunkCount; index += 1) {
        routeStepOutputEvents([descendant(chunk)]);
        await flushAsyncWork();
        const pendingRead = reads.length - 1;
        if (reads[pendingRead] && pendingRead > 0) {
          // A trim folds retained output into a fresh parent read.
          await respond(pendingRead, { lines: ['[run] lint'] });
        }
      }
      routeStepOutputEvents([descendant('newest\n')]);

      expect(
        inspectStepLogInterest(interest.key)?.descendantBytes,
      ).toBeLessThanOrEqual(STEP_LOG_DESCENDANT_MAX_BYTES);
      expect(getStepLogView(interest.key).lines.at(-1)).toBe('newest');
      interest.release();
    });

    it('a retry drops retained descendant output', async () => {
      const interest = acquireStepLogInterest({
        identity: IDENTITY,
        terminal: false,
      });
      await respond(0, { lines: ['[run] lint'] });
      routeStepOutputEvents([descendant('first run\n')]);

      resetStepLogsForExecution('exec-1');
      await respond(1, { lines: [] });

      expect(getStepLogView(interest.key).lines).toEqual([]);
      interest.release();
    });
  });
});
