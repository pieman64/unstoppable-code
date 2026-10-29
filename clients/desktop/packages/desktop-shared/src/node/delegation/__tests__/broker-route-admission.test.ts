/**
 * CAN-4412: a host that holds a delegate's route past its normal expiry gets
 * it withdrawn when a stop or harness revocation is accepted, before native
 * termination is confirmed. Hosts that hold nothing keep base stop timing.
 */
import type { AgentDelegationBroker } from '../broker';
import type {
  DelegationParentContext,
  ResolvedAgentRouteSnapshot,
} from '../types';
import { routeFixture } from './fixtures';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  rootParent,
  waitForLaunch,
  type BrokerHarness,
} from './broker-harness';

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Starts a spawn whose preparation is held, and returns its reserved delegation. */
async function spawnPreparing(
  broker: AgentDelegationBroker,
  resolution: ReturnType<typeof heldResolution>,
): Promise<{ readonly id: string; readonly spawned: Promise<unknown> }> {
  const spawned = broker.spawn(rootParent, baseTask);
  for (let attempt = 0; attempt < 50 && !resolution.started(); attempt++)
    await flushBroker();
  const [reserved] = broker.list(rootParent);
  if (!reserved) throw new Error('Expected a reserved delegation');
  return { id: reserved.delegationId, spawned };
}

async function spawnId(
  broker: AgentDelegationBroker,
  caller: DelegationParentContext = rootParent,
): Promise<string> {
  const result = await broker.spawn(caller, baseTask);
  if (!result.ok) throw new Error('Expected the spawn to be admitted');
  return result.value.delegationId;
}

/** Holds the runner's native stop until the returned gate opens. */
function holdNativeStop(harness: BrokerHarness): Gate {
  const held = gate();
  jest.spyOn(harness.runner, 'stop').mockImplementation(async (handle) => {
    harness.runner.stopped.push(handle.runId);
    await held.promise;
    return { stopped: true };
  });
  return held;
}

/** A route resolution that waits on a gate and exposes its preparation signal. */
function heldResolution(): {
  readonly resolveRoute: () => Promise<{
    ok: true;
    value: ResolvedAgentRouteSnapshot;
  }>;
  readonly signal: () => AbortSignal;
  readonly started: () => boolean;
  readonly open: () => void;
} {
  const held = gate();
  let captured: AbortSignal | undefined;
  return {
    resolveRoute: (
      ...args: unknown[]
    ): Promise<{ ok: true; value: ResolvedAgentRouteSnapshot }> => {
      const signal = args[2];
      if (signal instanceof AbortSignal) captured = signal;
      return held.promise.then(() => ({ ok: true, value: routeFixture() }));
    },
    signal: (): AbortSignal => {
      if (!captured) throw new Error('Expected a preparation signal');
      return captured;
    },
    started: (): boolean => captured !== undefined,
    open: held.open,
  };
}

