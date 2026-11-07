import { randomUUID } from 'node:crypto';

import type { WorkerScriptExecutionOutputItem } from '@canopy/protocol/canopy-core';

import type { CanopyStreamSink } from '../../../../runtime/types';
import {
  createWorkerScriptHandlers,
  createWorkerScriptStreamHandlers,
  MAX_SCRIPT_OUTPUT_BYTES,
  WORKER_SCRIPT_OUTPUT_AWAIT_START_MS,
  type ScriptExecutionWorker,
} from '..';
import {
  SCOPE,
  createScriptWorkerFixture,
  describePosix,
  handlerContext,
  scriptParams,
  type ScriptWorkerFixture,
} from './script-worker-fixtures';

interface RecordingSink extends CanopyStreamSink<WorkerScriptExecutionOutputItem> {
  readonly items: WorkerScriptExecutionOutputItem[];
  ended: 'completed' | 'cancelled' | 'error' | null;
  backlog: number;
  readonly done: Promise<void>;
}

function recordingSink(): RecordingSink {
  let sequence = 0;
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sink: RecordingSink = {
    items: [],
    ended: null,
    backlog: 0,
    done,
    buffered: () => sink.backlog,
    emit: (item) => {
      if (sink.ended !== null) return null;
      sink.items.push(item);
      sequence += 1;
      return { daemonEpoch: 'test', sequence };
    },
    emitAt: () => null,
    end: (outcome) => {
      sink.ended = outcome;
      finish();
    },
    endAt: (_cursor, outcome) => {
      sink.ended = outcome;
      finish();
    },
  };
  return sink;
}

function linesOf(items: WorkerScriptExecutionOutputItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'lines' ? item.lines : []));
}

async function open(
  worker: ScriptExecutionWorker,
  executionId: string,
  awaitStart?: boolean,
): Promise<RecordingSink> {
  const sink = recordingSink();
  await createWorkerScriptStreamHandlers(worker)[
    'worker.script.execution.output'
  ](
    {
      scope: SCOPE,
      executionId,
      ...(awaitStart !== undefined ? { awaitStart } : {}),
    },
    handlerContext(),
    sink,
  );
  return sink;
}

