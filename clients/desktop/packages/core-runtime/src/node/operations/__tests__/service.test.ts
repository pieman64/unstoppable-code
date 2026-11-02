import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OperationRecord } from '@canopy/protocol/canopy-core';

import {
  OperationCancelRefusedError,
  OperationService,
  type OperationDomain,
  type OperationRecovery,
} from '..';
import {
  OperationLedger,
  OperationLedgerError,
  type OperationAcceptRequest,
} from '../ledger';

let dir: string;
let dbPath: string;
let services: OperationService[];

function createService(domains: OperationDomain[] = []): OperationService {
  const service = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(dbPath),
  });
  for (const domain of domains) service.registerDomain(domain);
  services.push(service);
  return service;
}

/** A restart: the old process is gone without finishing anything. */
function restart(
  previous: OperationService,
  domains: OperationDomain[] = [],
): OperationService {
  previous.close();
  return createService(domains);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-service-'));
  dbPath = join(dir, 'operation-ledger.sqlite');
  services = [];
});

afterEach(() => {
  for (const service of services) service.close();
  rmSync(dir, { recursive: true, force: true });
});

interface FakeDomain extends OperationDomain {
  cancelled: string[];
  recovered: string[];
}

function domain(
  kind: string,
  restartClass: OperationDomain['restartClass'],
  behavior: {
    cancel?: (operation: OperationRecord) => Promise<'cancelled' | 'requested'>;
    recover?: (operation: OperationRecord) => Promise<OperationRecovery>;
  } = {},
): FakeDomain {
  const cancelled: string[] = [];
  const recovered: string[] = [];
  return {
    domain: kind.split('.')[1],
    kinds: [kind],
    restartClass,
    cancelled,
    recovered,
    cancel: async (operation): Promise<'cancelled' | 'requested'> => {
      cancelled.push(operation.operationId);
      return behavior.cancel ? behavior.cancel(operation) : 'cancelled';
    },
    ...(restartClass === 'lost'
      ? {}
      : {
          recover: async (operation): Promise<OperationRecovery> => {
            recovered.push(operation.operationId);
            return behavior.recover
              ? behavior.recover(operation)
              : { status: 'running' };
          },
        }),
  };
}

function admission(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: 'core.pipeline.run',
    status: 'running',
    origin: { kind: 'client', sourceId: 'window-a' },
    owner: { kind: 'organization', id: 'org-1' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    receipt: {
      caller: 'local-user',
      idempotencyKey: 'k-1',
      fingerprint: 'p-1',
    },
    ...overrides,
  };
}

/**
 * A domain's request handler as CAN-4132 will write it: admit first, start
 * the effect only for newly accepted work, and wait for the outcome on the
 * caller's own signal, which never reaches the work.
 */
async function handleRun(
  service: OperationService,
  effects: { started: number; finish?: () => Promise<void> },
  signal: AbortSignal,
): Promise<OperationRecord> {
  const admitted = await service.admit(admission());
  if (admitted.status === 'accepted') {
    effects.started += 1;
    const operationId = admitted.operation.operationId;
    void (effects.finish ?? ((): Promise<void> => Promise.resolve()))().then(
      () =>
        service.finish(operationId, {
          status: 'completed',
          outcome: { ok: true },
        }),
    );
  }
  return service.waitForTerminal(admitted.operation.operationId, signal);
}

