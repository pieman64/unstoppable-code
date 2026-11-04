import { EventEmitter } from 'node:events';

/** A worker that stays busy until a test explicitly cancels or exits it. */
class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn();
  public readonly kill = jest.fn((): boolean => true);
  private hasExited = false;

  public answer(
    result: CodeGraphWorkerReadResult = { kind: 'calls', value: [[]] },
  ): void {
    this.emit('message', {
      data: { ok: true, result },
    });
  }

  public exit(): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.emit('exit', 0);
  }
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));

const recordTelemetry = jest.fn<void, [unknown]>();
const flushTelemetry = jest.fn<void, []>();
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphReadDiagnostic: (): void => undefined,
  flushCodeGraphReadDiagnostics: (): void => undefined,
  recordCodeGraphQueryTelemetry: (input: unknown): void =>
    recordTelemetry(input),
  flushCodeGraphQueryTelemetry: (): void => flushTelemetry(),
}));

import {
  cancelCodeGraphReads,
  resetCodeGraphReadRunnerForTests,
  runCodeGraphWorkerRead,
  CodeGraphWorkerReadError,
  type CodeGraphWorkerReadInput,
  type CodeGraphWorkerReadResponse,
  type CodeGraphWorkerReadResult,
  type CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';

const INTERACTIVE_QUEUE_WAIT_MS = 5_000;
const COMPARISON_QUEUE_WAIT_MS = 30_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const CHANGE_IMPACT_EXECUTION_TIMEOUT_MS = 5 * 60_000;

const CALLS_TASK: CodeGraphWorkerReadTask = {
  kind: 'calls',
  calls: [{ method: 'file-summary', target: 'fixture.ts' }],
};
const READONLY_SUMMARY_TASK: CodeGraphWorkerReadTask = {
  kind: 'readonly-summary',
};
const DETECT_CHANGED_TASK: CodeGraphWorkerReadTask = {
  kind: 'detect-changed',
  repoId: 'repo',
  rootPath: '/repo',
  baseRef: 'HEAD',
};
const CHANGE_IMPACT_TASK: CodeGraphWorkerReadTask = {
  kind: 'change-impact',
  repoId: 'repo',
  rootPath: '/repo',
  baseRef: 'HEAD',
  resourcesDir: '/resources',
};
const FINGERPRINT_METADATA_TASK: CodeGraphWorkerReadTask = {
  kind: 'fingerprint-metadata',
};
const VALIDATE_BASE_TASK: CodeGraphWorkerReadTask = {
  kind: 'validate-base',
  identity: {
    repoId: 'repo',
    canonicalRepoRoot: '/repo',
    customLanguagesFingerprint: 'languages',
  },
  gitHead: null,
};

type ReadObservation =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: CodeGraphWorkerReadResponse }
  | { status: 'rejected'; error: unknown };
type TelemetryKind = CodeGraphWorkerReadInput['kind'];

interface ObservedRead {
  promise: Promise<CodeGraphWorkerReadResponse>;
  observation: { current: ReadObservation };
}

interface ReadLedger {
  reads: ObservedRead[];
  keys: Set<string>;
  retirements: Promise<void>[];
}

function readInput(
  key: string,
  task: CodeGraphWorkerReadTask,
  kind: TelemetryKind,
): CodeGraphWorkerReadInput {
  return {
    key,
    kind,
    request: { dbPath: '/private/graph.db', task },
  };
}

function observeRead(
  ledger: ReadLedger,
  input: CodeGraphWorkerReadInput,
): ObservedRead {
  const promise = runCodeGraphWorkerRead(input);
  const observation: { current: ReadObservation } = {
    current: { status: 'pending' },
  };
  const observed: ObservedRead = { promise, observation };
  void promise.then(
    (value): void => {
      observation.current = { status: 'fulfilled', value };
    },
    (error: unknown): void => {
      observation.current = { status: 'rejected', error };
    },
  );
  ledger.reads.push(observed);
  ledger.keys.add(input.key);
  return observed;
}

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function interactiveTaskAt(index: number): CodeGraphWorkerReadTask {
  return index % 2 === 0 ? CALLS_TASK : READONLY_SUMMARY_TASK;
}