describePosix('worker.script.execution.output', () => {
  let fixture: ScriptWorkerFixture;

  beforeEach(async () => {
    fixture = await createScriptWorkerFixture();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await fixture.cleanup();
  });

  it('streams started, every line and the end of a run it waited for', async () => {
    const params = scriptParams("printf 'a\\nb\\nc\\n'");
    const sink = await open(fixture.worker, params.executionId, true);
    await expect(fixture.worker.execute(params)).resolves.toMatchObject({
      status: 'success',
    });
    await sink.done;
    expect(sink.items[0]).toEqual({ kind: 'started' });
    expect(linesOf(sink.items)).toEqual(['a', 'b', 'c']);
    expect(sink.ended).toBe('completed');
  });

  it('ends at once for a run that is not executing', async () => {
    const sink = await open(fixture.worker, randomUUID());
    expect(sink.ended).toBe('completed');
    expect(sink.items).toEqual([]);
  });

  it('reports started at once for a run already running', async () => {
    const params = scriptParams('sleep 0.3');
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = fixture.worker.execute(params);
    await started;
    const sink = await open(fixture.worker, params.executionId);
    expect(sink.items).toEqual([{ kind: 'started' }]);
    await running;
    await sink.done;
    expect(sink.ended).toBe('completed');
  });

  it('streams the lines of an unrecorded run it subscribes to after the run starts', async () => {
    const params = scriptParams("sleep 0.3; printf 'late\\n'");
    delete params.record;
    const started = new Promise<void>((resolve) => {
      fixture.worker.observe(params.executionId, {
        onProcessStarted: resolve,
      });
    });
    const running = createWorkerScriptHandlers(fixture.worker).instructions[
      'worker.script.execute'
    ](params, handlerContext());
    await started;
    const sink = await open(fixture.worker, params.executionId);
    await expect(running).resolves.toMatchObject({ status: 'success' });
    await sink.done;
    expect(linesOf(sink.items)).toEqual(['late']);
  });

  it('keeps at most the output cap of a line that never ends', async () => {
    const params = scriptParams("head -c 600000 /dev/zero | tr '\\0' x");
    delete params.record;
    const lengths: number[] = [];
    fixture.worker.observe(params.executionId, {
      onLines: (lines) => lengths.push(...lines.map((line) => line.length)),
    });
    await expect(
      createWorkerScriptHandlers(fixture.worker).instructions[
        'worker.script.execute'
      ](params, handlerContext()),
    ).resolves.toMatchObject({ status: 'success' });
    expect(Math.max(...lengths)).toBe(MAX_SCRIPT_OUTPUT_BYTES);
  });

  it('keeps a long line of a recorded run whole for its run log', async () => {
    const params = scriptParams(
      "head -c 400000 /dev/zero | tr '\\0' x; printf 'TAIL\\n'",
    );
    const lines: string[] = [];
    fixture.worker.observe(params.executionId, {
      onLines: (chunk) => lines.push(...chunk),
    });
    await expect(
      createWorkerScriptHandlers(fixture.worker).instructions[
        'worker.script.execute'
      ](params, handlerContext()),
    ).resolves.toMatchObject({ status: 'success' });
    expect(lines[0]).toHaveLength(400_004);
    expect(lines[0]?.endsWith('TAIL')).toBe(true);
  });

  it('drops lines while the subscriber is behind and reports them in one gap', async () => {
    const sink = await open(fixture.worker, 'remote', true);
    const relay = fixture.worker.relay('remote');
    relay.processStarted();
    sink.backlog = 64;
    relay.lines(['a', 'b']);
    relay.lines(['c']);
    sink.backlog = 0;
    relay.lines(['d']);
    expect(sink.items).toEqual([
      { kind: 'started' },
      { kind: 'gap', droppedLines: 3 },
      { kind: 'lines', lines: ['d'], truncated: false },
    ]);
    relay.finished({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 0,
      outputBytes: 0,
      outputTruncated: false,
      failure: null,
    });
    expect(sink.ended).toBe('completed');
  });

  it('cuts long lines and marks the item truncated', async () => {
    const sink = await open(fixture.worker, 'remote', true);
    const relay = fixture.worker.relay('remote');
    relay.processStarted();
    relay.lines(['x'.repeat(10_000)]);
    expect(sink.items[1]).toEqual({
      kind: 'lines',
      lines: ['x'.repeat(8_192)],
      truncated: true,
    });
  });

  it('ends a waiting subscription when its run fails before its process starts', async () => {
    let refuse = (): void => undefined;
    const failing = await createScriptWorkerFixture({
      secrets: {
        redeem: () =>
          new Promise((_resolve, reject) => {
            refuse = (): void => reject(new Error('refused'));
          }),
      },
    });
    try {
      const params = scriptParams('echo never', {
        secrets: [
          {
            name: 'S',
            source: {
              kind: 'stored-secret',
              family: 'environment',
              record: 'config',
              ref: `ssr1_${'a'.repeat(43)}`,
            },
          },
        ],
      });
      const sink = recordingSink();
      await createWorkerScriptStreamHandlers(failing.worker, {
        awaitStartMs: 20,
      })['worker.script.execution.output'](
        { scope: SCOPE, executionId: params.executionId, awaitStart: true },
        handlerContext(),
        sink,
      );
      const running = failing.worker.execute(params);
      expect(failing.worker.executionState(params.executionId, SCOPE)).toBe(
        'starting',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sink.ended).toBeNull();
      refuse();
      await expect(running).rejects.toThrow('refused');
      await sink.done;
      expect(sink.ended).toBe('completed');
      expect(sink.items).toEqual([]);
    } finally {
      await failing.cleanup();
    }
  });

  it('reports no start for an unrecorded run that fails before its process starts', async () => {
    let refuse = (): void => undefined;
    const failing = await createScriptWorkerFixture({
      secrets: {
        redeem: () =>
          new Promise((_resolve, reject) => {
            refuse = (): void => reject(new Error('refused'));
          }),
      },
    });
    try {
      const params = scriptParams('echo never', {
        secrets: [
          {
            name: 'S',
            source: {
              kind: 'stored-secret',
              family: 'environment',
              record: 'config',
              ref: `ssr1_${'b'.repeat(43)}`,
            },
          },
        ],
      });
      delete params.record;
      const running = failing.worker.execute(params);
      const sink = recordingSink();
      await createWorkerScriptStreamHandlers(failing.worker, {
        awaitStartMs: 20,
      })['worker.script.execution.output'](
        { scope: SCOPE, executionId: params.executionId },
        handlerContext(),
        sink,
      );
      expect(sink.items).toEqual([]);
      refuse();
      await expect(running).rejects.toThrow('refused');
      await sink.done;
      expect(sink.ended).toBe('completed');
      expect(sink.items).toEqual([]);
    } finally {
      await failing.cleanup();
    }
  });

  it('stops waiting after 60 seconds when the run never begins', async () => {
    jest.useFakeTimers();
    const sink = await open(fixture.worker, randomUUID(), true);
    expect(sink.ended).toBeNull();
    jest.advanceTimersByTime(WORKER_SCRIPT_OUTPUT_AWAIT_START_MS - 1);
    expect(sink.ended).toBeNull();
    jest.advanceTimersByTime(1);
    expect(sink.ended).toBe('completed');
    expect(sink.items).toEqual([]);
  });
});