describe('admission', () => {
  it('runs keyed work once when the first acknowledgement is lost', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effects = { started: 0, finish: (): Promise<void> => gate };
    const lost = new AbortController();
    const first = handleRun(createService(), effects, lost.signal);
    // The client's delivery budget runs out before any reply.
    lost.abort(new Error('delivery budget exhausted'));
    await expect(first).rejects.toThrow('delivery budget exhausted');

    const service = services[0];
    const [running] = (await service.list({ limit: 10 })).items;
    expect(
      await service.reportProgress(running.operationId, 0.25),
    ).toMatchObject({ progress: 0.25, status: 'running' });
    expect(running).toMatchObject({
      status: 'running',
      receipt: { outcome: 'pending' },
    });

    // The retry finds the work in progress and starts nothing new.
    const retry = handleRun(service, effects, new AbortController().signal);
    release();
    const finished = await retry;
    expect(finished).toMatchObject({
      operationId: running.operationId,
      status: 'completed',
      outcome: { ok: true },
    });
    expect(effects.started).toBe(1);

    // A later retry replays the recorded outcome.
    expect(
      await handleRun(service, effects, new AbortController().signal),
    ).toEqual(finished);
    expect(effects.started).toBe(1);
  });

  it('keeps accepted work when the caller’s budget expires, even across a restart', async () => {
    const service = createService();
    const admitted = await service.admit(admission());
    const expired = AbortSignal.abort(new Error('deadline'));
    await expect(
      service.waitForTerminal(admitted.operation.operationId, expired),
    ).rejects.toThrow('deadline');
    expect(await service.get(admitted.operation.operationId)).toMatchObject({
      status: 'running',
      cancellation: null,
    });
    const next = restart(service);
    expect(await next.get(admitted.operation.operationId)).toMatchObject({
      operationId: admitted.operation.operationId,
      cancellation: null,
    });
  });
});

describe('opening the ledger', () => {
  it('retries after a failed open instead of caching the failure', async () => {
    let attempts = 0;
    const service = new OperationService({
      openLedger: (): OperationLedger => {
        attempts += 1;
        if (attempts === 1)
          throw new OperationLedgerError(
            'WRITER_UNAVAILABLE',
            'Another writer holds the operation ledger.',
          );
        return OperationLedger.open(dbPath);
      },
    });
    services.push(service);
    await expect(service.ready()).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
    });
    await expect(service.admit(admission())).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(attempts).toBe(2);
  });

  it('closes a ledger it could not reconcile, releasing the writer lock', async () => {
    const seed = createService();
    await seed.admit(admission());
    seed.close();

    const failed: OperationLedger[] = [];
    const service = new OperationService({
      openLedger: (): OperationLedger => {
        const ledger = OperationLedger.open(dbPath);
        if (failed.length === 0) {
          failed.push(ledger);
          jest.spyOn(ledger, 'listInterrupted').mockImplementation(() => {
            throw new Error('unreadable record');
          });
        }
        return ledger;
      },
    });
    services.push(service);
    await expect(service.ready()).rejects.toThrow('unreadable record');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.isOpen).toBe(false);
    // The lock is free and the next call opens and reconciles normally.
    const { items } = await service.list({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'paused',
      restart: { disposition: 'unclaimed' },
    });
  });
});

