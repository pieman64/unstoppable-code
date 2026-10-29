import {
  DelegationDeliveryCoordinator,
  type DelegationDeliveryTransport,
} from '../delivery';
import type {
  DelegationDeliveryState,
  DelegationDeliveryReceipt,
} from '../types';

describe('exclusive terminal delivery and acceptance crash windows', () => {
  let saved: DelegationDeliveryState;
  let writes: DelegationDeliveryState[];
  let accepted: boolean;
  let coordinator: DelegationDeliveryCoordinator;
  let transport: DelegationDeliveryTransport;
  const commit = jest.fn(
    (_id: string, state: DelegationDeliveryState): Promise<void> => {
      saved = structuredClone(state);
      writes.push(saved);
      return Promise.resolve();
    },
  );

  beforeEach(() => {
    saved = { status: 'unclaimed' };
    writes = [];
    accepted = false;
    commit.mockClear();
    coordinator = new DelegationDeliveryCoordinator('terminal-child-1', {
      commit,
    });
    transport = {
      dispatch: jest.fn((deliveryId): Promise<DelegationDeliveryReceipt> => {
        expect(saved.status).toBe('dispatching');
        accepted = true;
        return Promise.resolve({
          deliveryId,
          status: 'acknowledged',
          receiptId: 'native-turn-2',
        });
      }),
      lookupReceipt: jest.fn((deliveryId) =>
        Promise.resolve(
          accepted
            ? { deliveryId, status: 'acknowledged', receiptId: 'native-turn-2' }
            : undefined,
        ),
      ),
    };
  });

  it.each(['foreground', 'background'] as const)(
    'permits one %s terminal receipt and rejects the competing channel',
    async (channel) => {
      const other = channel === 'foreground' ? 'background' : 'foreground';
      expect(
        await Promise.all([
          coordinator.claim(channel),
          coordinator.claim(other),
        ]),
      ).toEqual([true, false]);
      await Promise.all([
        coordinator.dispatch(transport),
        coordinator.dispatch(transport),
      ]);
      expect(transport.dispatch).toHaveBeenCalledTimes(1);
      expect(coordinator.snapshot()).toEqual({
        status: 'acknowledged',
        channel,
        receiptId: 'native-turn-2',
      });
      expect(writes.map((state) => state.status)).toEqual([
        'queued',
        'dispatching',
        'acknowledged',
      ]);
      const restarted = new DelegationDeliveryCoordinator(
        'terminal-child-1',
        { commit },
        saved,
      );
      await restarted.dispatch(transport);
      expect(await restarted.claim(other)).toBe(false);
      expect(transport.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('can send a durable queued result after restart because provider dispatch has not begun', async () => {
    expect(await coordinator.claim('background')).toBe(true);
    const restarted = new DelegationDeliveryCoordinator(
      'terminal-child-1',
      { commit },
      saved,
    );
    await restarted.dispatch(transport);
    expect(transport.dispatch).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe('acknowledged');
  });

  it.each([false, true])(
    'does not resend after acceptance=%s when the provider receipt was lost',
    async (nativeAccepted) => {
      await coordinator.claim('background');
      const dispatch: DelegationDeliveryTransport['dispatch'] = () => {
        accepted = nativeAccepted;
        return Promise.reject(new Error('connection lost'));
      };
      await coordinator.dispatch({ ...transport, dispatch });
      const restarted = new DelegationDeliveryCoordinator(
        'terminal-child-1',
        { commit },
        saved,
      );
      await restarted.reconcile(transport);
      await restarted.dispatch(transport);
      expect(transport.dispatch).not.toHaveBeenCalled();
      expect(saved.status).toBe(nativeAccepted ? 'acknowledged' : 'uncertain');
    },
  );

  it('recovers the native receipt if the host crashes after acceptance but before acknowledgment persistence', async () => {
    await coordinator.claim('foreground');
    const persist = async (
      id: string,
      state: DelegationDeliveryState,
    ): Promise<void> => {
      if (state.status === 'acknowledged') throw new Error('disk unavailable');
      await commit(id, state);
    };
    const failing = new DelegationDeliveryCoordinator(
      'terminal-child-1',
      { commit: persist },
      saved,
    );
    await expect(failing.dispatch(transport)).rejects.toThrow(
      'disk unavailable',
    );
    expect(saved.status).toBe('dispatching');
    const restarted = new DelegationDeliveryCoordinator(
      'terminal-child-1',
      { commit },
      saved,
    );
    await restarted.reconcile(transport);
    expect(saved.status).toBe('acknowledged');
    expect(transport.dispatch).toHaveBeenCalledTimes(1);
  });

  it('never calls the provider when the dispatch reservation cannot be persisted', async () => {
    await coordinator.claim('background');
    const failing = new DelegationDeliveryCoordinator(
      'terminal-child-1',
      {
        commit: (): Promise<void> =>
          Promise.reject(new Error('disk unavailable')),
      },
      saved,
    );
    await expect(failing.dispatch(transport)).rejects.toThrow(
      'disk unavailable',
    );
    expect(transport.dispatch).not.toHaveBeenCalled();
    expect(failing.snapshot().status).toBe('queued');
  });

  it('treats a mismatched provider receipt as uncertain and does not change channels', async () => {
    await coordinator.claim('foreground');
    await coordinator.dispatch({
      ...transport,
      dispatch: (): Promise<DelegationDeliveryReceipt> =>
        Promise.resolve({
          deliveryId: 'other-child',
          status: 'acknowledged',
          receiptId: 'other-turn',
        }),
    });
    expect(coordinator.snapshot()).toEqual({
      status: 'uncertain',
      channel: 'foreground',
    });
    expect(await coordinator.claim('background')).toBe(false);
  });

  it('suppresses a cancelled parent before dispatch without erasing accepted receipts', async () => {
    await coordinator.claim('background');
    expect(await coordinator.suppress('user_cancelled')).toBe(true);
    await coordinator.dispatch(transport);
    expect(transport.dispatch).not.toHaveBeenCalled();
    expect(saved).toEqual({ status: 'suppressed', reason: 'user_cancelled' });
    const acknowledged = new DelegationDeliveryCoordinator(
      'accepted',
      { commit },
      { status: 'acknowledged', channel: 'foreground', receiptId: 'receipt' },
    );
    expect(await acknowledged.suppress('parent_gone')).toBe(false);
  });
});
