import type {
  StepOutputEvent,
  StepOutputLogPosition,
} from '@canopy/desktop-shared/types/pipeline';
import {
  appendStepOutputEvents,
  applyStepLogOutputEvent,
  getReconciledStepLogLines,
  getStepOutputLines,
  mergeStepOutputLines,
  reconcileStepLogSnapshot,
  type ReconciledStepLog,
  type StepLogIdentity,
  type StepLogSnapshot,
} from '../lib/pipelineRunOutput';

/**
 * Adversarial snapshot-plus-stream handoff matrix (phase 02 log catch-up gate).
 *
 * Each scenario models one hidden-panel reveal: the panel's live buffer was
 * discarded on suspension, so the reveal registers interest (buffering events
 * from `registeredAt` on), reads one persisted snapshot, and keeps receiving
 * events. `expected` is what a fresh read of the settled log returns: the
 * persisted log is the authority.
 */

const IDENTITY: StepLogIdentity = {
  executionId: 'exec-1',
  jobId: 'job-1',
  stepId: 'step-1',
  attempt: 0,
  iteration: 1,
  recovery: 0,
};

interface Chunk {
  stream?: 'stdout' | 'stderr';
  data: string;
}

interface Scenario {
  name: string;
  /** Serialized writer runs over the same log identity (two for a retry). */
  runs: Chunk[][];
  /** Index of the first event delivered after interest was acquired. */
  registeredAt: number;
  /** Events before this index arrived before the snapshot response. */
  respondedAt: number;
  /** Persisted bytes the snapshot observed: run index plus byte count. */
  snapshot: { run: number; bytes: number };
  /** Settled persisted content after catch-up. */
  expected: string[];
  /** Whether today's textual-overlap merge reaches `expected`. */
  textualOverlap: 'lossless' | 'loses or duplicates output';
}

interface LaidOutRun {
  events: StepOutputEvent[];
  bytes: Buffer;
}

/**
 * Lays out one serialized writer run (generation = run index + 1): each chunk
 * is persisted at the byte offset where the previous one ended, which is the
 * writer contract the step runner's positioned writers implement.
 */
function layoutRun(chunks: readonly Chunk[], generation: number): LaidOutRun {
  const events: StepOutputEvent[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.data, 'utf8');
    parts.push(bytes);
    events.push({
      ...IDENTITY,
      jobName: 'Job 1',
      stepName: 'Step 1',
      stream: chunk.stream ?? 'stdout',
      data: chunk.data,
      logPosition: { generation, offset, byteLength: bytes.length },
    });
    offset += bytes.length;
  }
  return { events, bytes: Buffer.concat(parts) };
}

function laidOut(scenario: Scenario): {
  runs: LaidOutRun[];
  events: StepOutputEvent[];
} {
  const runs = scenario.runs.map((chunks, index) =>
    layoutRun(chunks, index + 1),
  );
  return { runs, events: runs.flatMap((run) => run.events) };
}

function withoutPositions(events: StepOutputEvent[]): StepOutputEvent[] {
  return events.map((event) => ({ ...event, logPosition: undefined }));
}

/** Mirrors the READ_STEP_LOG handler's `lines` result. */
function readLines(bytes: Buffer): string[] {
  const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Mirrors `completeUtf8PrefixLength` in the main-process reader. */
function completePrefixLength(bytes: Buffer): number {
  let index = bytes.length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && (bytes[index] & 0xc0) === 0x80) {
    index -= 1;
    continuation += 1;
  }
  if (index < 0) return bytes.length;
  const lead = bytes[index];
  const expected =
    (lead & 0xe0) === 0xc0
      ? 2
      : (lead & 0xf0) === 0xe0
        ? 3
        : (lead & 0xf8) === 0xf0
          ? 4
          : 1;
  return bytes.length - index < expected ? index : bytes.length;
}

