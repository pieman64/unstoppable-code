import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseInitiatedWorkRunRecord,
  type InitiatedWorkRunResult,
  type OperationOrigin,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';

import { OperationService, type OperationRecovery } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  InitiatedWorkEngine,
  type InitiatedWorkAdmission,
  type InitiatedWorkExecution,
  type InitiatedWorkGateCheck,
  type InitiatedWorkRequest,
  type InitiatedWorkResumer,
  type InitiatedWorkRunControl,
} from '../engine';

let dir: string;
let operations: OperationService;
let engine: InitiatedWorkEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'initiated-work-engine-'));
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  engine = new InitiatedWorkEngine({ operations });
  await operations.ready();
});

afterEach(() => {
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

const SUCCEEDED: InitiatedWorkRunResult = {
  status: 'succeeded',
  exitCode: 0,
  durationMs: 5,
};

function hookOrigin(occurrenceKey?: string): OperationOrigin {
  return {
    kind: 'hook',
    sourceId: 'project:pr:create',
    ...(occurrenceKey ? { occurrenceKey } : {}),
  };
}

interface Pending {
  control: InitiatedWorkRunControl;
  finish(result?: InitiatedWorkRunResult): void;
}

function request(
  overrides: Partial<InitiatedWorkRequest<string>> = {},
  pending: Pending[] = [],
): InitiatedWorkRequest<string> {
  return {
    origin: hookOrigin(),
    owner: { kind: 'organization', id: 'org-1' },
    scope: { workspaceId: 'p', worktreeId: 'w' },
    targetKey: 'p/w/project',
    gates: [],
    execute: (control) =>
      new Promise<InitiatedWorkExecution<string>>((resolve) => {
        pending.push({
          control,
          finish: (result = SUCCEEDED) => resolve({ value: 'done', result }),
        });
      }),
    ...overrides,
  };
}

function gate(
  name: InitiatedWorkGateCheck['gate'],
  verdict: ReturnType<InitiatedWorkGateCheck['check']>,
): InitiatedWorkGateCheck {
  return { gate: name, check: () => verdict };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function record(operationId: string | null): Promise<OperationRecord> {
  if (operationId === null) throw new Error('no operation');
  const operation = await operations.get(operationId);
  if (!operation) throw new Error('missing operation');
  return operation;
}

describe('InitiatedWorkEngine', () => {
  it('records the source, occurrence, owner, gates, artifacts and result of a run', async () => {
    const pending: Pending[] = [];
    const submission = engine.submit(
      request(
        {
          origin: hookOrigin('occurrence-1'),
          gates: [gate('pause', { decision: 'passed' })],
        },
        pending,
      ),
    );
    await settle();
    const [run] = pending;
    expect((await record(run.control.operationId)).status).toBe('running');
    run.control.recordArtifact({ kind: 'runLog', id: 'run-1' });
    run.control.recordGate('commandGate', 'passed', { actionIndex: 0 });
    run.finish();

    const done = await submission;
    expect(done).toMatchObject({ disposition: 'ran', value: 'done' });
    const operation = await record(run.control.operationId);
    expect(operation).toMatchObject({
      kind: 'core.initiatedWork.run',
      status: 'completed',
      origin: hookOrigin('occurrence-1'),
      owner: { kind: 'organization', id: 'org-1' },
      scope: { workspaceId: 'p', worktreeId: 'w' },
      receipt: { idempotencyKey: 'occurrence-1', outcome: 'recorded' },
    });
    expect(parseInitiatedWorkRunRecord(operation.outcome)).toEqual({
      disposition: 'ran',
      gates: [
        expect.objectContaining({ gate: 'pause', decision: 'passed' }),
        expect.objectContaining({ gate: 'dedup', decision: 'passed' }),
        expect.objectContaining({ gate: 'busyTarget', decision: 'passed' }),
        expect.objectContaining({
          gate: 'commandGate',
          decision: 'passed',
          actionIndex: 0,
        }),
      ],
      artifacts: [{ kind: 'runLog', id: 'run-1' }],
      result: SUCCEEDED,
    });
  });

  it('records a skip as a completed run that consumes its occurrence', async () => {
    const execute = jest.fn();
    const skipped = await engine.submit(
      request({
        origin: hookOrigin('occurrence-2'),
        gates: [gate('pause', { decision: 'skipped', message: 'Paused.' })],
        execute,
      }),
    );
    expect(skipped).toMatchObject({ disposition: 'skipped', gate: 'pause' });
    expect(execute).not.toHaveBeenCalled();
    const operationId =
      skipped.disposition === 'skipped' ? skipped.operationId : null;
    const operation = await record(operationId);
    expect(operation.status).toBe('completed');
    expect(parseInitiatedWorkRunRecord(operation.outcome)).toMatchObject({
      disposition: 'skipped',
      gates: [{ gate: 'pause', decision: 'skipped', message: 'Paused.' }],
      result: null,
    });

    const repeat = await engine.submit(
      request({ origin: hookOrigin('occurrence-2'), execute }),
    );
    expect(repeat).toMatchObject({
      disposition: 'duplicate',
      operation: { operationId },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records a refusal as a failed run with the gate code and leaves the occurrence open', async () => {
    const cause = new Error('locked');
    const refused = await engine.submit(
      request({
        origin: hookOrigin('occurrence-3'),
        gates: [
          gate('deletionFence', { decision: 'passed' }),
          gate('splitLock', {
            decision: 'refused',
            failure: {
              kind: 'failed_precondition',
              message: 'This worktree is locked.',
              retry: { kind: 'never' },
            },
            cause,
          }),
        ],
      }),
    );
    expect(refused).toMatchObject({
      disposition: 'refused',
      gate: 'splitLock',
      cause,
    });
    const operation = await record(
      refused.disposition === 'refused' ? refused.operationId : null,
    );
    expect(operation.status).toBe('failed');
    expect(operation.receipt.idempotencyKey).toBeNull();
    expect(operation.error).toMatchObject({
      code: 'core.initiatedWork.gate.splitLock',
      message: 'This worktree is locked.',
    });
    expect(
      parseInitiatedWorkRunRecord(operation.error?.details)?.gates,
    ).toEqual([
      expect.objectContaining({ gate: 'deletionFence', decision: 'passed' }),
      expect.objectContaining({ gate: 'splitLock', decision: 'refused' }),
    ]);

    const pending: Pending[] = [];
    const retried = engine.submit(
      request({ origin: hookOrigin('occurrence-3') }, pending),
    );
    await settle();
    pending[0]?.finish();
    expect(await retried).toMatchObject({ disposition: 'ran' });
  });

  it('runs one run per target in order, records the wait, and runs other targets alongside', async () => {
    const pending: Pending[] = [];
    const order: string[] = [];
    const first = engine.submit(
      request({ onQueued: () => order.push('queued first') }, pending),
    );
    const second = engine.submit(
      request({ onQueued: () => order.push('queued second') }, pending),
    );
    const other = engine.submit(request({ targetKey: 'p/w/repo-a' }, pending));
    await settle();
    expect(order).toEqual(['queued first', 'queued second']);
    expect(pending).toHaveLength(2);
    expect(
      engine.liveRuns().map((run) => [run.targetKey, run.started]),
    ).toEqual([
      ['p/w/project', true],
      ['p/w/project', false],
      ['p/w/repo-a', true],
    ]);

    pending[0].finish();
    await first;
    await settle();
    expect(pending).toHaveLength(3);
    pending[1].finish();
    pending[2].finish();
    const secondDone = await second;
    await other;
    const operation = await record(
      secondDone.disposition === 'ran' ? secondDone.operationId : null,
    );
    expect(
      parseInitiatedWorkRunRecord(operation.outcome)?.gates.map(
        ({ gate: name, decision }) => `${name}:${decision}`,
      ),
    ).toEqual(['busyTarget:waited']);
  });

  it('reports a run queued only once its record is admitted', async () => {
    const onQueued = jest.fn();
    const admit = jest
      .spyOn(operations, 'admit')
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(engine.submit(request({ onQueued }))).rejects.toThrow(
      'ledger unavailable',
    );
    expect(onQueued).not.toHaveBeenCalled();
    admit.mockRestore();
  });

  it('keeps a target serialized when a queued run fails admission', async () => {
    const pending: Pending[] = [];
    const first = engine.submit(request({}, pending));
    await settle();
    jest
      .spyOn(operations, 'admit')
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(engine.submit(request({}, pending))).rejects.toThrow(
      'ledger unavailable',
    );
    const third = engine.submit(request({}, pending));
    await settle();
    expect(pending).toHaveLength(1);
    pending[0].finish();
    await first;
    await settle();
    expect(pending).toHaveLength(2);
    pending[1].finish();
    expect(await third).toMatchObject({ disposition: 'ran' });
  });

  it('records a command gate stop as a skipped run', async () => {
    const pending: Pending[] = [];
    const submission = engine.submit(request({}, pending));
    await settle();
    pending[0].control.recordGate('commandGate', 'skipped', {
      message: 'Exited 2.',
      actionIndex: 0,
    });
    pending[0].finish({ status: 'stopped', exitCode: 2, durationMs: 1 });
    const done = await submission;
    const operation = await record(
      done.disposition === 'ran' ? done.operationId : null,
    );
    expect(operation.status).toBe('completed');
    expect(parseInitiatedWorkRunRecord(operation.outcome)).toMatchObject({
      disposition: 'skipped',
      result: { status: 'stopped', exitCode: 2 },
    });
  });

  it('returns the recorded run for a repeated occurrence and refuses a reused key', async () => {
    const pending: Pending[] = [];
    const first = engine.submit(
      request({ origin: hookOrigin('occurrence-4') }, pending),
    );
    const repeat = await engine.submit(
      request({ origin: hookOrigin('occurrence-4') }, pending),
    );
    expect(repeat).toMatchObject({
      disposition: 'duplicate',
      operation: { status: 'queued' },
    });
    const reused = await engine.submit(
      request(
        {
          origin: { ...hookOrigin('occurrence-4'), context: { other: true } },
        },
        pending,
      ),
    );
    expect(reused).toMatchObject({
      disposition: 'refused',
      gate: 'dedup',
      operationId: null,
    });
    await settle();
    expect(pending).toHaveLength(1);
    pending[0].finish();
    await first;
  });

  it('lets another client cancel a queued run and observe it', async () => {
    const pending: Pending[] = [];
    const events: string[] = [];
    operations.subscribe((event) => {
      events.push(`${event.operation.operationId}:${event.event}`);
    });
    const running = engine.submit(request({}, pending));
    const queued = engine.submit(request({}, pending));
    await settle();
    const queuedRun = engine.liveRuns().find((run) => !run.started);
    const queuedId = queuedRun?.operationId ?? null;
    if (queuedId === null) throw new Error('the queued run was not admitted');

    const cancelled = await operations.cancel(queuedId, {
      reason: 'Not needed.',
      requestedBy: 'portal-client',
    });
    expect(cancelled.outcome).toBe('cancelled');
    expect(await queued).toEqual({
      disposition: 'cancelled',
      operationId: queuedId,
    });
    expect(await record(queuedId)).toMatchObject({
      status: 'cancelled',
      cancellation: { requestedBy: 'portal-client', reason: 'Not needed.' },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        `${queuedId}:cancelRequested`,
        `${queuedId}:cancelled`,
      ]),
    );
    pending[0].finish();
    await running;
    expect(pending).toHaveLength(1);
  });

  it('stops a running run cancelled through its operation', async () => {
    const pending: Pending[] = [];
    const submission = engine.submit(request({}, pending));
    await settle();
    const { control } = pending[0];
    const cancelled = await operations.cancel(control.operationId, {
      reason: 'Stop it.',
      requestedBy: 'desktop',
    });
    expect(cancelled.outcome).toBe('requested');
    expect(control.signal.aborted).toBe(true);
    control.recordGate('commandGate', 'cancelled', { actionIndex: 0 });
    pending[0].finish({ status: 'failed', exitCode: null, durationMs: 1 });
    expect(await submission).toMatchObject({
      disposition: 'ran',
      cancelled: true,
    });
    expect(await record(control.operationId)).toMatchObject({
      status: 'cancelled',
      cancellation: { requestedBy: 'desktop' },
    });
  });

  it('records a host stop on runs it selects', async () => {
    const pending: Pending[] = [];
    const running = engine.submit(request({}, pending));
    const queued = engine.submit(request({}, pending));
    const elsewhere = engine.submit(
      request(
        {
          scope: { workspaceId: 'p', worktreeId: 'w-2' },
          targetKey: 'p/w-2/project',
        },
        pending,
      ),
    );
    await settle();
    const stop = engine.cancelWhere((run) => run.scope.worktreeId === 'w', {
      reason: 'Worktree removed.',
      requestedBy: 'core',
    });
    expect(pending[0]?.control.signal.aborted).toBe(true);
    pending[0].finish({ status: 'failed', exitCode: null, durationMs: 1 });
    await stop;
    const runningDone = await running;
    const queuedDone = await queued;
    expect(queuedDone.disposition).toBe('cancelled');
    for (const done of [runningDone, queuedDone]) {
      const operationId =
        done.disposition === 'ran' || done.disposition === 'cancelled'
          ? done.operationId
          : null;
      expect(await record(operationId)).toMatchObject({
        status: 'cancelled',
        cancellation: { reason: 'Worktree removed.', requestedBy: 'core' },
      });
    }
    expect(engine.liveRuns().map((run) => run.scope.worktreeId)).toEqual([
      'w-2',
    ]);
    pending[1].finish();
    expect(await elsewhere).toMatchObject({ disposition: 'ran' });
  });

  it('records a cancellation when the executor rejects on abort', async () => {
    let started: (control: InitiatedWorkRunControl) => void = () => undefined;
    const running = new Promise<InitiatedWorkRunControl>((resolve) => {
      started = resolve;
    });
    const submission = engine.submit(
      request({
        execute: (control) => {
          started(control);
          return new Promise((_resolve, reject) => {
            control.signal.addEventListener('abort', () =>
              reject(new Error('AbortError')),
            );
          });
        },
      }),
    );
    const control = await running;
    const cancelled = await operations.cancel(control.operationId, {
      reason: 'Stop it.',
      requestedBy: 'desktop',
    });
    expect(cancelled.outcome).toBe('requested');
    expect(await submission).toEqual({
      disposition: 'cancelled',
      operationId: control.operationId,
    });
    expect(await record(control.operationId)).toMatchObject({
      status: 'cancelled',
      error: null,
      cancellation: { requestedBy: 'desktop' },
    });
  });

  it('fails the run when its executor throws', async () => {
    const thrown = new Error('boom');
    await expect(
      engine.submit(request({ execute: () => Promise.reject(thrown) })),
    ).rejects.toBe(thrown);
    const page = await operations.list({ limit: 10 });
    expect(page.items[0]).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.run.failed' },
    });
  });

  it('reports an interrupted run as lost after a restart', async () => {
    const pending: Pending[] = [];
    void engine.submit(request({}, pending));
    await settle();
    const { operationId } = pending[0].control;
    operations.close();
    operations = new OperationService({
      openLedger: (): OperationLedger =>
        OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
    });
    engine = new InitiatedWorkEngine({ operations });
    expect(await record(operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'core.operation.interrupted' },
      restart: { class: 'resumable', disposition: 'lost' },
    });
  });
});

describe('InitiatedWorkEngine firing and restart recovery (CAN-4145)', () => {
  const ledgerPath = (): string => join(dir, 'operation-ledger.sqlite');

  function admission(
    occurrenceKey: string,
    overrides: Partial<InitiatedWorkAdmission> = {},
  ): InitiatedWorkAdmission {
    return {
      origin: hookOrigin(occurrenceKey),
      owner: { kind: 'organization', id: 'org-1' },
      scope: { workspaceId: 'p', worktreeId: 'w' },
      targetKey: 'p/w/project',
      ...overrides,
    };
  }

  function restart(): void {
    operations.close();
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(ledgerPath()),
    });
    engine = new InitiatedWorkEngine({
      operations,
      recoverableOrigins: ['hook'],
    });
  }

  interface ResumerCalls {
    resumed: string[];
    reconciled: string[];
    executed: string[];
  }

  function resumer(
    calls: ResumerCalls,
    answer: (operation: OperationRecord) => 'resume' | 'invalidated' = () =>
      'resume',
    reconciled: OperationRecovery = { status: 'lost' },
  ): InitiatedWorkResumer {
    return {
      targetKey: () => 'p/w/project',
      resume: (operation) => {
        calls.resumed.push(operation.origin.occurrenceKey ?? '');
        if (answer(operation) === 'invalidated')
          return Promise.resolve({
            status: 'invalidated',
            message: 'This hook is no longer configured.',
          });
        return Promise.resolve({
          status: 'resume',
          request: {
            gates: [],
            execute: () => {
              calls.executed.push(operation.origin.occurrenceKey ?? '');
              return Promise.resolve({ value: 'done', result: SUCCEEDED });
            },
          },
        });
      },
      reconcile: (operation) => {
        calls.reconciled.push(operation.origin.occurrenceKey ?? '');
        return Promise.resolve(reconciled);
      },
    };
  }

  const calls = (): ResumerCalls => ({
    resumed: [],
    reconciled: [],
    executed: [],
  });

  it('records the seen state and every accepted run in one transaction', async () => {
    const accepted = await engine.acceptOccurrence({
      head: { source: 'github.pr', subject: 'p/w/project', value: 'head-1' },
      runs: [
        admission('occurrence-1'),
        admission('occurrence-2', {
          origin: { ...hookOrigin('occurrence-2'), sourceId: 'paused-hook' },
          stopped: {
            gate: 'pause',
            verdict: { decision: 'skipped', message: 'Paused.' },
          },
        }),
      ],
    });
    expect(accepted.map((entry) => entry.status)).toEqual([
      'accepted',
      'stopped',
    ]);
    expect(await engine.sourceHead('github.pr', 'p/w/project')).toBe('head-1');
    const [first, second] = accepted;
    if (first.status !== 'accepted' || second.status !== 'stopped')
      throw new Error('unexpected acceptance');
    expect((await record(first.operationId)).status).toBe('queued');
    expect(await record(second.operationId)).toMatchObject({
      status: 'completed',
      outcome: { disposition: 'skipped' },
    });

    // A redelivery of the same state finds the runs it already accepted.
    const again = await engine.acceptOccurrence({
      head: { source: 'github.pr', subject: 'p/w/project', value: 'head-1' },
      runs: [admission('occurrence-1')],
    });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      status: 'duplicate',
      operation: { operationId: first.operationId },
    });
  });

  it('records nothing when one of the runs cannot be accepted', async () => {
    await expect(
      engine.acceptOccurrence({
        head: { source: 'github.pr', subject: 'p/w/project', value: 'head-2' },
        runs: [
          admission('occurrence-1'),
          admission('occurrence-2', {
            scope: { workspaceId: '', worktreeId: 'w' },
          }),
        ],
      }),
    ).rejects.toThrow();
    expect(await engine.sourceHead('github.pr', 'p/w/project')).toBeNull();
    const page = await operations.list({ limit: 10 });
    expect(page.items).toHaveLength(0);
  });

  it('runs an accepted run once it is started, recording its gates', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    const pending: Pending[] = [];
    const run = engine.runAccepted(
      accepted.operationId,
      request({ origin: hookOrigin('occurrence-1') }, pending),
    );
    await settle();
    pending[0].finish();
    expect(await run).toMatchObject({ disposition: 'ran' });
    expect(
      parseInitiatedWorkRunRecord((await record(accepted.operationId)).outcome)
        ?.gates,
    ).toEqual([
      expect.objectContaining({ gate: 'dedup', decision: 'passed' }),
      expect.objectContaining({ gate: 'busyTarget', decision: 'passed' }),
    ]);
  });

  it('keeps an accepted run ahead of work submitted before it was started', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    const order: string[] = [];
    const later = engine.submit(
      request({
        origin: hookOrigin('occurrence-2'),
        execute: (): Promise<InitiatedWorkExecution<string>> => {
          order.push('occurrence-2');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    await settle();
    expect(order).toEqual([]);
    await engine.runAccepted(
      accepted.operationId,
      request({
        origin: hookOrigin('occurrence-1'),
        execute: (): Promise<InitiatedWorkExecution<string>> => {
          order.push('occurrence-1');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    await later;
    expect(order).toEqual(['occurrence-1', 'occurrence-2']);
  });

  it('keeps an accepted run ahead of work submitted while its acceptance is still being written', async () => {
    const order: string[] = [];
    const accepting = engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    const later = engine.submit(
      request({
        origin: hookOrigin('occurrence-2'),
        execute: (): Promise<InitiatedWorkExecution<string>> => {
          order.push('occurrence-2');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    const [accepted] = await accepting;
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    await settle();
    expect(order).toEqual([]);
    await engine.runAccepted(
      accepted.operationId,
      request({
        origin: hookOrigin('occurrence-1'),
        execute: (): Promise<InitiatedWorkExecution<string>> => {
          order.push('occurrence-1');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    await later;
    expect(order).toEqual(['occurrence-1', 'occurrence-2']);
  });

  it('gives a reserved place back when the occurrence was already accepted', async () => {
    const [first] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (first.status !== 'accepted') throw new Error('not accepted');
    await engine.runAccepted(
      first.operationId,
      request({
        origin: hookOrigin('occurrence-1'),
        execute: () => Promise.resolve({ value: 'done', result: SUCCEEDED }),
      }),
    );
    const [again] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    expect(again.status).toBe('duplicate');
    // Same target: a place the duplicate kept would block this run forever.
    const done = await engine.submit(
      request({
        origin: hookOrigin('occurrence-2'),
        execute: () => Promise.resolve({ value: 'done', result: SUCCEEDED }),
      }),
    );
    expect(done).toMatchObject({ disposition: 'ran' });
  });

  it('honors a target stop that arrives between acceptance and start, now and after a restart', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    await engine.cancelWhere((run) => run.targetKey === 'p/w/project', {
      requestedBy: 'host',
      reason: 'The worktree is closing.',
    });
    const executed: string[] = [];
    const result = await engine.runAccepted(
      accepted.operationId,
      request({
        origin: hookOrigin('occurrence-1'),
        execute: (): Promise<InitiatedWorkExecution<string>> => {
          executed.push('occurrence-1');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    expect(result).toMatchObject({ disposition: 'cancelled' });
    expect(executed).toEqual([]);
    expect((await record(accepted.operationId)).status).toBe('cancelled');

    restart();
    const seen = calls();
    engine.registerResumer('hook', resumer(seen));
    await engine.whenRecovered();
    expect(seen.resumed).toEqual([]);
    expect((await record(accepted.operationId)).status).toBe('cancelled');
  });

  it('resumes accepted runs that never started after a restart, in their order and ahead of new work', async () => {
    await engine.acceptOccurrence({
      runs: [admission('occurrence-1'), admission('occurrence-2')],
    });
    restart();
    const seen = calls();
    const order: string[] = [];
    engine.registerResumer('hook', {
      ...resumer(seen),
      resume: async (operation) => {
        seen.resumed.push(operation.origin.occurrenceKey ?? '');
        // The first run takes longer to revalidate; it still runs first.
        if (operation.origin.occurrenceKey === 'occurrence-1')
          await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          status: 'resume',
          request: {
            gates: [],
            execute: (): Promise<InitiatedWorkExecution<string>> => {
              order.push(operation.origin.occurrenceKey ?? '');
              return Promise.resolve({ value: 'done', result: SUCCEEDED });
            },
          },
        };
      },
    });
    await operations.whenReconciled();
    const newer = engine.submit(
      request({
        origin: hookOrigin('occurrence-3'),
        execute: () => {
          order.push('occurrence-3');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    await newer;
    expect(order).toEqual(['occurrence-1', 'occurrence-2', 'occurrence-3']);
    const page = await operations.list({ limit: 10 });
    expect(
      page.items
        .filter(
          (operation) => operation.origin.occurrenceKey !== 'occurrence-3',
        )
        .map((operation) => [operation.status, operation.restart?.disposition]),
    ).toEqual([
      ['completed', 'resumed'],
      ['completed', 'resumed'],
    ]);
  });

  it('keeps a recovered run ahead of new work submitted before the ledger opened', async () => {
    await engine.acceptOccurrence({ runs: [admission('occurrence-1')] });
    restart();
    const order: string[] = [];
    const seen = calls();
    engine.registerResumer('hook', {
      ...resumer(seen),
      resume: (operation) =>
        Promise.resolve({
          status: 'resume',
          request: {
            gates: [],
            execute: (): Promise<InitiatedWorkExecution<string>> => {
              order.push(operation.origin.occurrenceKey ?? '');
              return Promise.resolve({ value: 'done', result: SUCCEEDED });
            },
          },
        }),
    });
    // Submitted before anything opened the ledger or found the recovered run.
    await engine.submit(
      request({
        origin: hookOrigin('occurrence-2'),
        execute: (): Promise<InitiatedWorkExecution<string>> => {
          order.push('occurrence-2');
          return Promise.resolve({ value: 'done', result: SUCCEEDED });
        },
      }),
    );
    expect(order).toEqual(['occurrence-1', 'occurrence-2']);
  });

  it('keeps queued runs unstarted once the process stops starting work, so they resume', async () => {
    const pending: Pending[] = [];
    void engine.submit(
      request({ origin: hookOrigin('occurrence-1') }, pending),
    );
    const queued = engine.submit(
      request({ origin: hookOrigin('occurrence-2') }, pending),
    );
    await settle();
    expect(pending).toHaveLength(1);
    engine.stopStarting();
    pending[0].finish();
    const held = await queued;
    if (held.disposition !== 'held') throw new Error('not held');
    expect((await record(held.operationId)).status).toBe('queued');
    expect(pending).toHaveLength(1);

    restart();
    const seen = calls();
    engine.registerResumer('hook', resumer(seen));
    await engine.whenRecovered();
    await settle();
    expect(seen.executed).toEqual(['occurrence-2']);
  });

  it('ends a recovered run cancelled before its source registers, and the target moves on', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    restart();
    await operations.ready();
    await operations.cancel(accepted.operationId, {
      requestedBy: 'user-1',
      reason: 'Stopped.',
    });
    const seen = calls();
    engine.registerResumer('hook', resumer(seen));
    await engine.whenRecovered();
    expect(seen.resumed).toEqual([]);
    expect((await record(accepted.operationId)).status).toBe('cancelled');
    const next = await engine.submit(
      request({
        origin: hookOrigin('o-2'),
        execute: () => Promise.resolve({ value: 'done', result: SUCCEEDED }),
      }),
    );
    expect(next).toMatchObject({ disposition: 'ran' });
  });

  it('settles a run cancelled before it reached its queue without waiting for the running one', async () => {
    restart();
    engine.registerResumer('hook', resumer(calls()));
    const pending: Pending[] = [];
    void engine.submit(request({ origin: hookOrigin('o-1') }, pending));
    await settle();
    const second = engine.submit(request({ origin: hookOrigin('o-2') }));
    await engine.cancelWhere((run) => run.origin.occurrenceKey === 'o-2', {
      requestedBy: 'host',
      reason: 'Stopped.',
    });
    await expect(second).resolves.toMatchObject({ disposition: 'cancelled' });
    expect(pending).toHaveLength(1);
    pending[0].finish();
  });

  it('waits for its source before resuming, and ends a run its source invalidated visibly', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    restart();
    await operations.ready();
    await settle();
    expect(await record(accepted.operationId)).toMatchObject({
      status: 'paused',
      restart: { disposition: 'awaiting-resume' },
    });
    const seen = calls();
    engine.registerResumer(
      'hook',
      resumer(seen, () => 'invalidated'),
    );
    await operations.whenReconciled();
    expect(seen.executed).toEqual([]);
    expect(await record(accepted.operationId)).toMatchObject({
      status: 'failed',
      error: {
        code: 'core.initiatedWork.run.invalidated',
        message: 'This hook is no longer configured.',
      },
    });
  });

  it('reconciles a run that may have started by its identity instead of running it again', async () => {
    const pending: Pending[] = [];
    void engine.submit(
      request({ origin: hookOrigin('occurrence-1') }, pending),
    );
    await settle();
    const { operationId } = pending[0].control;
    restart();
    const seen = calls();
    engine.registerResumer(
      'hook',
      resumer(seen, () => 'resume', {
        status: 'completed',
        outcome: { disposition: 'ran', gates: [], artifacts: [], result: null },
      }),
    );
    await operations.whenReconciled();
    expect(seen).toEqual({
      resumed: [],
      reconciled: ['occurrence-1'],
      executed: [],
    });
    expect(await record(operationId)).toMatchObject({
      status: 'completed',
      restart: { disposition: 'resumed' },
    });
  });

  it('never resumes a run cancelled before the restart', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    await operations.write((ledger) => ({
      value: undefined,
      events: [
        ledger.requestCancel(accepted.operationId, {
          requestedAt: new Date().toISOString(),
          requestedBy: 'user-1',
          reason: 'Stopped.',
        }).event,
      ],
    }));
    restart();
    const seen = calls();
    engine.registerResumer('hook', resumer(seen));
    await operations.whenReconciled();
    expect(seen.resumed).toEqual([]);
    expect(await record(accepted.operationId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('lets a client cancel a recovered run before it starts', async () => {
    const [accepted] = await engine.acceptOccurrence({
      runs: [admission('occurrence-1')],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    restart();
    const seen = calls();
    let releaseResume = (): void => undefined;
    engine.registerResumer('hook', {
      ...resumer(seen),
      resume: async (operation, signal) => {
        await new Promise<void>((resolve) => {
          releaseResume = resolve;
        });
        expect(signal.aborted).toBe(true);
        return resumer(seen).resume(operation, signal);
      },
    });
    await operations.ready();
    await settle();
    await operations.cancel(accepted.operationId, {
      requestedBy: 'user-1',
      reason: 'Stopped.',
    });
    releaseResume();
    await operations.whenReconciled();
    expect(seen.executed).toEqual([]);
    expect(await record(accepted.operationId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('defers a run that needs a client until one connects', async () => {
    let attached = false;
    let connect = (): void => undefined;
    const pending: Pending[] = [];
    const submission = engine.submit(
      request(
        {
          client: {
            attached: () => attached,
            whenAttached: () =>
              new Promise<void>((resolve) => {
                connect = (): void => {
                  attached = true;
                  resolve();
                };
              }),
          },
        },
        pending,
      ),
    );
    await settle();
    expect(pending).toHaveLength(0);
    connect();
    await settle();
    pending[0].finish();
    const done = await submission;
    if (done.disposition !== 'ran') throw new Error('did not run');
    expect(
      parseInitiatedWorkRunRecord(
        (await record(done.operationId)).outcome,
      )?.gates.map((outcome) => [outcome.gate, outcome.decision]),
    ).toEqual([
      ['busyTarget', 'passed'],
      ['client', 'waited'],
    ]);
  });

  it('records a deferred run cancelled while it waits for a client', async () => {
    const submission = engine.submit(
      request({
        client: {
          attached: () => false,
          whenAttached: () => new Promise<void>(() => undefined),
        },
      }),
    );
    await settle();
    const [live] = engine.liveRuns();
    await engine.cancelWhere(() => true, {
      requestedBy: 'host',
      reason: 'Worktree removed.',
    });
    expect(await submission).toMatchObject({ disposition: 'cancelled' });
    expect(await record(live.operationId)).toMatchObject({
      status: 'cancelled',
    });
  });
});