describe('route withdrawal at stop acceptance', () => {
  it.each([
    ['a user stop', 'stop'],
    ['a harness revocation', 'revoke'],
  ] as const)(
    'releases a held route when %s is accepted, before the native stop resolves',
    async (_name, action) => {
      const releaseRoute = jest.fn();
      const harness = createBrokerHarness({
        releaseRoute,
        retainsRoute: () => true,
      });
      const { broker, runner } = harness;
      await broker.initialize();
      try {
        const id = await spawnId(broker);
        await waitForLaunch(runner, id);
        const nativeStop = holdNativeStop(harness);

        const stopping =
          action === 'stop'
            ? broker.stop(rootParent, id, 'user_cancelled')
            : broker.revokeHarness('third-harness');
        await flushBroker();
        const releasedBeforeNativeStop = releaseRoute.mock.calls.length;
        nativeStop.open();
        await stopping;

        expect(runner.stopped).toEqual([id]);
        expect(releasedBeforeNativeStop).toBe(1);
        expect(releaseRoute).toHaveBeenCalledWith(routeFixture());
        expect(broker.inspect(rootParent, id)).toMatchObject({
          status: 'cancelled',
          stopReason: action === 'stop' ? 'user_cancelled' : 'policy_revoked',
        });
      } finally {
        await broker.close();
      }
    },
  );

  it('releases a nested descendant’s held route when its ancestor’s stop is accepted', async () => {
    const releaseRoute = jest.fn();
    let resolutions = 0;
    const harness = createBrokerHarness({
      asyncAdmission: true,
      releaseRoute,
      retainsRoute: () => true,
      resolveRoute: () => {
        resolutions += 1;
        return Promise.resolve({
          ok: true,
          value: routeFixture({
            routeId: `route-${String(resolutions)}`,
            capabilities: ['read', 'progress', 'resume'],
          }),
        });
      },
    });
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const ancestor = await broker.spawn(rootParent, {
        ...baseTask,
        allowNestedDelegation: true,
      });
      if (!ancestor.ok) throw new Error('Expected the ancestor');
      await waitForLaunch(runner, ancestor.value.delegationId);
      const nested = await broker.spawn(
        {
          ...rootParent,
          harnessId: 'third-harness',
          depth: 1,
          parentDelegationId: ancestor.value.delegationId,
          parentRunGeneration: 1,
          toolCallId: 'nested',
        },
        baseTask,
      );
      if (!nested.ok) throw new Error(JSON.stringify(nested));
      const descendant = nested.value.delegationId;
      await waitForLaunch(runner, descendant);
      const nativeStop = holdNativeStop(harness);

      const stopping = broker.stop(
        rootParent,
        ancestor.value.delegationId,
        'user_cancelled',
      );
      await flushBroker();
      const releasedBeforeNativeStop = releaseRoute.mock.calls.map(
        ([route]: [ResolvedAgentRouteSnapshot]) => route.routeId,
      );
      nativeStop.open();
      await stopping;

      expect(releasedBeforeNativeStop.sort()).toEqual(['route-1', 'route-2']);
      expect(broker.inspect(rootParent, descendant)).toMatchObject({
        status: 'cancelled',
      });
    } finally {
      await broker.close();
    }
  });

  it('keeps an unheld route until the stopped run ends', async () => {
    const releaseRoute = jest.fn();
    const harness = createBrokerHarness({
      releaseRoute,
      retainsRoute: () => false,
    });
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const id = await spawnId(broker);
      await waitForLaunch(runner, id);
      const nativeStop = holdNativeStop(harness);

      const stopping = broker.stop(rootParent, id, 'user_cancelled');
      await flushBroker();
      const releasedBeforeNativeStop = releaseRoute.mock.calls.length;
      nativeStop.open();
      await stopping;

      expect(runner.stopped).toEqual([id]);
      expect(releasedBeforeNativeStop).toBe(0);
      expect(releaseRoute).toHaveBeenCalledWith(routeFixture());
    } finally {
      await broker.close();
    }
  });

  it('does not withdraw routes of another harness on revocation', async () => {
    const releaseRoute = jest.fn();
    const withdrawPreparation = jest.fn();
    const { broker, runner } = createBrokerHarness({
      releaseRoute,
      retainsRoute: () => true,
      withdrawPreparation,
    });
    await broker.initialize();
    try {
      const id = await spawnId(broker);
      await waitForLaunch(runner, id);

      await broker.revokeHarness('other-harness');

      expect(releaseRoute).not.toHaveBeenCalled();
      expect(withdrawPreparation).not.toHaveBeenCalled();
      expect(broker.inspect(rootParent, id)?.status).not.toBe('cancelled');
    } finally {
      await broker.close();
    }
  });

  it('withdraws a preparing route with its own preparation signal', async () => {
    const withdrawPreparation = jest.fn();
    const resolution = heldResolution();
    const { broker } = createBrokerHarness({
      // Reserves the record before preparing, as the desktop host does.
      asyncAdmission: true,
      resolveRoute: resolution.resolveRoute,
      withdrawPreparation,
    });
    await broker.initialize();
    try {
      const { id, spawned } = await spawnPreparing(broker, resolution);
      const signal = resolution.signal();

      const stopping = broker.stop(rootParent, id, 'user_cancelled');

      expect(withdrawPreparation).toHaveBeenCalledWith(signal);
      resolution.open();
      await Promise.all([stopping, spawned]);
      expect(signal.aborted).toBe(true);
      expect(broker.inspect(rootParent, id)).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
      });
    } finally {
      await broker.close();
    }
  });

  it('reports withdrawal errors and still completes the stop', async () => {
    const onError = jest.fn();
    const failure = new Error('route withdrawal failed');
    const harness = createBrokerHarness({
      onError,
      retainsRoute: () => true,
      // Only the withdrawal fails; the terminal release behaves as before.
      releaseRoute: jest.fn().mockImplementationOnce(() => {
        throw failure;
      }),
    });
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const id = await spawnId(broker);
      await waitForLaunch(runner, id);

      await expect(
        broker.stop(rootParent, id, 'user_cancelled'),
      ).resolves.toMatchObject({ ok: true });

      expect(onError).toHaveBeenCalledWith(failure);
      expect(broker.inspect(rootParent, id)).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
      });
    } finally {
      await broker.close();
    }
  });
});

describe('admissionCurrent', () => {
  it('is current until the harness is revoked after admission, and fails closed for unknown signals', async () => {
    const resolution = heldResolution();
    const { broker } = createBrokerHarness({
      // Reserves the record before preparing, as the desktop host does.
      asyncAdmission: true,
      resolveRoute: resolution.resolveRoute,
    });
    await broker.initialize();
    try {
      const { spawned } = await spawnPreparing(broker, resolution);
      const signal = resolution.signal();
      expect(broker.admissionCurrent(signal, 'claude')).toBe(true);
      expect(
        broker.admissionCurrent(new AbortController().signal, 'claude'),
      ).toBe(false);

      // The preparation has no harness yet, so this revocation leaves it pending.
      const revoking = broker.revokeHarness('claude');

      expect(signal.aborted).toBe(false);
      expect(broker.admissionCurrent(signal, 'claude')).toBe(false);
      expect(broker.admissionCurrent(signal, 'codex')).toBe(true);
      await revoking;
      resolution.open();
      await spawned;
    } finally {
      await broker.close();
    }
  });
});