function comparisonTaskAt(index: number): CodeGraphWorkerReadTask {
  return index % 2 === 0 ? DETECT_CHANGED_TASK : CHANGE_IMPACT_TASK;
}

function maintenanceTaskAt(index: number): CodeGraphWorkerReadTask {
  return index % 2 === 0 ? FINGERPRINT_METADATA_TASK : VALIDATE_BASE_TASK;
}

function telemetryKindAt(index: number): TelemetryKind {
  const kinds: TelemetryKind[] = [
    'context',
    'fingerprint-metadata',
    'base-validation',
    'query',
    'ui-summary',
  ];
  return kinds[index % kinds.length] ?? 'context';
}

describe('code-graph read admission', () => {
  const children: FakeUtilityProcess[] = [];
  const ledger: ReadLedger = { reads: [], keys: new Set(), retirements: [] };

  beforeEach(() => {
    resetCodeGraphReadRunnerForTests();
    children.length = 0;
    ledger.reads.length = 0;
    ledger.keys.clear();
    ledger.retirements.length = 0;
    forkMock.mockReset();
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
    recordTelemetry.mockReset();
    flushTelemetry.mockReset();
  });

  afterEach(async () => {
    const cancellations = Array.from(ledger.keys, (key) =>
      cancelCodeGraphReads(key),
    );
    for (const child of children) child.exit();
    await Promise.all(cancellations);
    await Promise.all(ledger.retirements);
    await Promise.all(
      ledger.reads.map((read) =>
        read.promise.then(
          (): void => undefined,
          (): void => undefined,
        ),
      ),
    );
    jest.useRealTimers();
    resetCodeGraphReadRunnerForTests();
  });

  it('shares three interactive slots across calls and summaries', async () => {
    const firstCall = observeRead(
      ledger,
      readInput('interactive-call-1', CALLS_TASK, 'fingerprint-metadata'),
    );
    const summary = observeRead(
      ledger,
      readInput('interactive-summary', READONLY_SUMMARY_TASK, 'context'),
    );
    const secondCall = observeRead(
      ledger,
      readInput('interactive-call-2', CALLS_TASK, 'ui-summary'),
    );
    const fourthInteractive = observeRead(
      ledger,
      readInput('interactive-call-3', CALLS_TASK, 'query'),
    );

    await settleMicrotasks();

    expect(children).toHaveLength(3);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
    expect(children[1]?.postMessage).toHaveBeenCalledTimes(1);
    expect(children[2]?.postMessage).toHaveBeenCalledTimes(1);
    expect(fourthInteractive.observation.current.status).toBe('pending');
    expect(firstCall.observation.current.status).toBe('pending');
    expect(summary.observation.current.status).toBe('pending');
    expect(secondCall.observation.current.status).toBe('pending');
  });

  it('shares comparison capacity across change-analysis tasks', async () => {
    const impact = observeRead(
      ledger,
      readInput(
        'comparison-impact',
        CHANGE_IMPACT_TASK,
        'fingerprint-metadata',
      ),
    );
    const changed = observeRead(
      ledger,
      readInput('comparison-changed', DETECT_CHANGED_TASK, 'context'),
    );
    const secondImpact = observeRead(
      ledger,
      readInput('comparison-impact-2', CHANGE_IMPACT_TASK, 'ui-summary'),
    );

    await settleMicrotasks();

    expect(children).toHaveLength(1);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
    expect(impact.observation.current.status).toBe('pending');
    expect(changed.observation.current.status).toBe('pending');
    expect(secondImpact.observation.current.status).toBe('pending');
  });

  it('shares maintenance capacity across all maintenance tasks', async () => {
    const metadata = observeRead(
      ledger,
      readInput('maintenance-metadata', FINGERPRINT_METADATA_TASK, 'context'),
    );
    const persist = observeRead(
      ledger,
      readInput(
        'maintenance-metadata',
        FINGERPRINT_METADATA_TASK,
        'fingerprint-metadata',
      ),
    );
    const validate = observeRead(
      ledger,
      readInput('maintenance-validate', VALIDATE_BASE_TASK, 'base-validation'),
    );

    await settleMicrotasks();

    expect(children).toHaveLength(1);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
    expect(metadata.observation.current.status).toBe('pending');
    expect(persist.observation.current.status).toBe('pending');
    expect(validate.observation.current.status).toBe('pending');
  });

  it('bounds task queues and rejects overflow with busy', async () => {
    const activeInteractive = [
      observeRead(
        ledger,
        readInput('queue-active-call-1', CALLS_TASK, 'fingerprint-metadata'),
      ),
      observeRead(
        ledger,
        readInput('queue-active-summary', READONLY_SUMMARY_TASK, 'context'),
      ),
    ];
    const activeComparison = observeRead(
      ledger,
      readInput('queue-active-impact', CHANGE_IMPACT_TASK, 'query'),
    );
    const activeMaintenance = observeRead(
      ledger,
      readInput('queue-active-metadata', FINGERPRINT_METADATA_TASK, 'context'),
    );

    const queuedInteractive = Array.from({ length: 32 }, (_, index) =>
      observeRead(
        ledger,
        readInput(
          `queue-interactive-${index}`,
          interactiveTaskAt(index),
          // base-validation readonly-summary is intentionally a maintenance preflight.
          telemetryKindAt(index) === 'base-validation'
            ? 'ui-summary'
            : telemetryKindAt(index),
        ),
      ),
    );
    const overflowInteractive = observeRead(
      ledger,
      readInput('queue-interactive-overflow', CALLS_TASK, 'query'),
    );

    const queuedComparisons = Array.from({ length: 8 }, (_, index) =>
      observeRead(
        ledger,
        readInput(
          `queue-comparison-${index}`,
          comparisonTaskAt(index),
          telemetryKindAt(index + 1),
        ),
      ),
    );
    const overflowComparison = observeRead(
      ledger,
      readInput('queue-comparison-overflow', DETECT_CHANGED_TASK, 'context'),
    );

    const queuedMaintenance = Array.from({ length: 32 }, (_, index) =>
      observeRead(
        ledger,
        readInput(
          `queue-maintenance-${index}`,
          maintenanceTaskAt(index),
          telemetryKindAt(index + 2),
        ),
      ),
    );
    const overflowMaintenance = observeRead(
      ledger,
      readInput(
        'queue-maintenance-overflow',
        FINGERPRINT_METADATA_TASK,
        'fingerprint-metadata',
      ),
    );

    await settleMicrotasks();

    expect(children).toHaveLength(4);
    expect(activeInteractive).toHaveLength(2);
    expect(activeComparison.observation.current.status).toBe('pending');
    expect(activeMaintenance.observation.current.status).toBe('pending');
    for (const read of [
      ...queuedInteractive,
      ...queuedComparisons,
      ...queuedMaintenance,
    ]) {
      expect(read.observation.current.status).toBe('pending');
    }

    // Probe settlement before using a rejection matcher: unbounded queues in
    // the old runner leave these promises pending, which must fail promptly.
    expect(overflowInteractive.observation.current.status).toBe('rejected');
    expect(overflowComparison.observation.current.status).toBe('rejected');
    expect(overflowMaintenance.observation.current.status).toBe('rejected');
    await expect(overflowInteractive.promise).rejects.toBeInstanceOf(
      CodeGraphWorkerReadError,
    );
    await expect(overflowInteractive.promise).rejects.toMatchObject({
      reason: 'busy',
    });
    await expect(overflowComparison.promise).rejects.toBeInstanceOf(
      CodeGraphWorkerReadError,
    );
    await expect(overflowComparison.promise).rejects.toMatchObject({
      reason: 'busy',
    });
    await expect(overflowMaintenance.promise).rejects.toBeInstanceOf(
      CodeGraphWorkerReadError,
    );
    await expect(overflowMaintenance.promise).rejects.toMatchObject({
      reason: 'busy',
    });
    expect(recordTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'query', outcome: 'error' }),
    );
  });

  it('expires interactive queue wait after five seconds', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    const blockers = [
      observeRead(
        ledger,
        readInput('interactive-timeout-1', CALLS_TASK, 'context'),
      ),
      observeRead(
        ledger,
        readInput('interactive-timeout-2', CALLS_TASK, 'query'),
      ),
      observeRead(
        ledger,
        readInput('interactive-timeout-3', CALLS_TASK, 'ui-summary'),
      ),
    ];
    const queued = observeRead(
      ledger,
      readInput('interactive-timeout-queued', READONLY_SUMMARY_TASK, 'context'),
    );

    await jest.advanceTimersByTimeAsync(INTERACTIVE_QUEUE_WAIT_MS - 1);
    expect(queued.observation.current.status).toBe('pending');
    expect(blockers[0]?.observation.current.status).toBe('pending');

    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(queued.observation.current.status).toBe('rejected');
    expect(blockers[0]?.observation.current.status).toBe('pending');
    await expect(queued.promise).rejects.toBeInstanceOf(
      CodeGraphWorkerReadError,
    );
    await expect(queued.promise).rejects.toMatchObject({
      reason: 'queue-timeout',
    });

    await jest.advanceTimersByTimeAsync(
      DEFAULT_EXECUTION_TIMEOUT_MS - INTERACTIVE_QUEUE_WAIT_MS - 1,
    );
    expect(blockers[0]?.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(blockers[0]?.observation.current.status).toBe('rejected');
    await expect(blockers[0]?.promise).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('expires maintenance queue wait after 30 seconds', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    const blocker = observeRead(
      ledger,
      readInput(
        'maintenance-expiry-blocker',
        FINGERPRINT_METADATA_TASK,
        'context',
      ),
    );
    await jest.advanceTimersByTimeAsync(500);
    const queuedHead = observeRead(
      ledger,
      readInput(
        'maintenance-expiry-head',
        VALIDATE_BASE_TASK,
        'base-validation',
      ),
    );
    await jest.advanceTimersByTimeAsync(500);
    const queuedTarget = observeRead(
      ledger,
      readInput(
        'maintenance-expiry-target',
        FINGERPRINT_METADATA_TASK,
        'context',
      ),
    );

    await jest.advanceTimersByTimeAsync(28_000);
    expect(blocker.observation.current.status).toBe('pending');
    expect(queuedHead.observation.current.status).toBe('pending');
    expect(queuedTarget.observation.current.status).toBe('pending');

    children[0]?.answer({
      kind: 'fingerprint-metadata',
      value: {
        fingerprint: null,
        schemaVersion: null,
        extractorVersion: null,
        completed: true,
      },
    });
    await settleMicrotasks();
    expect(blocker.observation.current.status).toBe('fulfilled');
    children[0]?.exit();
    await settleMicrotasks();

    // The next maintenance request starts at t=29s and owns a fresh
    // 30-second execution watchdog while the target's queue clock runs out.
    await jest.advanceTimersByTimeAsync(1_999);
    expect(queuedTarget.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();

    expect(queuedTarget.observation.current.status).toBe('rejected');
    await expect(queuedTarget.promise).rejects.toBeInstanceOf(
      CodeGraphWorkerReadError,
    );
    await expect(queuedTarget.promise).rejects.toMatchObject({
      reason: 'queue-timeout',
    });
    expect(queuedHead.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(30_000 - 2_000 - 1);
    expect(queuedHead.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(queuedHead.observation.current.status).toBe('rejected');
    await expect(queuedHead.promise).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(recordTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'context', outcome: 'timeout' }),
    );
  });

  it('gives queued reads a fresh execution timeout', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    const firstBlocker = observeRead(
      ledger,
      readInput('interactive-reuse', CALLS_TASK, 'context'),
    );
    const secondBlocker = observeRead(
      ledger,
      readInput('interactive-second', CALLS_TASK, 'query'),
    );
    const thirdBlocker = observeRead(
      ledger,
      readInput('interactive-third', CALLS_TASK, 'ui-summary'),
    );
    const queued = observeRead(
      ledger,
      readInput('interactive-reuse', READONLY_SUMMARY_TASK, 'context'),
    );
    await settleMicrotasks();

    await jest.advanceTimersByTimeAsync(4_000);
    children[0]?.answer();
    await settleMicrotasks();
    expect(firstBlocker.observation.current.status).toBe('fulfilled');
    expect(queued.observation.current.status).toBe('pending');

    // Queue admission ended at t=4s. Crossing its five-second deadline must
    // not reject a request that already started.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(queued.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(24_000);
    children[1]?.answer();
    children[2]?.answer();
    await settleMicrotasks();
    expect(secondBlocker.observation.current.status).toBe('fulfilled');
    expect(thirdBlocker.observation.current.status).toBe('fulfilled');
    expect(queued.observation.current.status).toBe('pending');

    // At t=30s the queued read has executed for only 26s; it receives its
    // full execution allowance and times out at t=34s instead.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(queued.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(3_999);
    expect(queued.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(queued.observation.current.status).toBe('rejected');
    await expect(queued.promise).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('counts retiring workers toward the global cap', async () => {
    const heldKeys = ['held-slot-1', 'held-slot-2', 'held-slot-3'];
    const heldReads = heldKeys.map((key, index) =>
      observeRead(ledger, readInput(key, CALLS_TASK, telemetryKindAt(index))),
    );
    const retirements = heldKeys.map((key) => cancelCodeGraphReads(key));
    ledger.retirements.push(...retirements);
    await settleMicrotasks();
    expect(children).toHaveLength(3);
    for (const read of heldReads) {
      expect(read.observation.current.status).toBe('rejected');
    }

    const impact = observeRead(
      ledger,
      readInput('held-cap-impact', CHANGE_IMPACT_TASK, 'query'),
    );
    const interactive = observeRead(
      ledger,
      readInput('held-cap-interactive', READONLY_SUMMARY_TASK, 'context'),
    );
    await settleMicrotasks();

    expect(children).toHaveLength(4);
    expect(impact.observation.current.status).toBe('pending');
    expect(interactive.observation.current.status).toBe('pending');
  });

  it('separates comparison queue and execution deadlines', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    const impact = observeRead(
      ledger,
      readInput(
        'long-impact-blocker',
        CHANGE_IMPACT_TASK,
        'fingerprint-metadata',
      ),
    );
    const queuedImpact = observeRead(
      ledger,
      readInput('long-impact-waiter', CHANGE_IMPACT_TASK, 'context'),
    );
    await settleMicrotasks();
    expect(impact.observation.current.status).toBe('pending');
    expect(queuedImpact.observation.current.status).toBe('pending');

    await jest.advanceTimersByTimeAsync(5_000);
    expect(queuedImpact.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(COMPARISON_QUEUE_WAIT_MS - 5_000 - 1);
    expect(queuedImpact.observation.current.status).toBe('pending');
    expect(impact.observation.current.status).toBe('pending');

    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(queuedImpact.observation.current.status).toBe('rejected');
    expect(impact.observation.current.status).toBe('pending');
    await expect(queuedImpact.promise).rejects.toBeInstanceOf(
      CodeGraphWorkerReadError,
    );
    await expect(queuedImpact.promise).rejects.toMatchObject({
      reason: 'queue-timeout',
    });
    expect(recordTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'context',
        outcome: 'timeout',
      }),
    );

    await jest.advanceTimersByTimeAsync(
      CHANGE_IMPACT_EXECUTION_TIMEOUT_MS - COMPARISON_QUEUE_WAIT_MS - 1,
    );
    expect(impact.observation.current.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(impact.observation.current.status).toBe('rejected');
    await expect(impact.promise).rejects.toMatchObject({ reason: 'timeout' });
  });
});
