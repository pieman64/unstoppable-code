import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationRecord } from '@canopy/protocol/canopy-core';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  CORE_SUMMARY_REGENERATE_KIND,
  CoreSummarySchedule,
  SUMMARY_GENERATION_FAILED,
  type CoreSummaryScheduleHost,
  type SummaryGenerationResult,
  type SummaryMode,
  type SummaryScope,
} from '..';

const scope: SummaryScope = { workspaceId: 'w1', worktreeId: 't1' };

interface RecordedTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

interface TestHost extends CoreSummaryScheduleHost {
  timers: RecordedTimer[];
  generations: Deferred<SummaryGenerationResult>[];
  generate: jest.Mock<
    Promise<SummaryGenerationResult>,
    [SummaryScope, SummaryMode, AbortSignal]
  >;
  onError: jest.Mock<void, [unknown, string]>;
  clock: { now: number };
  settings: {
    enabled: boolean;
    cadence: 'debounce' | 'ledger';
    activeTurns: boolean;
  };
  fire(index: number): Promise<void>;
  live(): RecordedTimer[];
}

function createHost(enabled = true): TestHost {
  const timers: RecordedTimer[] = [];
  const generations: Deferred<SummaryGenerationResult>[] = [];
  const clock = { now: 1_000_000 };
  const settings = {
    enabled,
    cadence: 'debounce' as 'debounce' | 'ledger',
    activeTurns: false,
  };
  return {
    timers,
    generations,
    clock,
    settings,
    isAutomaticSchedulingEnabled: () => settings.enabled,
    cadence: () => settings.cadence,
    hasActiveTurns: () => settings.activeTurns,
    now: () => clock.now,
    setTimer: (callback, delayMs) => {
      const timer: RecordedTimer = {
        callback,
        delayMs,
        cancelled: false,
        fired: false,
      };
      timers.push(timer);
      return {
        cancel: (): void => {
          timer.cancelled = true;
        },
      };
    },
    generate: jest.fn<
      Promise<SummaryGenerationResult>,
      [SummaryScope, SummaryMode, AbortSignal]
    >(() => {
      const generation = deferred<SummaryGenerationResult>();
      generations.push(generation);
      return generation.promise;
    }),
    onError: jest.fn<void, [unknown, string]>(),
    async fire(index: number): Promise<void> {
      const timer = timers[index];
      if (!timer) throw new Error(`No timer ${index}`);
      timer.fired = true;
      timer.callback();
      await flush();
    },
    live: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
  };
}

