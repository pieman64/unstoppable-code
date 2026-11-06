import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationService } from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  CoreDeferredToolReloads,
  type DeferredToolReloadCapture,
  type DeferredToolReloadEnabled,
  type DeferredToolReloadEvent,
  type DeferredToolReloadHost,
  type DeferredToolReloadResumeInput,
  type DeferredToolReloadScope,
  type DeferredToolReloadSettlement,
} from '..';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Payload {
  readonly items: readonly string[];
}

class FakeHost implements DeferredToolReloadHost<Payload> {
  readonly calls: string[] = [];
  readonly revalidation = deferred<string | null>();
  readonly captured = deferred<DeferredToolReloadCapture>();
  readonly enabled = deferred<DeferredToolReloadEnabled>();
  readonly resumed = deferred<void>();
  enableSignal: AbortSignal | null = null;
  resumeInput: DeferredToolReloadResumeInput | null = null;
  readonly settlements: DeferredToolReloadSettlement[] = [];

  revalidate(): Promise<string | null> {
    this.calls.push('revalidate');
    return this.revalidation.promise;
  }
  capture(): Promise<DeferredToolReloadCapture> {
    this.calls.push('capture');
    return this.captured.promise;
  }
  enable(
    _reload: unknown,
    _capture: DeferredToolReloadCapture,
    signal: AbortSignal,
  ): Promise<DeferredToolReloadEnabled> {
    this.calls.push('enable');
    this.enableSignal = signal;
    return this.enabled.promise;
  }
  resume(
    _reload: unknown,
    input: DeferredToolReloadResumeInput,
  ): Promise<void> {
    this.calls.push('resume');
    this.resumeInput = input;
    return this.resumed.promise;
  }
  settleInterruptedTurn(
    _reload: unknown,
    settlement: DeferredToolReloadSettlement,
  ): Promise<void> {
    this.calls.push('settleInterruptedTurn');
    this.settlements.push(settlement);
    return Promise.resolve();
  }
}

const scope: DeferredToolReloadScope = {
  workspaceId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
};
const otherScope: DeferredToolReloadScope = { ...scope, chatId: 'other' };
const capture: DeferredToolReloadCapture = {
  userMessageId: 'msg-1',
  sdkSessionId: 'sess-1',
};

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
}