/** Mirrors the READ_STEP_LOG handler's `text` result. */
function readText(bytes: Buffer, generation?: number): StepLogSnapshot {
  const byteLength = completePrefixLength(bytes);
  return {
    lines: [],
    text: bytes.toString('utf8', 0, byteLength),
    byteLength,
    ...(generation === undefined ? {} : { generation }),
  };
}

function runAt(runs: LaidOutRun[], index: number): LaidOutRun {
  const run = runs[index];
  if (!run) throw new Error(`no run ${index}`);
  return run;
}

/** Today's modal path: textual-overlap merge of the snapshot with the buffer. */
function textualOverlapHandoff(scenario: Scenario): string[] {
  const { runs, events } = laidOut(scenario);
  const buffer = appendStepOutputEvents(
    {},
    withoutPositions(events).slice(scenario.registeredAt),
  );
  const snapshotRun = runAt(runs, scenario.snapshot.run);
  return mergeStepOutputLines(
    readLines(snapshotRun.bytes.subarray(0, scenario.snapshot.bytes)),
    getStepOutputLines(
      buffer,
      IDENTITY.executionId,
      IDENTITY.jobId,
      IDENTITY.stepId,
      IDENTITY.attempt,
      IDENTITY.iteration,
      IDENTITY.recovery,
    ),
  );
}

interface PositionedHandoff {
  log: ReconciledStepLog;
  rereads: number;
}

/**
 * The coordinator contract documented beside `reconcileStepLogSnapshot`:
 * buffer from registration, reconcile at the response, apply later events,
 * and on staleness retain events and re-read once (here: the settled file).
 */
