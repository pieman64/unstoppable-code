import { ChatWaitLifecycle, type ChatWaitScope } from '../../waits';
import {
  CoreApprovalRequests,
  type ApprovalAuthorityRevisions,
  type ApprovalClientPort,
  type ApprovalDeliveryPresence,
  type ApprovalRequestHandle,
  type ApprovalResponse,
  type ApprovalRevalidation,
  type ApprovalSettlement,
  type DeliveredApprovalRequest,
  type OpenApprovalRequest,
} from '..';

const SCOPE: ChatWaitScope = {
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const OWNER = 'session-1';
const ALLOW_ONCE = { behavior: 'allow', scope: 'once' } as const;
const DENY_ONCE = { behavior: 'deny', scope: 'once' } as const;

class DeliveryPresenceDouble implements ApprovalDeliveryPresence {
  private readonly attachWaiters = new Set<() => void>();
  private readonly detachWaiters = new Set<() => void>();
  private readonly failWaiters = new Set<(error: Error) => void>();
  throws = false;

  constructor(private isAttached: boolean) {}

  attached(): boolean {
    if (this.throws) throw new Error('presence failed');
    return this.isAttached;
  }

  whenAttached(signal: AbortSignal): Promise<void> {
    if (this.throws) return Promise.reject(new Error('presence failed'));
    return this.waitFor(this.isAttached, this.attachWaiters, signal);
  }

  whenDetached(signal: AbortSignal): Promise<void> {
    if (this.throws) return Promise.reject(new Error('presence failed'));
    return this.waitFor(!this.isAttached, this.detachWaiters, signal);
  }

  attach(): void {
    this.isAttached = true;
    for (const done of Array.from(this.attachWaiters)) done();
  }

  detach(): void {
    this.isAttached = false;
    for (const done of Array.from(this.detachWaiters)) done();
  }

  /** Rejects every pending presence wait, as a broken presence source would. */
  fail(): void {
    for (const reject of Array.from(this.failWaiters)) {
      reject(new Error('presence failed'));
    }
  }

  private waitFor(
    already: boolean,
    waiters: Set<() => void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (already || signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        waiters.delete(done);
        this.failWaiters.delete(fail);
        signal.removeEventListener('abort', done);
      };
      const done = (): void => {
        cleanup();
        resolve();
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      waiters.add(done);
      this.failWaiters.add(fail);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

interface PortDouble extends ApprovalClientPort<string> {
  readonly presence: DeliveryPresenceDouble;
  readonly delivered: DeliveredApprovalRequest<string>[];
  readonly withdrawn: string[];
  currentResponder: unknown;
  throwOn: Set<'deliver' | 'withdraw' | 'accepts'>;
}

function portDouble(attached = true): PortDouble {
  const port: PortDouble = {
    presence: new DeliveryPresenceDouble(attached),
    delivered: [],
    withdrawn: [],
    currentResponder: 'A',
    throwOn: new Set(),
    deliver: (request): void => {
      if (port.throwOn.has('deliver')) throw new Error('deliver failed');
      port.delivered.push(request);
    },
    withdraw: (requestId): void => {
      if (port.throwOn.has('withdraw')) throw new Error('withdraw failed');
      port.withdrawn.push(requestId);
    },
    accepts: (responder): boolean => {
      if (port.throwOn.has('accepts')) throw new Error('accepts failed');
      return responder === port.currentResponder;
    },
  };
  return port;
}

interface RevisionDouble extends ApprovalAuthorityRevisions {
  advance(): void;
}

function revisionDouble(): RevisionDouble {
  let value = 1;
  const listeners = new Set<(revision: number) => void>();
  return {
    current: (): number => value,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    advance: (): void => {
      value += 1;
      void Promise.resolve().then(() => {
        for (const listener of Array.from(listeners)) listener(value);
      });
    },
  };
}

function attachedLifecycle(): ChatWaitLifecycle {
  return new ChatWaitLifecycle({
    presence: { attached: (): boolean => true },
  });
}

function setup(waits: ChatWaitLifecycle = attachedLifecycle()): {
  waits: ChatWaitLifecycle;
  revisions: RevisionDouble;
  broker: CoreApprovalRequests<string>;
  errors: string[];
} {
  const revisions = revisionDouble();
  const errors: string[] = [];
  let next = 0;
  const broker = new CoreApprovalRequests<string>({
    waits,
    revisions,
    newId: (): string => `req-${++next}`,
    onError: (_error, context): void => {
      errors.push(context);
    },
  });
  return { waits, revisions, broker, errors };
}

function openRequest(
  broker: CoreApprovalRequests<string>,
  port: PortDouble,
  overrides: Partial<OpenApprovalRequest<string>> = {},
): ApprovalRequestHandle {
  return broker.open({
    owner: OWNER,
    scope: SCOPE,
    presentation: (requestId): string => `card:${requestId}`,
    port,
    timeoutMs: null,
    revalidate: (): Promise<ApprovalRevalidation> => Promise.resolve('prompt'),
    ...overrides,
  });
}

function response(
  requestId: string,
  decision: ApprovalResponse['decision'],
  policyRevision: number | null,
  responder = 'A',
): ApprovalResponse {
  return {
    requestId,
    scope: SCOPE,
    responderId: responder,
    responder,
    policyRevision,
    decision,
  };
}

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

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('CoreApprovalRequests', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('an approval is one approval wait on the shared lifecycle', () => {
    const { waits, broker } = setup();
    const opened: unknown[] = [];
    waits.observe({
      opened: (wait): void => {
        opened.push(wait);
      },
      settled: (): void => undefined,
    });

    const handle = openRequest(broker, portDouble());

    expect(handle.requestId).toBe('req-1');
    expect(waits.isOpen('req-1')).toBe(true);
    expect(waits.hasOpenForSession(OWNER, 'approval')).toBe(true);
    expect(broker.hasPendingForOwner(OWNER)).toBe(true);
    expect(opened).toEqual([
      { waitId: 'req-1', kind: 'approval', scope: SCOPE, clientAttached: true },
    ]);
  });

  it('a request is owned by the broker, not by the client it was delivered to', async () => {
    const { waits, broker } = setup();
    const port = portDouble();
    const handle = openRequest(broker, port);
    expect(port.delivered).toHaveLength(1);

    port.presence.detach();
    await flush();
    port.currentResponder = 'B';
    port.presence.attach();
    await flush();

    expect(port.delivered).toHaveLength(2);
    expect(port.delivered[1]).toEqual({
      requestId: 'req-1',
      scope: SCOPE,
      policyRevision: 1,
      presentation: 'card:req-1',
    });
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1, 'A'))).toEqual({
      status: 'refused',
      reason: 'not_eligible',
    });
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1, 'B'))).toEqual({
      status: 'accepted',
    });
    await expect(handle.settled).resolves.toEqual({
      state: 'allowed',
      by: 'client',
      decision: ALLOW_ONCE,
    });
    expect(waits.isOpen('req-1')).toBe(false);
  });

  it('the first valid response wins and a late one gets conflict', async () => {
    const { broker } = setup();
    const port = portDouble();
    const handle = openRequest(broker, port);

    expect(broker.respond(response('req-1', ALLOW_ONCE, 1, 'A'))).toEqual({
      status: 'accepted',
    });
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1, 'B'))).toEqual({
      status: 'refused',
      reason: 'already_settled',
    });
    await expect(handle.settled).resolves.toMatchObject({ state: 'allowed' });
  });

  it('a duplicate of the accepted response replays as accepted', async () => {
    const { broker } = setup();
    const port = portDouble();
    const handle = openRequest(broker, port);

    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'accepted',
    });
    await handle.settled;
    await flush();

    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'replayed',
    });
    expect(broker.respond(response('req-1', DENY_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'already_settled',
    });
  });

  it('an allow with a stale revision is refused and the request stays pending', () => {
    const { waits, revisions, broker } = setup();
    const port = portDouble();
    openRequest(broker, port);

    expect(broker.respond(response('req-1', ALLOW_ONCE, 0))).toEqual({
      status: 'refused',
      reason: 'stale_revision',
    });
    expect(waits.isOpen('req-1')).toBe(true);
    expect(port.delivered).toHaveLength(2);
    expect(port.delivered[1]?.policyRevision).toBe(1);

    revisions.advance();
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'stale_revision',
    });
    expect(waits.isOpen('req-1')).toBe(true);
  });

  it('a deny is accepted at any revision and before delivery', async () => {
    const { broker } = setup();
    const port = portDouble(false);
    const handle = openRequest(broker, port);
    expect(port.delivered).toHaveLength(0);

    expect(broker.respond(response('req-1', DENY_ONCE, null))).toEqual({
      status: 'accepted',
    });
    await expect(handle.settled).resolves.toEqual({
      state: 'denied',
      by: 'client',
      decision: DENY_ONCE,
    });
  });

  it('an allow after a failed delivery is refused not_delivered', async () => {
    const { broker, errors } = setup();
    const port = portDouble();
    port.throwOn.add('deliver');
    const handle = openRequest(broker, port);

    expect(errors).toEqual(['approval delivery']);
    expect(broker.pending()).toMatchObject([{ phase: 'waiting' }]);
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'not_delivered',
    });

    port.throwOn.delete('deliver');
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'not_delivered',
    });
    expect(port.delivered).toHaveLength(1);
    expect(broker.pending()).toMatchObject([{ phase: 'delivered' }]);
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'accepted',
    });
    await expect(handle.settled).resolves.toMatchObject({ state: 'allowed' });
  });

  it('a failed delivery to a returning client is not a delivery', async () => {
    const { waits, broker } = setup();
    const port = portDouble();
    openRequest(broker, port);

    port.presence.detach();
    await flush();
    port.throwOn.add('deliver');
    port.presence.attach();
    await flush();

    expect(broker.pending()).toMatchObject([{ phase: 'waiting' }]);
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'not_delivered',
    });
    expect(waits.isOpen('req-1')).toBe(true);
  });

  it('a presence failure stops counting the request as delivered', async () => {
    const { waits, broker, errors } = setup();
    const port = portDouble();
    openRequest(broker, port);
    expect(broker.pending()).toMatchObject([{ phase: 'delivered' }]);

    port.presence.fail();
    await flush();

    expect(errors).toEqual(['approval presence']);
    expect(broker.pending()).toMatchObject([{ phase: 'waiting' }]);
    expect(broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'not_delivered',
    });
    expect(broker.respond(response('req-1', DENY_ONCE, 1))).toEqual({
      status: 'accepted',
    });
    expect(waits.isOpen('req-1')).toBe(false);
  });

  describe('a revision change revalidates the request', () => {
    it('a deny settles the request denied by policy and withdraws it', async () => {
      const { revisions, broker } = setup();
      const port = portDouble();
      const handle = openRequest(broker, port, {
        revalidate: (): Promise<ApprovalRevalidation> =>
          Promise.resolve('deny'),
      });

      revisions.advance();

      await expect(handle.settled).resolves.toEqual({
        state: 'denied',
        by: 'policy',
        reason: 'policy_denied',
      });
      await flush();
      expect(port.withdrawn).toEqual(['req-1']);
    });

    it('a prompt re-stamps the request and delivers it again', async () => {
      const { revisions, broker } = setup();
      const port = portDouble();
      const handle = openRequest(broker, port);

      revisions.advance();
      await flush();

      expect(port.delivered.map((d) => d.policyRevision)).toEqual([1, 2]);
      expect(broker.pending()).toMatchObject([
        { requestId: 'req-1', phase: 'delivered', policyRevision: 2 },
      ]);
      expect(broker.respond(response('req-1', ALLOW_ONCE, 2))).toEqual({
        status: 'accepted',
      });
      await expect(handle.settled).resolves.toMatchObject({
        state: 'allowed',
      });
    });

    it('a rejecting revalidation settles revalidation_failed', async () => {
      const { revisions, broker } = setup();
      const handle = openRequest(broker, portDouble(), {
        revalidate: (): Promise<ApprovalRevalidation> =>
          Promise.reject(new Error('policy unreadable')),
      });

      revisions.advance();

      await expect(handle.settled).resolves.toEqual({
        state: 'denied',
        by: 'policy',
        reason: 'revalidation_failed',
      });
    });

    it('while revalidating an allow is refused and a deny accepted', async () => {
      const { revisions, broker } = setup();
      const pendingResult = deferred<ApprovalRevalidation>();
      const handle = openRequest(broker, portDouble(), {
        revalidate: (): Promise<ApprovalRevalidation> => pendingResult.promise,
      });

      revisions.advance();
      await flush();

      expect(broker.pending()).toMatchObject([{ phase: 'revalidating' }]);
      expect(broker.respond(response('req-1', ALLOW_ONCE, 2))).toEqual({
        status: 'refused',
        reason: 'revalidating',
      });
      expect(broker.respond(response('req-1', DENY_ONCE, 1))).toEqual({
        status: 'accepted',
      });
      pendingResult.resolve('deny');
      await expect(handle.settled).resolves.toEqual({
        state: 'denied',
        by: 'client',
        decision: DENY_ONCE,
      });
    });
  });

  it('a request that times out settles expired', async () => {
    jest.useFakeTimers();
    const { waits, broker } = setup();
    const port = portDouble();
    const timed = openRequest(broker, port, { timeoutMs: 5000 });
    openRequest(broker, port, { timeoutMs: null });

    jest.advanceTimersByTime(5000);

    await expect(timed.settled).resolves.toEqual({ state: 'expired' });
    await flush();
    expect(port.withdrawn).toEqual(['req-1']);

    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(waits.isOpen('req-2')).toBe(true);
  });

  it('cancellation withdraws the request and ends the wait', async () => {
    const { waits, broker } = setup();
    const port = portDouble();
    const first = openRequest(broker, port);
    const second = openRequest(broker, port);
    const third = openRequest(broker, port, { owner: 'session-2' });
    waits.open({
      waitId: 'question-1',
      kind: 'question',
      scope: SCOPE,
      sessionKey: OWNER,
    });

    expect(broker.cancel('question-1', 'turn_cancelled')).toBe(false);
    expect(broker.cancel('req-1', 'turn_cancelled')).toBe(true);
    expect(broker.cancelForOwner(OWNER, 'session_destroyed')).toBe(1);
    broker.dispose();

    await expect(first.settled).resolves.toEqual({
      state: 'cancelled',
      reason: 'turn_cancelled',
    });
    await expect(second.settled).resolves.toEqual({
      state: 'cancelled',
      reason: 'session_destroyed',
    });
    await expect(third.settled).resolves.toEqual({
      state: 'cancelled',
      reason: 'broker_disposed',
    });
    await flush();
    expect(port.withdrawn).toEqual(['req-1', 'req-2', 'req-3']);
    expect(waits.isOpen('question-1')).toBe(true);
    await expect(openRequest(broker, port).settled).resolves.toEqual({
      state: 'cancelled',
      reason: 'broker_disposed',
    });
  });

  it('with no eligible client in fail mode the request fails at once and is never delivered', async () => {
    const { broker } = setup(
      new ChatWaitLifecycle({
        presence: { attached: (): boolean => false },
        noClientMode: 'fail',
      }),
    );
    const port = portDouble();

    const handle = openRequest(broker, port);

    await expect(handle.settled).resolves.toEqual({
      state: 'failed',
      reason: 'no_client',
    });
    expect(port.delivered).toHaveLength(0);
    expect(broker.pending()).toEqual([]);
  });

  it('no path other than a valid response or a host release yields allow', async () => {
    jest.useFakeTimers();
    type Row = (
      context: ReturnType<typeof setup>,
      port: PortDouble,
    ) => ApprovalRequestHandle;
    const revalidatedAs =
      (result: ApprovalRevalidation | 'throw'): Row =>
      ({ broker, revisions }, port): ApprovalRequestHandle => {
        const handle = openRequest(broker, port, {
          revalidate: (): Promise<ApprovalRevalidation> =>
            result === 'throw'
              ? Promise.reject(new Error('unreadable'))
              : Promise.resolve(result),
        });
        revisions.advance();
        return handle;
      };
    const rows: Record<string, Row> = {
      expiry: ({ broker }, port) => {
        const handle = openRequest(broker, port, { timeoutMs: 1000 });
        jest.advanceTimersByTime(1000);
        return handle;
      },
      cancel: ({ broker }, port) => {
        const handle = openRequest(broker, port);
        broker.cancel('req-1', 'turn_cancelled');
        return handle;
      },
      cancelForOwner: ({ broker }, port) => {
        const handle = openRequest(broker, port);
        broker.cancelForOwner(OWNER, 'session_destroyed');
        return handle;
      },
      dispose: ({ broker }, port) => {
        const handle = openRequest(broker, port);
        broker.dispose();
        return handle;
      },
      'revalidation deny': revalidatedAs('deny'),
      'revalidation failed': revalidatedAs('throw'),
      'revalidation allow': revalidatedAs('allow'),
      'throwing deliver': ({ broker }, port) => {
        port.throwOn.add('deliver');
        const handle = openRequest(broker, port);
        broker.respond(response('req-1', ALLOW_ONCE, 1));
        return handle;
      },
      'throwing withdraw': ({ broker }, port) => {
        port.throwOn.add('withdraw');
        const handle = openRequest(broker, port);
        broker.cancel('req-1', 'turn_cancelled');
        return handle;
      },
      'throwing accepts': ({ broker }, port) => {
        port.throwOn.add('accepts');
        const handle = openRequest(broker, port);
        broker.respond(response('req-1', ALLOW_ONCE, 1));
        return handle;
      },
      'throwing presence': ({ broker }, port) => {
        port.presence.throws = true;
        const handle = openRequest(broker, port);
        broker.respond(response('req-1', ALLOW_ONCE, 1));
        return handle;
      },
      'allow before delivery': ({ broker }, port) => {
        port.presence.detach();
        const handle = openRequest(broker, port);
        broker.respond(response('req-1', ALLOW_ONCE, 1));
        return handle;
      },
      'allow at a stale revision': ({ broker }, port) => {
        const handle = openRequest(broker, port);
        broker.respond(response('req-1', ALLOW_ONCE, 0));
        return handle;
      },
    };

    const outcomes: Record<string, string> = {};
    const settlements: ApprovalSettlement[] = [];
    for (const [name, row] of Object.entries(rows)) {
      const context = setup();
      const port = portDouble();
      const handle = row(context, port);
      await flush();
      if (context.waits.isOpen(handle.requestId)) {
        outcomes[name] = 'pending';
        context.broker.cancel(handle.requestId, 'row_finished');
      }
      const settlement = await handle.settled;
      settlements.push(settlement);
      outcomes[name] ??= settlement.state;
    }

    const failMode = setup(
      new ChatWaitLifecycle({
        presence: { attached: (): boolean => false },
        noClientMode: 'fail',
      }),
    );
    const noClient = await openRequest(failMode.broker, portDouble()).settled;
    settlements.push(noClient);
    outcomes['fail-mode no client'] = noClient.state;
    const throwingPresentation = await openRequest(
      setup().broker,
      portDouble(),
      {
        presentation: (): string => {
          throw new Error('no card');
        },
      },
    ).settled;
    settlements.push(throwingPresentation);
    outcomes['throwing presentation'] = throwingPresentation.state;

    expect(outcomes).toEqual({
      expiry: 'expired',
      cancel: 'cancelled',
      cancelForOwner: 'cancelled',
      dispose: 'cancelled',
      'revalidation deny': 'denied',
      'revalidation failed': 'denied',
      'revalidation allow': 'pending',
      'throwing deliver': 'pending',
      'throwing withdraw': 'cancelled',
      'throwing accepts': 'pending',
      'throwing presence': 'pending',
      'allow before delivery': 'pending',
      'allow at a stale revision': 'pending',
      'fail-mode no client': 'failed',
      'throwing presentation': 'failed',
    });
    expect(settlements.filter((s) => s.state === 'allowed')).toEqual([]);
  });

  it('a host release settles without withdrawing', async () => {
    const { broker } = setup();
    const port = portDouble();
    const handle = openRequest(broker, port);

    expect(broker.resolveFromHost('req-1', 'session-2', ALLOW_ONCE)).toBe(
      false,
    );
    expect(broker.resolveFromHost('req-1', OWNER, ALLOW_ONCE)).toBe(true);

    await expect(handle.settled).resolves.toEqual({
      state: 'allowed',
      by: 'host',
      decision: ALLOW_ONCE,
    });
    await flush();
    expect(port.withdrawn).toEqual([]);
  });

  it('a new broker knows no request from a previous one', async () => {
    const before = setup();
    const handle = openRequest(before.broker, portDouble());
    expect(before.broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'accepted',
    });
    await handle.settled;

    const after = setup();
    expect(after.broker.respond(response('req-1', ALLOW_ONCE, 1))).toEqual({
      status: 'refused',
      reason: 'not_found',
    });
  });
});