describe('core deferred-tool reloads (CAN-4127)', () => {
  let dir: string;
  let ledgerPath: string;
  let operations: OperationService;
  let host: FakeHost;
  let timers: Array<{ callback: () => void; cancelled: boolean }>;
  let events: DeferredToolReloadEvent<Payload>[];
  let hasLiveLease: boolean | null;
  let reloads: CoreDeferredToolReloads<Payload>;

  function create(
    options: { host?: FakeHost; service?: OperationService } = {},
  ): CoreDeferredToolReloads<Payload> {
    let next = 0;
    const instance = new CoreDeferredToolReloads<Payload>({
      operations: options.service ?? operations,
      host: options.host ?? host,
      display:
        hasLiveLease === null
          ? null
          : { hasLiveLease: (): boolean => hasLiveLease === true },
      setTimer: (callback): { cancel(): void } => {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return {
          cancel: (): void => {
            timer.cancelled = true;
          },
        };
      },
      newRequestId: (): string => {
        next += 1;
        return `r${next}`;
      },
    });
    instance.subscribe((event) => events.push(event));
    return instance;
  }
  function fireTimer(): void {
    const live = timers.filter((timer) => !timer.cancelled);
    const last = live[live.length - 1];
    if (!last) throw new Error('no live timer');
    last.callback();
  }
  function lifecycles(): string[] {
    return events.map((event) =>
      event.lifecycle.kind === 'state'
        ? event.lifecycle.state
        : event.lifecycle.outcome,
    );
  }
  async function admit(
    target: DeferredToolReloadScope = scope,
  ): Promise<string> {
    const admission = await reloads.request({
      scope: target,
      toolCallId: 'tool-1',
      payload: { items: ['plugin:a'] },
      origin: { kind: 'system', sourceId: 'deferred-tools:claude' },
      owner: { kind: 'system', id: 'local' },
    });
    if (!admission.accepted) throw new Error(admission.reason);
    return admission.operationId;
  }
  async function toEnable(): Promise<string> {
    const operationId = await admit();
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-1' })).toBe(true);
    host.revalidation.resolve(null);
    await flush();
    host.captured.resolve(capture);
    await flush();
    return operationId;
  }
  async function status(operationId: string): Promise<string | undefined> {
    return (await operations.get(operationId))?.status;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reloads-'));
    ledgerPath = join(dir, 'ledger.db');
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
    });
    host = new FakeHost();
    timers = [];
    events = [];
    hasLiveLease = null;
    reloads = create();
  });
  afterEach(() => {
    operations.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drives one reload from acknowledgement to completion without a client', async () => {
    const operationId = await toEnable();
    host.enabled.resolve({ sdkSessionId: null });
    await flush();
    host.resumed.resolve();
    await flush();
    expect(lifecycles()).toEqual([
      'result_pending',
      'ui_prepared',
      'interrupting',
      'enabling',
      'resuming',
      'completed',
    ]);
    expect(host.calls).toEqual(['revalidate', 'capture', 'enable', 'resume']);
    const operation = await operations.get(operationId);
    expect(operation?.status).toBe('completed');
    expect(operation?.outcome).toEqual({
      requestId: 'r1',
      toolCallId: 'tool-1',
      display: 'unknown',
      materializationId: null,
    });
  });

  it('a second load in the same chat is refused while one is active', async () => {
    await admit();
    await expect(
      reloads.request({
        scope,
        toolCallId: 'tool-2',
        payload: { items: [] },
        origin: { kind: 'system', sourceId: 'deferred-tools:claude' },
        owner: { kind: 'system', id: 'local' },
      }),
    ).resolves.toEqual({ accepted: false, reason: 'reload_in_progress' });
    await expect(admit(otherScope)).resolves.toEqual(expect.any(String));
  });

  it('a second acknowledgement is refused and starts nothing', async () => {
    await admit();
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-1' })).toBe(true);
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-1' })).toBe(false);
    await flush();
    expect(host.calls).toEqual(['revalidate']);
  });

  it('an acknowledgement for another tool call is refused', async () => {
    await admit();
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-9' })).toBe(false);
    expect(reloads.active(scope)?.state).toBe('result_pending');
    expect(reloads.active(scope)?.acknowledged).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('an acknowledgement by request id works once', async () => {
    await admit();
    expect(reloads.acknowledge({ scope, requestId: 'r9' })).toBe(false);
    expect(reloads.acknowledge({ scope, requestId: 'r1' })).toBe(true);
    expect(reloads.acknowledge({ scope, requestId: 'r1' })).toBe(false);
  });

  it('an acknowledgement after settlement is refused', async () => {
    await toEnable();
    host.enabled.resolve({ sdkSessionId: null });
    await flush();
    host.resumed.resolve();
    await flush();
    expect(reloads.active(scope)).toBeNull();
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-1' })).toBe(false);
    expect(reloads.acknowledge({ scope, requestId: 'r1' })).toBe(false);
  });

  it('no stage waits for a display', async () => {
    for (const live of [false, true]) {
      hasLiveLease = live;
      operations.close();
      const path = join(dir, `${String(live)}.db`);
      operations = new OperationService({
        openLedger: (): OperationLedger => OperationLedger.open(path),
      });
      host = new FakeHost();
      reloads = create();
      const operationId = await toEnable();
      host.enabled.resolve({ sdkSessionId: null });
      await flush();
      host.resumed.resolve();
      await flush();
      const operation = await operations.get(operationId);
      expect(operation?.status).toBe('completed');
      expect(operation?.outcome).toMatchObject({
        display: live ? 'live' : 'headless',
      });
    }
  });

  it('a catalog item that disappeared fails the reload once as enable_failed', async () => {
    const operationId = await admit();
    reloads.acknowledge({ scope, toolCallId: 'tool-1' });
    host.revalidation.resolve('skill x: missing');
    await flush();
    const failures = events.filter((event) => event.error);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error?.outcome).toBe('enable_failed');
    expect(failures[0]?.error?.message.endsWith('skill x: missing')).toBe(true);
    expect(host.calls).toEqual(['revalidate']);
    const operation = await operations.get(operationId);
    expect(operation?.status).toBe('failed');
    expect(operation?.error?.code).toBe(
      'core.agent.deferredTools.enableFailed',
    );
  });

  it('a reload cancelled during validation never enables', async () => {
    await admit();
    reloads.acknowledge({ scope, toolCallId: 'tool-1' });
    expect(reloads.cancel(scope, 'stop')).toBe(true);
    host.revalidation.resolve(null);
    await flush();
    expect(lifecycles()).toEqual(['result_pending', 'cancelled']);
    expect(host.calls).toEqual(['revalidate']);
  });

  it('cancel during enable aborts the host and settles cancelled once', async () => {
    await toEnable();
    expect(host.enableSignal?.aborted).toBe(false);
    expect(reloads.cancel(scope, 'stop')).toBe(true);
    expect(reloads.cancel(scope, 'stop')).toBe(false);
    expect(host.enableSignal?.aborted).toBe(true);
    host.enabled.resolve({ sdkSessionId: null });
    await flush();
    expect(lifecycles().filter((value) => value === 'cancelled')).toHaveLength(
      1,
    );
    expect(lifecycles()[lifecycles().length - 1]).toBe('cancelled');
    expect(host.calls).not.toContain('resume');
    expect(host.settlements).toEqual([
      { outcome: 'cancelled', message: 'stop', userMessageId: 'msg-1' },
    ]);
  });

  it('a resume failure settles the interrupted turn once', async () => {
    const operationId = await toEnable();
    host.enabled.resolve({ sdkSessionId: null });
    await flush();
    host.resumed.reject(new Error('boom'));
    await flush();
    const failures = events.filter((event) => event.error);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toEqual({
      outcome: 'resume_failed',
      message: 'boom',
    });
    expect(host.settlements).toEqual([
      { outcome: 'resume_failed', message: 'boom', userMessageId: 'msg-1' },
    ]);
    const operation = await operations.get(operationId);
    expect(operation?.status).toBe('failed');
    expect(operation?.error?.code).toBe(
      'core.agent.deferredTools.resumeFailed',
    );
  });

  it('a missing interrupted turn fails resume', async () => {
    await admit();
    reloads.acknowledge({ scope, toolCallId: 'tool-1' });
    host.revalidation.resolve(null);
    await flush();
    host.captured.resolve({ userMessageId: null, sdkSessionId: null });
    await flush();
    host.enabled.resolve({ sdkSessionId: null });
    await flush();
    expect(host.calls.filter((call) => call === 'enable')).toHaveLength(1);
    expect(host.calls).not.toContain('resume');
    const failures = events.filter((event) => event.error);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toEqual({
      outcome: 'resume_failed',
      message: 'The interrupted turn could not be found.',
    });
  });

  it('an unacknowledged reload expires after the delivery bound', async () => {
    const operationId = await admit();
    fireTimer();
    await flush();
    expect(lifecycles()).toEqual(['enable_failed']);
    const operation = await operations.get(operationId);
    expect(operation?.status).toBe('failed');
    expect(operation?.error?.code).toBe(
      'core.agent.deferredTools.notAcknowledged',
    );
    expect(host.calls).toEqual([]);
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-1' })).toBe(false);
  });

  it('core.operation.cancel cancels the reload', async () => {
    const operationId = await toEnable();
    await operations.cancel(operationId, { reason: 'x', requestedBy: 'test' });
    await flush();
    expect(lifecycles().filter((value) => value === 'cancelled')).toHaveLength(
      1,
    );
    expect(await status(operationId)).toBe('cancelled');
  });

  it('an unfinished reload is lost after a restart and never replays', async () => {
    const operationId = await admit();
    reloads.acknowledge({ scope, toolCallId: 'tool-1' });
    await flush();
    operations.close();
    const restarted = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
    });
    const secondHost = new FakeHost();
    create({ host: secondHost, service: restarted });
    await restarted.whenReconciled();
    expect(await restarted.get(operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'core.operation.interrupted' },
      restart: { class: 'lost', disposition: 'lost' },
    });
    expect(secondHost.calls).toEqual([]);
    restarted.close();
  });

  it('settle callbacks run once, after the reload is cleared', async () => {
    await toEnable();
    const seen: Array<unknown> = [];
    expect(
      reloads.whenSettled(scope, () => seen.push(reloads.active(scope))),
    ).toBe(true);
    reloads.cancel(scope, 'stop');
    reloads.cancel(scope, 'stop');
    host.enabled.resolve({ sdkSessionId: null });
    await flush();
    expect(seen).toEqual([null]);
    expect(reloads.whenSettled(scope, () => undefined)).toBe(false);
  });

  it('a settle waiter registered during a failed admission runs once', async () => {
    const admission = deferred<never>();
    jest.spyOn(operations, 'admit').mockReturnValueOnce(admission.promise);
    const pending = reloads.request({
      scope,
      toolCallId: 'tool-1',
      payload: { items: [] },
      origin: { kind: 'system', sourceId: 'deferred-tools:claude' },
      owner: { kind: 'system', id: 'local' },
    });
    let calls = 0;
    expect(
      reloads.whenSettled(scope, () => {
        calls += 1;
      }),
    ).toBe(true);
    admission.reject(new Error('ledger unavailable'));
    await expect(pending).resolves.toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    expect(calls).toBe(1);
    expect(reloads.active(scope)).toBeNull();
  });

  it('a listener that cancels during a stage stops that stage event', async () => {
    operations.close();
    const path = join(dir, 'reentrant.db');
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(path),
    });
    const instance = new CoreDeferredToolReloads<Payload>({
      operations,
      host,
      setTimer: (): { cancel(): void } => ({ cancel: (): void => undefined }),
      newRequestId: (): string => 'r1',
    });
    instance.subscribe((event) => {
      if (
        event.lifecycle.kind === 'state' &&
        event.lifecycle.state === 'enabling'
      )
        instance.cancel(scope, 'stop');
    });
    const seen: string[] = [];
    instance.subscribe((event) =>
      seen.push(
        event.lifecycle.kind === 'state'
          ? event.lifecycle.state
          : event.lifecycle.outcome,
      ),
    );
    await instance.request({
      scope,
      toolCallId: 'tool-1',
      payload: { items: [] },
      origin: { kind: 'system', sourceId: 'deferred-tools:claude' },
      owner: { kind: 'system', id: 'local' },
    });
    instance.acknowledge({ scope, toolCallId: 'tool-1' });
    host.revalidation.resolve(null);
    await flush();
    host.captured.resolve(capture);
    await flush();
    expect(seen).toEqual([
      'result_pending',
      'ui_prepared',
      'interrupting',
      'cancelled',
    ]);
    expect(instance.active(scope)).toBeNull();
    expect(host.calls).not.toContain('enable');
  });

  it('a reload cancelled by its acknowledgement listener never validates', async () => {
    await admit();
    const unsubscribe = reloads.subscribe((event) => {
      if (event.lifecycle.kind === 'state') reloads.cancel(scope, 'stop');
    });
    expect(reloads.acknowledge({ scope, toolCallId: 'tool-1' })).toBe(true);
    unsubscribe();
    await flush();
    expect(lifecycles()).toEqual(['result_pending', 'cancelled']);
    expect(host.calls).toEqual([]);
  });
});