function positionedHandoff(
  scenario: Scenario,
  options: { terminalReread?: boolean } = {},
): PositionedHandoff {
  const { runs, events } = laidOut(scenario);
  const delivered = events.slice(scenario.registeredAt);
  const splitAt = Math.max(0, scenario.respondedAt - scenario.registeredAt);
  const beforeResponse = delivered.slice(0, splitAt);
  const afterResponse = delivered.slice(splitAt);
  const snapshotRun = runAt(runs, scenario.snapshot.run);
  const lastRunIndex = runs.length - 1;
  const settled = readText(runAt(runs, lastRunIndex).bytes, lastRunIndex + 1);

  let log = reconcileStepLogSnapshot(
    readText(
      snapshotRun.bytes.subarray(0, scenario.snapshot.bytes),
      scenario.snapshot.run + 1,
    ),
    beforeResponse,
    IDENTITY,
  );
  const isStale = (candidate: ReconciledStepLog): boolean =>
    candidate.mode === 'positioned' && candidate.stale;
  const retained: StepOutputEvent[] = isStale(log) ? [...beforeResponse] : [];
  for (const event of afterResponse) {
    if (isStale(log)) {
      retained.push(event);
      continue;
    }
    log = applyStepLogOutputEvent(log, event, IDENTITY);
    if (isStale(log)) retained.push(event);
  }

  let rereads = 0;
  if (isStale(log)) {
    rereads += 1;
    log = reconcileStepLogSnapshot(settled, retained, IDENTITY, log);
  }
  if (options.terminalReread) {
    rereads += 1;
    log = reconcileStepLogSnapshot(settled, [], IDENTITY);
  }
  return { log, rereads };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const numbered = (prefix: string, count: number, from = 1): Chunk[] =>
  Array.from({ length: count }, (_, index) => ({
    data: `${prefix} ${index + from}\n`,
  }));

const SCENARIOS: Scenario[] = [
  {
    name: 'output arriving while the snapshot read is in flight',
    runs: [numbered('line', 4)],
    registeredAt: 1,
    respondedAt: 3,
    snapshot: { run: 0, bytes: byteLength('line 1\nline 2\nline 3\n') },
    expected: ['line 1', 'line 2', 'line 3', 'line 4'],
    textualOverlap: 'lossless',
  },
  {
    name: 'repeated identical progress lines',
    runs: [Array.from({ length: 23 }, () => ({ data: '.\n' }))],
    registeredAt: 20,
    respondedAt: 21,
    snapshot: { run: 0, bytes: 21 * 2 },
    expected: Array.from({ length: 23 }, () => '.'),
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'legitimately duplicated log lines',
    runs: [[{ data: 'ok\n' }, { data: 'ok\n' }, { data: 'ok\n' }]],
    registeredAt: 2,
    respondedAt: 2,
    snapshot: { run: 0, bytes: 2 * 3 },
    expected: ['ok', 'ok', 'ok'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'more than five lines landing between interest and snapshot',
    runs: [[{ data: 'start\n' }, ...numbered('L', 7)]],
    registeredAt: 1,
    respondedAt: 7,
    snapshot: {
      run: 0,
      bytes: byteLength('start\nL 1\nL 2\nL 3\nL 4\nL 5\nL 6\n'),
    },
    expected: ['start', 'L 1', 'L 2', 'L 3', 'L 4', 'L 5', 'L 6', 'L 7'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'partial chunk split mid-line before interest',
    runs: [[{ data: 'hel' }, { data: 'lo world\n' }, { data: 'next\n' }]],
    registeredAt: 1,
    respondedAt: 1,
    snapshot: { run: 0, bytes: 3 },
    expected: ['hello world', 'next'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'partial chunk split mid-line after interest',
    runs: [[{ data: 'hel' }, { data: 'lo world\n' }, { data: 'next\n' }]],
    registeredAt: 0,
    respondedAt: 1,
    snapshot: { run: 0, bytes: 3 },
    expected: ['hello world', 'next'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'snapshot observing part of one chunk',
    runs: [[{ data: 'abcdef\n' }, { data: 'g\n' }]],
    registeredAt: 0,
    respondedAt: 0,
    snapshot: { run: 0, bytes: 3 },
    expected: ['abcdef', 'g'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'snapshot cut inside a multibyte UTF-8 character',
    runs: [[{ data: 'café 🙂\n' }, { data: 'ok\n' }]],
    registeredAt: 0,
    respondedAt: 1,
    // 'caf' plus the first byte of 'é'.
    snapshot: { run: 0, bytes: 4 },
    expected: ['café 🙂', 'ok'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'snapshot cut inside a four-byte UTF-8 character',
    runs: [[{ data: 'go 🙂 now\n' }, { data: 'ok\n' }]],
    registeredAt: 0,
    respondedAt: 1,
    // 'go ' plus two bytes of the emoji.
    snapshot: { run: 0, bytes: 5 },
    expected: ['go 🙂 now', 'ok'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'stdout and stderr interleaved within one line',
    runs: [
      [
        { stream: 'stdout', data: 'progress: ' },
        { stream: 'stderr', data: 'warning\n' },
        { stream: 'stdout', data: '50%\n' },
        { stream: 'stdout', data: 'done\n' },
      ],
    ],
    registeredAt: 0,
    respondedAt: 3,
    snapshot: { run: 0, bytes: byteLength('progress: warning\n50%\n') },
    expected: ['progress: warning', '50%', 'done'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'chunk emitted before interest but persisted after the snapshot',
    runs: [numbered('line', 3)],
    // `line 2` was emitted while hidden (its event is gone) and its async
    // append had not landed when the snapshot read the file.
    registeredAt: 2,
    respondedAt: 2,
    snapshot: { run: 0, bytes: byteLength('line 1\n') },
    expected: ['line 1', 'line 2', 'line 3'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'same-identity retry replacing the log during hydration',
    runs: [
      [{ data: 'build 1\n' }, { data: 'test 1\n' }],
      [{ data: 'build 2\n' }],
    ],
    registeredAt: 2,
    respondedAt: 2,
    snapshot: { run: 0, bytes: byteLength('build 1\ntest 1\n') },
    expected: ['build 2'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'same-identity retry repeating the prior output',
    runs: [[{ data: 'build\n' }, { data: 'test\n' }], [{ data: 'build\n' }]],
    registeredAt: 2,
    respondedAt: 2,
    snapshot: { run: 0, bytes: byteLength('build\ntest\n') },
    expected: ['build'],
    textualOverlap: 'loses or duplicates output',
  },
  {
    name: 'completion while hidden, revealed after the log settled',
    runs: [numbered('line', 3)],
    registeredAt: 3,
    respondedAt: 3,
    snapshot: { run: 0, bytes: byteLength('line 1\nline 2\nline 3\n') },
    expected: ['line 1', 'line 2', 'line 3'],
    textualOverlap: 'lossless',
  },
];

const cases = (
  filter: (scenario: Scenario) => boolean,
): Array<readonly [string, Scenario]> =>
  SCENARIOS.filter(filter).map((scenario) => [scenario.name, scenario]);

describe('pipeline log catch-up: positioned reconciliation', () => {
  it.each(cases(() => true))('joins %s losslessly', (_name, scenario) => {
    expect(getReconciledStepLogLines(positionedHandoff(scenario).log)).toEqual(
      scenario.expected,
    );
  });

  it('needs no re-read when the snapshot and events are contiguous', () => {
    const scenario = SCENARIOS[0];
    if (!scenario) throw new Error('missing scenario');
    const { log, rereads } = positionedHandoff(scenario);
    expect(rereads).toBe(0);
    expect(log.mode).toBe('positioned');
  });

  it('re-reads once to close a gap left by an emitted-before-persisted chunk', () => {
    const scenario = SCENARIOS.find((candidate) =>
      candidate.name.startsWith('chunk emitted before interest'),
    );
    if (!scenario) throw new Error('missing scenario');
    const { log, rereads } = positionedHandoff(scenario);
    expect(rereads).toBe(1);
    expect(log).toMatchObject({ mode: 'positioned', stale: false });
  });

  it('recovers a tail whose append raced a hidden completion only through the terminal re-read', () => {
    const scenario: Scenario = {
      name: 'reveal racing the final append',
      runs: [numbered('line', 3)],
      registeredAt: 3,
      respondedAt: 3,
      // `line 3` was emitted while hidden; its append had not landed yet.
      snapshot: { run: 0, bytes: byteLength('line 1\nline 2\n') },
      expected: ['line 1', 'line 2', 'line 3'],
      textualOverlap: 'loses or duplicates output',
    };

    const beforeTerminal = positionedHandoff(scenario);
    expect(getReconciledStepLogLines(beforeTerminal.log)).toEqual([
      'line 1',
      'line 2',
    ]);
    expect(beforeTerminal.log).toMatchObject({ stale: false });

    const afterTerminal = positionedHandoff(scenario, {
      terminalReread: true,
    });
    expect(getReconciledStepLogLines(afterTerminal.log)).toEqual(
      scenario.expected,
    );
  });
});

describe('pipeline log catch-up: textual overlap merge (decision evidence)', () => {
  // Pins the legacy fallback's limits: these are why the positioned seam
  // exists. If the heuristic ever becomes lossless here, update the scenario.
  it.each(cases((scenario) => scenario.textualOverlap === 'lossless'))(
    'still joins %s losslessly',
    (_name, scenario) => {
      expect(textualOverlapHandoff(scenario)).toEqual(scenario.expected);
    },
  );

  it.each(
    cases(
      (scenario) => scenario.textualOverlap === 'loses or duplicates output',
    ),
  )('cannot join %s losslessly', (_name, scenario) => {
    expect(textualOverlapHandoff(scenario)).not.toEqual(scenario.expected);
  });
});

function event(
  data: string,
  position?: StepOutputLogPosition,
  overrides: Partial<StepOutputEvent> = {},
): StepOutputEvent {
  return {
    ...IDENTITY,
    jobName: 'Job 1',
    stepName: 'Step 1',
    stream: 'stdout',
    data,
    ...(position ? { logPosition: position } : {}),
    ...overrides,
  };
}

function snapshot(text: string, generation?: number): StepLogSnapshot {
  return readText(Buffer.from(text, 'utf8'), generation);
}

describe('reconcileStepLogSnapshot', () => {
  it('drops events wholly inside the snapshot and slices a straddling one', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('one\ntw', 3),
      [
        event('one\n', { generation: 3, offset: 0, byteLength: 4 }),
        event('two\n', { generation: 3, offset: 4, byteLength: 4 }),
        event('three\n', { generation: 3, offset: 8, byteLength: 6 }),
      ],
      IDENTITY,
    );
    expect(log).toMatchObject({ mode: 'positioned', byteLength: 14 });
    expect(getReconciledStepLogLines(log)).toEqual(['one', 'two', 'three']);
  });

  it('ignores events from an older generation that the snapshot replaced', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('new\n', 5),
      [
        event('stale old output\n', {
          generation: 4,
          offset: 0,
          byteLength: 17,
        }),
      ],
      IDENTITY,
    );
    expect(log).toMatchObject({ mode: 'positioned', stale: false });
    expect(getReconciledStepLogLines(log)).toEqual(['new']);
  });

  it('marks the log stale when a newer generation replaced the snapshot', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('old\n', 5),
      [event('new\n', { generation: 6, offset: 0, byteLength: 4 })],
      IDENTITY,
    );
    expect(log).toMatchObject({ mode: 'positioned', stale: true });
    expect(getReconciledStepLogLines(log)).toEqual(['old']);
  });

  it('marks the log stale on a gap and ignores events after it', () => {
    const gapped = reconcileStepLogSnapshot(
      snapshot('a\n', 1),
      [event('c\n', { generation: 1, offset: 4, byteLength: 2 })],
      IDENTITY,
    );
    expect(gapped).toMatchObject({ mode: 'positioned', stale: true });
    const after = applyStepLogOutputEvent(
      gapped,
      event('d\n', { generation: 1, offset: 6, byteLength: 2 }),
      IDENTITY,
    );
    expect(after).toBe(gapped);
  });

  it('marks the log stale when a position does not fit its data', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('', 1),
      [event('abc', { generation: 1, offset: 0, byteLength: 2 })],
      IDENTITY,
    );
    expect(log).toMatchObject({ mode: 'positioned', stale: true });
  });

  it('marks the log stale when the snapshot end falls inside a chunk character', () => {
    const log = reconcileStepLogSnapshot(
      // A snapshot claiming one byte of the two-byte 'é'.
      { lines: [], text: '', byteLength: 1, generation: 1 },
      [event('é\n', { generation: 1, offset: 0, byteLength: 3 })],
      IDENTITY,
    );
    expect(log).toMatchObject({ mode: 'positioned', stale: true });
  });

  it('ignores unpositioned events of a positioned log (emitted, never persisted)', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('{"type":"result"}\n', 2),
      [event('{"type":"claude_terminal_projected_messages"}\n')],
      IDENTITY,
    );
    expect(getReconciledStepLogLines(log)).toEqual(['{"type":"result"}']);
  });

  it('keeps other identities out of the join, including retry attempts and recoveries', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('mine\n', 1),
      [
        event(
          'attempt 1\n',
          { generation: 2, offset: 0, byteLength: 10 },
          {
            attempt: 1,
          },
        ),
        event(
          'recovery\n',
          { generation: 3, offset: 0, byteLength: 9 },
          {
            recovery: 1,
          },
        ),
        event(
          'iteration\n',
          { generation: 4, offset: 0, byteLength: 10 },
          {
            iteration: 2,
          },
        ),
        event(
          'child\n',
          { generation: 5, offset: 0, byteLength: 6 },
          {
            stepId: 'step-1/child',
          },
        ),
        event('mine too\n', { generation: 1, offset: 5, byteLength: 9 }),
      ],
      IDENTITY,
    );
    expect(log).toMatchObject({ mode: 'positioned', stale: false });
    expect(getReconciledStepLogLines(log)).toEqual(['mine', 'mine too']);
  });

  it('preserves CRLF normalization across a chunk boundary', () => {
    const log = reconcileStepLogSnapshot(
      snapshot('first\r', 1),
      [event('\nsecond\r\n', { generation: 1, offset: 6, byteLength: 9 })],
      IDENTITY,
    );
    expect(getReconciledStepLogLines(log)).toEqual(['first', 'second']);
  });

  it('degrades to the heuristic when a re-read makes no progress', () => {
    const buffered = [
      event('late\n', { generation: 1, offset: 10, byteLength: 5 }),
    ];
    const first = reconcileStepLogSnapshot(
      snapshot('a\n', 1),
      buffered,
      IDENTITY,
    );
    expect(first).toMatchObject({ mode: 'positioned', stale: true });

    const second = reconcileStepLogSnapshot(
      snapshot('a\n', 1),
      buffered,
      IDENTITY,
      first,
    );
    expect(second).toMatchObject({
      mode: 'heuristic',
      degraded: true,
      upgradeAvailable: false,
    });
    expect(getReconciledStepLogLines(second)).toEqual(['a', 'late']);
    const later = applyStepLogOutputEvent(
      second,
      event('more\n', { generation: 1, offset: 15, byteLength: 5 }),
      IDENTITY,
    );
    expect(later).toMatchObject({ upgradeAvailable: false });
  });

  it('keeps re-reading while a re-read makes progress', () => {
    const buffered = [
      event('late\n', { generation: 1, offset: 10, byteLength: 5 }),
    ];
    const first = reconcileStepLogSnapshot(
      snapshot('a\n', 1),
      buffered,
      IDENTITY,
    );
    const second = reconcileStepLogSnapshot(
      snapshot('a\nb\n', 1),
      buffered,
      IDENTITY,
      first,
    );
    expect(second).toMatchObject({ mode: 'positioned', stale: true });
  });

  describe('heuristic fallback', () => {
    it('matches the textual merge when the snapshot has no generation', () => {
      const buffered = [event('two\nthree\n')];
      const log = reconcileStepLogSnapshot(
        snapshot('one\ntwo\n'),
        buffered,
        IDENTITY,
      );
      expect(log.mode).toBe('heuristic');
      expect(getReconciledStepLogLines(log)).toEqual(
        mergeStepOutputLines(['one', 'two'], ['two', 'three']),
      );
    });

    it('uses `lines` snapshots and aggregates descendant output like the ancestor buffers', () => {
      const log = reconcileStepLogSnapshot(
        { lines: ['[run] child'] },
        [event('nested\n', undefined, { stepId: 'step-1/child' })],
        IDENTITY,
      );
      expect(getReconciledStepLogLines(log)).toEqual(['[run] child', 'nested']);
    });

    it('offers one upgrade re-read once positioned output of the exact log is seen', () => {
      const log = reconcileStepLogSnapshot(snapshot('a\n'), [], IDENTITY);
      expect(log).toMatchObject({ mode: 'heuristic', upgradeAvailable: false });

      const descendant = applyStepLogOutputEvent(
        log,
        event(
          'x\n',
          { generation: 2, offset: 0, byteLength: 2 },
          {
            stepId: 'step-1/child',
          },
        ),
        IDENTITY,
      );
      expect(descendant).toMatchObject({ upgradeAvailable: false });

      const exact = applyStepLogOutputEvent(
        descendant,
        event('b\n', { generation: 1, offset: 2, byteLength: 2 }),
        IDENTITY,
      );
      expect(exact).toMatchObject({ upgradeAvailable: true });
      expect(getReconciledStepLogLines(exact)).toEqual(['a', 'x', 'b']);
    });
  });
});