describe('core summary schedule (CAN-4114)', () => {
  let root: string;
  const services: OperationService[] = [];

  function open(host: TestHost): {
    operations: OperationService;
    schedule: CoreSummarySchedule;
  } {
    const operations = new OperationService({
      openLedger: (): OperationLedger =>
        OperationLedger.open(join(root, 'ledger.sqlite')),
    });
    services.push(operations);
    const schedule = new CoreSummarySchedule({ operations, ownerId: 'local' });
    schedule.registerHost(host);
    return { operations, schedule };
  }

  async function summaries(
    operations: OperationService,
  ): Promise<OperationRecord[]> {
    return (
      await operations.list({
        kinds: [CORE_SUMMARY_REGENERATE_KIND],
        limit: 10,
      })
    ).items;
  }

  async function only(operations: OperationService): Promise<OperationRecord> {
    const [operation, ...rest] = await summaries(operations);
    if (!operation || rest.length > 0)
      throw new Error('Expected exactly one summary operation');
    return operation;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'core-summary-schedule-'));
  });

  afterEach(() => {
    for (const operations of services.splice(0)) operations.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('records a scheduled summary as a queued operation before its timer fires', async () => {
    const host = createHost();
    const { operations, schedule } = open(host);
    await schedule.schedule(scope);
    expect(await only(operations)).toMatchObject({
      kind: CORE_SUMMARY_REGENERATE_KIND,
      status: 'queued',
      scope,
      origin: { context: { mode: 'incremental' } },
    });
    expect(host.timers).toHaveLength(1);
    expect(host.timers[0]?.delayMs).toBe(30_000);
    expect(host.generate).not.toHaveBeenCalled();
  });

  it('coalesces repeated schedules into one queued run', async () => {
    const host = createHost();
    const { operations, schedule } = open(host);
    await schedule.schedule(scope);
    await schedule.schedule(scope);
    await schedule.schedule(scope);
    expect(await summaries(operations)).toHaveLength(1);
    expect(host.timers.filter((timer) => timer.cancelled)).toHaveLength(2);
    expect(host.live()).toHaveLength(1);
  });

  it('records what a generation did', async () => {
    const host = createHost();
    const { operations, schedule } = open(host);
    await schedule.schedule(scope);
    await host.fire(0);
    expect(host.generate).toHaveBeenCalledWith(
      scope,
      'incremental',
      expect.any(AbortSignal),
    );
    expect((await only(operations)).status).toBe('running');
    expect(schedule.isRunning(scope)).toBe(true);
    host.generations[0]?.resolve({
      result: 'written',
      sourceRevision: 'turns:4',
    });
    await flush();
    const operation = await only(operations);
    expect(operation.status).toBe('completed');
    expect(operation.outcome).toEqual({
      result: 'written',
      sourceRevision: 'turns:4',
    });
    expect(schedule.isPending(scope)).toBe(false);
  });

  it('defers a Ledger cadence run while a turn runs, up to the maximum wait', async () => {
    const host = createHost();
    host.settings.cadence = 'ledger';
    host.settings.activeTurns = true;
    const t0 = host.clock.now;
    const { schedule } = open(host);
    await schedule.schedule(scope);
    expect(host.timers[0]?.delayMs).toBe(300_000);
    host.clock.now = t0 + 300_000;
    await host.fire(0);
    expect(host.timers[1]?.delayMs).toBe(1_500_000);
    expect(host.generate).not.toHaveBeenCalled();
    host.clock.now = t0 + 1_800_000;
    await host.fire(1);
    expect(host.generate).toHaveBeenCalledTimes(1);
  });

  it('resumes a queued summary after a restart, once', async () => {
    const before = createHost();
    const first = open(before);
    await first.schedule.schedule(scope);
    first.operations.close();

    const after = createHost();
    const second = open(after);
    await second.operations.whenReconciled();
    expect(after.timers).toHaveLength(1);
    expect(after.timers[0]?.delayMs).toBe(60_000);
    expect(after.generate).not.toHaveBeenCalled();
    await after.fire(0);
    expect(after.generate).toHaveBeenCalledTimes(1);
    expect(after.generate).toHaveBeenCalledWith(
      scope,
      'incremental',
      expect.any(AbortSignal),
    );
    after.generations[0]?.resolve({ result: 'skipped' });
    await flush();
    expect((await only(second.operations)).status).toBe('completed');
    expect(after.live()).toHaveLength(0);
    expect(after.generate).toHaveBeenCalledTimes(1);
    expect(before.generate).not.toHaveBeenCalled();
  });

  it('does not rerun a summary that a restart interrupted', async () => {
    const before = createHost();
    const first = open(before);
    await first.schedule.schedule(scope);
    await before.fire(0);
    expect(before.generate).toHaveBeenCalledTimes(1);
    first.operations.close();

    const after = createHost();
    const second = open(after);
    await second.operations.whenReconciled();
    expect(await only(second.operations)).toMatchObject({
      status: 'failed',
      error: { code: 'core.operation.interrupted' },
    });
    expect(after.generate).not.toHaveBeenCalled();
    expect(after.timers).toHaveLength(0);
    before.generations[0]?.resolve({ result: 'skipped' });
    await flush();
  });

  it('a manual refresh supersedes the queued run and generates in full mode at once', async () => {
    const host = createHost();
    const { operations, schedule } = open(host);
    await schedule.schedule(scope);
    const [scheduled] = await summaries(operations);
    const refreshed = await schedule.refresh(scope, {
      kind: 'client',
      sourceId: 'local-desktop-user',
      context: { mode: 'full' },
    });
    await flush();
    expect(await operations.get(scheduled?.operationId ?? '')).toMatchObject({
      status: 'completed',
      outcome: { result: 'superseded' },
    });
    expect((await operations.get(refreshed.operationId))?.status).toBe(
      'running',
    );
    expect(host.generate).toHaveBeenCalledWith(
      scope,
      'full',
      expect.any(AbortSignal),
    );
    expect(host.live()).toHaveLength(0);
  });

  it('cancelling a scope stops its queued run without generating', async () => {
    const host = createHost();
    const { operations, schedule } = open(host);
    await schedule.schedule(scope);
    await schedule.cancel(scope);
    expect((await only(operations)).status).toBe('cancelled');
    expect(host.timers[0]?.cancelled).toBe(true);

    await schedule.schedule(scope);
    const queued = (await summaries(operations)).find(
      (operation) => operation.status === 'queued',
    );
    if (!queued) throw new Error('Expected a queued summary operation');
    // The path a core.operation.cancel request takes.
    const cancelled = await operations.cancel(queued.operationId, {
      reason: 'test',
      requestedBy: 'test',
    });
    expect(cancelled.operation.status).toBe('cancelled');
    expect(host.live()).toHaveLength(0);
    expect(schedule.isPending(scope)).toBe(false);
    expect(host.generate).not.toHaveBeenCalled();
  });

  it('records a failed generation without provider text', async () => {
    const host = createHost();
    const { operations, schedule } = open(host);
    await schedule.schedule(scope);
    await host.fire(0);
    host.generations[0]?.reject(
      new Error('provider said: token sk-123 at /Users/x'),
    );
    await flush();
    const operation = await only(operations);
    expect(operation.status).toBe('failed');
    expect(operation.error).toEqual(SUMMARY_GENERATION_FAILED);
    expect(JSON.stringify(operation)).not.toContain('sk-123');
    expect(JSON.stringify(operation)).not.toContain('/Users/');
  });

  it('never schedules or resumes when automatic scheduling is disabled', async () => {
    const disabled = createHost(false);
    const first = open(disabled);
    await first.schedule.schedule(scope);
    expect(await summaries(first.operations)).toHaveLength(0);
    first.operations.close();

    const enabled = createHost();
    const second = open(enabled);
    await second.schedule.schedule(scope);
    second.operations.close();

    const restarted = createHost(false);
    const third = open(restarted);
    await third.operations.whenReconciled();
    expect((await only(third.operations)).status).toBe('cancelled');
    expect(restarted.timers).toHaveLength(0);
    expect(restarted.generate).not.toHaveBeenCalled();
    expect(enabled.generate).not.toHaveBeenCalled();
  });
});