describe('cancellation', () => {
  it('lets another client cancel through the owning domain’s rules', async () => {
    const pipelines = domain('core.pipeline.run', 'lost');
    const service = createService([pipelines]);
    const { operation } = await service.admit(admission());
    const events: string[] = [];
    service.subscribe((event) => events.push(event.event));

    const result = await service.cancel(operation.operationId, {
      reason: 'Stop',
      requestedBy: 'local-user',
      expectedRevision: operation.revision,
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.operation).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'Stop', requestedBy: 'local-user' },
    });
    expect(pipelines.cancelled).toEqual([operation.operationId]);
    expect(events).toEqual(['cancelRequested', 'cancelled']);

    // A stale revision is a conflict even once the work has finished.
    await expect(
      service.cancel(operation.operationId, {
        reason: 'Again',
        requestedBy: 'local-user',
        expectedRevision: operation.revision,
      }),
    ).rejects.toMatchObject({ refusal: 'revision-conflict' });
    // Cancelling finished work changes nothing.
    expect(
      await service.cancel(operation.operationId, {
        reason: 'Again',
        requestedBy: 'local-user',
      }),
    ).toMatchObject({ outcome: 'already-terminal' });
    expect(pipelines.cancelled).toHaveLength(1);
  });

  it('keeps the work and withdraws the intent when the domain refuses', async () => {
    const hooks = domain('core.hook.run', 'lost', {
      cancel: () =>
        Promise.reject(
          new OperationCancelRefusedError('Hooks cannot stop mid-commit.'),
        ),
    });
    const service = createService([hooks]);
    const { operation } = await service.admit(
      admission({ kind: 'core.hook.run' }),
    );
    await expect(
      service.cancel(operation.operationId, {
        reason: 'Stop',
        requestedBy: 'local-user',
      }),
    ).rejects.toMatchObject({
      refusal: 'invalid-state',
      message: 'Hooks cannot stop mid-commit.',
    });
    expect(await service.get(operation.operationId)).toMatchObject({
      status: 'running',
      cancellation: null,
    });
  });

  it('keeps an accepted cancel when a concurrent one is refused', async () => {
    let refuse = (): void => undefined;
    const refusing = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    let calls = 0;
    const pipelines = domain('core.pipeline.run', 'lost', {
      cancel: async () => {
        calls += 1;
        if (calls > 1) return 'requested';
        await refusing;
        throw new OperationCancelRefusedError('Not at this step.');
      },
    });
    const service = createService([pipelines]);
    const { operation } = await service.admit(admission());
    const refused = service.cancel(operation.operationId, {
      reason: 'Stop',
      requestedBy: 'user-a',
    });
    const accepted = service.cancel(operation.operationId, {
      reason: 'Stop now',
      requestedBy: 'user-b',
    });
    refuse();
    await expect(refused).rejects.toMatchObject({ refusal: 'invalid-state' });
    await expect(accepted).resolves.toMatchObject({ outcome: 'requested' });
    // The domain is stopping the work, so a restart must not resume it.
    expect(await service.get(operation.operationId)).toMatchObject({
      status: 'running',
      cancellation: { requestedBy: 'user-b', reason: 'Stop now' },
    });
  });

  it('waits for a domain that stops asynchronously, and cascades to children', async () => {
    const pipelines = domain('core.pipeline.run', 'lost', {
      cancel: () => Promise.resolve('requested'),
    });
    const steps = domain('worker.pipeline.step', 'lost');
    const service = createService([pipelines, steps]);
    const parent = (await service.admit(admission())).operation;
    const child = (
      await service.admit(
        admission({
          kind: 'worker.pipeline.step',
          receipt: undefined,
          parentOperationId: parent.operationId,
        }),
      )
    ).operation;

    const result = await service.cancel(parent.operationId, {
      reason: 'Stop',
      requestedBy: 'local-user',
    });
    expect(result).toMatchObject({
      outcome: 'requested',
      operation: { status: 'running' },
    });
    expect(steps.cancelled).toEqual([child.operationId]);
    expect(await service.get(child.operationId)).toMatchObject({
      status: 'cancelled',
    });
    await service.finish(parent.operationId, { status: 'cancelled' });
    expect(await service.get(parent.operationId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('delivers a retried cancel again after the domain failed, children included', async () => {
    let failures = 1;
    const pipelines = domain('core.pipeline.run', 'lost', {
      cancel: () => {
        if (failures-- > 0)
          return Promise.reject(new Error('pipeline host unavailable'));
        return Promise.resolve('cancelled');
      },
    });
    const steps = domain('worker.pipeline.step', 'lost');
    const service = createService([pipelines, steps]);
    const parent = (await service.admit(admission())).operation;
    const child = (
      await service.admit(
        admission({
          kind: 'worker.pipeline.step',
          receipt: undefined,
          parentOperationId: parent.operationId,
        }),
      )
    ).operation;
    const request = { reason: 'Stop', requestedBy: 'local-user' };
    await expect(service.cancel(parent.operationId, request)).rejects.toThrow(
      'pipeline host unavailable',
    );
    expect(await service.get(parent.operationId)).toMatchObject({
      status: 'running',
      cancellation: { reason: 'Stop' },
    });

    const retried = await service.cancel(parent.operationId, request);
    expect(retried).toMatchObject({
      outcome: 'cancelled',
      operation: { status: 'cancelled' },
    });
    expect(pipelines.cancelled).toEqual([
      parent.operationId,
      parent.operationId,
    ]);
    expect(steps.cancelled).toEqual([child.operationId]);
    expect(await service.get(child.operationId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('cascades a revision-checked cancel to children without their revision', async () => {
    const pipelines = domain('core.pipeline.run', 'lost');
    const steps = domain('worker.pipeline.step', 'lost');
    const service = createService([pipelines, steps]);
    const parent = (await service.admit(admission())).operation;
    const child = (
      await service.admit(
        admission({
          kind: 'worker.pipeline.step',
          receipt: undefined,
          parentOperationId: parent.operationId,
        }),
      )
    ).operation;
    await service.transition(child.operationId, 'paused');
    await service.cancel(parent.operationId, {
      reason: 'Stop',
      requestedBy: 'local-user',
      expectedRevision: parent.revision,
    });
    expect(steps.cancelled).toEqual([child.operationId]);
    expect(await service.get(child.operationId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('does not report cancelled for work that completed while stopping', async () => {
    let service: OperationService | null = null;
    const pipelines = domain('core.pipeline.run', 'lost', {
      cancel: async (operation) => {
        await service?.finish(operation.operationId, {
          status: 'completed',
          outcome: { ok: true },
        });
        return 'cancelled';
      },
    });
    service = createService([pipelines]);
    const { operation } = await service.admit(admission());
    expect(
      await service.cancel(operation.operationId, {
        reason: 'Stop',
        requestedBy: 'local-user',
      }),
    ).toMatchObject({
      outcome: 'already-terminal',
      operation: { status: 'completed', outcome: { ok: true } },
    });
  });

  it('refuses when no running domain owns the kind', async () => {
    const service = createService();
    const { operation } = await service.admit(admission());
    await expect(
      service.cancel(operation.operationId, {
        reason: 'Stop',
        requestedBy: 'local-user',
      }),
    ).rejects.toMatchObject({ refusal: 'invalid-state' });
  });
});

describe('restart reconciliation', () => {
  async function seed(
    service: OperationService,
  ): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const kind of [
      'core.script.run',
      'core.pipeline.run',
      'worker.terminal.session',
      'core.codeGraph.build',
    ])
      ids[kind] = (
        await service.admit(admission({ kind, receipt: undefined }))
      ).operation.operationId;
    return ids;
  }

  it('reconciles by each domain’s class and leaves nothing running', async () => {
    const ids = await seed(createService());
    let finishRecovery = (): void => undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const scripts = domain('core.script.run', 'lost');
    const pipelines = domain('core.pipeline.run', 'resumable', {
      recover: async () => {
        await recoveryGate;
        return { status: 'running' };
      },
    });
    const terminals = domain('worker.terminal.session', 'reattachable', {
      recover: async () => {
        await recoveryGate;
        return { status: 'completed', outcome: { exitCode: 0 } };
      },
    });
    const service = restart(services[0], [scripts, pipelines, terminals]);
    await service.ready();

    // Before any domain answers, nothing claims to be running.
    const statuses = (await service.list({ limit: 10 })).items.map((op) => [
      op.kind,
      op.status,
      op.restart?.disposition,
    ]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        ['core.script.run', 'failed', 'lost'],
        ['core.pipeline.run', 'paused', 'awaiting-resume'],
        ['worker.terminal.session', 'paused', 'awaiting-reattach'],
        ['core.codeGraph.build', 'paused', 'unclaimed'],
      ]),
    );
    expect(await service.get(ids['core.script.run'])).toMatchObject({
      error: { code: 'core.operation.interrupted' },
      restart: { class: 'lost' },
    });

    finishRecovery();
    await service.whenReconciled();
    expect(await service.get(ids['core.pipeline.run'])).toMatchObject({
      status: 'running',
      restart: { class: 'resumable', disposition: 'resumed' },
    });
    expect(await service.get(ids['worker.terminal.session'])).toMatchObject({
      status: 'completed',
      outcome: { exitCode: 0 },
      restart: { class: 'reattachable', disposition: 'reattached' },
    });
    // A lost domain is never asked to run the work again.
    expect(pipelines.recovered).toEqual([ids['core.pipeline.run']]);

    // The unclaimed kind is reconciled once its domain registers.
    const graph = domain('core.codeGraph.build', 'lost');
    service.registerDomain(graph);
    expect(await service.get(ids['core.codeGraph.build'])).toMatchObject({
      status: 'failed',
      restart: { class: 'lost', disposition: 'lost' },
    });
  });

  it('cancels interrupted work whose cancellation was requested instead of resuming it', async () => {
    const pipelines = domain('core.pipeline.run', 'resumable', {
      cancel: () => Promise.resolve('requested'),
    });
    const first = createService([pipelines]);
    const { operation } = await first.admit(admission());
    await first.cancel(operation.operationId, {
      reason: 'Stop',
      requestedBy: 'local-user',
    });
    const resumed = domain('core.pipeline.run', 'resumable');
    const service = restart(first, [resumed]);
    await service.whenReconciled();
    expect(await service.get(operation.operationId)).toMatchObject({
      status: 'cancelled',
      restart: { disposition: 'cancelled' },
    });
    expect(resumed.recovered).toEqual([]);
  });

  it('cancels the children of a cancelled parent instead of resuming them', async () => {
    const first = createService();
    const parent = (await first.admit(admission())).operation;
    const admitChild = async (
      kind: string,
      parentOperationId: string,
    ): Promise<string> =>
      (
        await first.admit(
          admission({ kind, receipt: undefined, parentOperationId }),
        )
      ).operation.operationId;
    const step = await admitChild('worker.pipeline.step', parent.operationId);
    const session = await admitChild('worker.terminal.session', step);
    const stopped = await admitChild('core.script.run', parent.operationId);
    const finished = await admitChild('core.script.run', parent.operationId);
    first.close();
    // The parent's intent, and for one parent its cancelled state, were
    // committed before the process died, but the cascade never ran.
    const ledger = OperationLedger.open(dbPath);
    const cancellation = {
      requestedAt: '2026-10-27T10:00:00.000Z',
      requestedBy: 'local-user',
      reason: 'Stop',
    };
    ledger.requestCancel(parent.operationId, cancellation);
    ledger.finish(finished, { status: 'completed' });
    ledger.close();

    const steps = domain('worker.pipeline.step', 'resumable');
    const terminals = domain('worker.terminal.session', 'reattachable');
    const service = restart(first, [
      domain('core.pipeline.run', 'resumable'),
      steps,
      terminals,
      domain('core.script.run', 'lost'),
    ]);
    await service.whenReconciled();

    expect(await service.get(parent.operationId)).toMatchObject({
      status: 'cancelled',
    });
    expect(await service.get(step)).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'Stop', requestedBy: 'local-user' },
      restart: { disposition: 'cancelled' },
    });
    expect(steps.recovered).toEqual([]);
    // Reattached work is found first, then stopped through its domain.
    expect(terminals.cancelled).toEqual([session]);
    expect(await service.get(session)).toMatchObject({ status: 'cancelled' });
    expect(await service.get(stopped)).toMatchObject({
      status: 'cancelled',
      error: null,
    });
    expect(await service.get(finished)).toMatchObject({ status: 'completed' });
  });

  it('cancels the children of a parent that was cancelled before the restart', async () => {
    const first = createService();
    const parent = (await first.admit(admission())).operation;
    const child = (
      await first.admit(
        admission({
          kind: 'worker.pipeline.step',
          receipt: undefined,
          parentOperationId: parent.operationId,
        }),
      )
    ).operation;
    first.close();
    const ledger = OperationLedger.open(dbPath);
    ledger.requestCancel(parent.operationId, {
      requestedAt: '2026-10-27T10:00:00.000Z',
      requestedBy: 'local-user',
      reason: 'Stop',
    });
    ledger.finish(parent.operationId, { status: 'cancelled' });
    ledger.close();

    const steps = domain('worker.pipeline.step', 'resumable');
    const service = restart(first, [steps]);
    await service.whenReconciled();
    expect(await service.get(child.operationId)).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'Stop' },
    });
    expect(steps.recovered).toEqual([]);
  });

  it('keeps a late domain from resuming children of a parent cancelled meanwhile', async () => {
    const first = createService();
    const parent = (await first.admit(admission())).operation;
    const child = (
      await first.admit(
        admission({
          kind: 'worker.pipeline.step',
          receipt: undefined,
          parentOperationId: parent.operationId,
        }),
      )
    ).operation;
    const service = restart(first, [domain('core.pipeline.run', 'resumable')]);
    await service.whenReconciled();
    expect(await service.get(child.operationId)).toMatchObject({
      status: 'paused',
      restart: { disposition: 'unclaimed' },
    });
    // Nothing can stop the child yet, so the cascade reaches no domain.
    await service.cancel(parent.operationId, {
      reason: 'Stop',
      requestedBy: 'local-user',
    });

    const steps = domain('worker.pipeline.step', 'resumable');
    service.registerDomain(steps);
    await service.whenReconciled();
    expect(await service.get(child.operationId)).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'Stop' },
    });
    expect(steps.recovered).toEqual([]);
  });

  it('cancels requested work its domain reports lost instead of failing it', async () => {
    const terminals = domain('worker.terminal.session', 'reattachable', {
      cancel: () => Promise.resolve('requested'),
    });
    const first = createService([terminals]);
    const { operation } = await first.admit(
      admission({ kind: 'worker.terminal.session', receipt: undefined }),
    );
    await first.cancel(operation.operationId, {
      reason: 'Stop',
      requestedBy: 'local-user',
    });
    const service = restart(first, [
      domain('worker.terminal.session', 'reattachable', {
        recover: () => Promise.resolve({ status: 'lost' }),
      }),
    ]);
    await service.whenReconciled();
    expect(await service.get(operation.operationId)).toMatchObject({
      status: 'cancelled',
      error: null,
      restart: { class: 'reattachable', disposition: 'cancelled' },
    });
  });

  it('leaves work paused and awaiting when its domain cannot find it', async () => {
    const errors: string[] = [];
    const first = createService();
    const { operation } = await first.admit(admission());
    first.close();
    const service = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(dbPath),
      onError: (_error, context): void => {
        errors.push(context);
      },
    });
    services.push(service);
    service.registerDomain(
      domain('core.pipeline.run', 'resumable', {
        recover: () => Promise.reject(new Error('state unreadable')),
      }),
    );
    await service.whenReconciled();
    expect(errors).toEqual(['recover']);
    expect(await service.get(operation.operationId)).toMatchObject({
      status: 'paused',
      restart: { disposition: 'awaiting-resume' },
    });
  });

  it('requires recovery for resumable and reattachable domains', () => {
    const service = createService();
    expect(() =>
      service.registerDomain({
        domain: 'terminal',
        kinds: ['worker.terminal.session'],
        restartClass: 'reattachable',
        cancel: () => Promise.resolve('cancelled'),
      }),
    ).toThrow(/needs recover/);
    service.registerDomain(domain('core.script.run', 'lost'));
    expect(() =>
      service.registerDomain(domain('core.script.run', 'lost')),
    ).toThrow(/claimed by both/);
  });
});
