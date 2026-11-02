import type { StoredDelegation } from '../broker';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  captureSettlementAnswer,
  v3SettlementRequest,
} from '../broker-settlement-contract';
import { delegationTranscriptSettlementDigest } from '../settlement-identity';
import { decodeStoredDelegationV3 } from '../record-v3';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';

class ReopenStorage extends MemoryDelegationStorage {
  loadOne(id: string): Promise<StoredDelegation | undefined> {
    const stored = this.records.get(id);
    return Promise.resolve(
      stored
        ? decodeStoredDelegationV3(JSON.parse(JSON.stringify(stored)))
        : undefined,
    );
  }
}

describe('outbox canonical reopen', () => {
  afterEach(() => jest.useRealTimers());
  it.each([
    ['intent', 'before'],
    ['intent', 'after'],
    ['locator', 'before'],
    ['locator', 'after'],
  ] as const)(
    'repairs a %s rejection %s rename with the original body and outcome',
    async (stage, cut) => {
      const storage = new ReopenStorage();
      const port = new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
        ownsChat: (): boolean => true,
      });
      const notified = jest.fn(() => Promise.resolve());
      const f = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: port,
          onSettled: notified,
        },
        storage,
      );
      await f.broker.initialize();
      const spawned = await f.broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected spawn');
      const id = spawned.value.delegationId;
      await waitForLaunch(f.runner, id);
      await f.runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 100,
        event: { type: 'started', nativeSessionId: 'outbox-reopen' },
      });
      try {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const commit = storage.commit.bind(storage);
        let faulted = false;
        let reaffirmed = false;
        jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
          if (
            !faulted &&
            record.version === 3 &&
            (stage === 'intent'
              ? record.settling
              : record.latestResult && !record.latestResult.notified)
          ) {
            faulted = true;
            if (cut === 'after') await commit(record);
            throw new Error('intent write rejected');
          }
          if (faulted && !reaffirmed) {
            expect(f.broker['receiptQuarantine'].isQuarantined(id)).toBe(true);
            reaffirmed = true;
          }
          await commit(record);
        });
        await f.runner
          .sink?.({
            delegationId: id,
            runGeneration: 1,
            sequence: 2,
            occurredAt: 200,
            event: {
              type: 'terminal',
              status: 'completed',
              finalText: 'retained original body',
            },
          })
          .catch(() => undefined);
        expect(storage.records.get(id)).toMatchObject(
          stage === 'locator' && cut === 'after'
            ? { latestResult: { runGeneration: 1, resultIndex: 1 } }
            : cut === 'after' || stage === 'locator'
              ? { settling: { runGeneration: 1 } }
              : { state: { status: 'running' } },
        );
        expect(f.broker['receiptQuarantine'].isQuarantined(id)).toBe(true);
        await jest.advanceTimersByTimeAsync(31_000);
        await flushBroker();
        expect(storage.records.get(id)).toMatchObject({
          state: { status: 'completed' },
          latestResult: { runGeneration: 1, resultIndex: 1, notified: true },
        });
        expect(reaffirmed).toBe(true);
        expect(f.broker['receiptQuarantine'].isQuarantined(id)).toBe(false);
        expect(
          await port.resultAnswerRange({
            chatId: 'chat',
            delegationId: id,
            resultIndex: 1,
            offset: 0,
            limit: 100,
          }),
        ).toMatchObject({
          ok: true,
          value: { text: 'retained original body' },
        });
        expect(notified).toHaveBeenCalledWith(
          rootParent,
          id,
          expect.objectContaining({ status: 'completed', settledAt: 200 }),
        );
        expect(f.runner.starts).toHaveLength(1);
      } finally {
        await f.broker.close();
      }
    },
  );
  it('ends a quarantined entry on a canonical digest conflict without clearing quarantine', async () => {
    const storage = new ReopenStorage();
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const errors = jest.fn();
    const notified = jest.fn(() => Promise.resolve());
    const f = createBrokerHarness(
      {
        testOnlyStreamGeneration: true,
        transcriptPort: port,
        onSettled: notified,
        onError: errors,
      },
      storage,
    );
    await f.broker.initialize();
    const spawned = await f.broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected spawn');
    const id = spawned.value.delegationId;
    await waitForLaunch(f.runner, id);
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const commit = storage.commit.bind(storage);
      let faulted = false;
      jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
        await commit(record);
        if (!faulted && record.version === 3 && record.settling) {
          faulted = true;
          throw new Error('after rename');
        }
      });
      await f.runner
        .sink?.({
          delegationId: id,
          runGeneration: 1,
          sequence: 1,
          occurredAt: 200,
          event: {
            type: 'terminal',
            status: 'completed',
            finalText: 'fenced body',
          },
        })
        .catch(() => undefined);
      const stored = storage.records.get(id);
      if (stored?.version !== 3 || !stored.settling)
        throw new Error('Expected intent');
      const competingIntent = {
        ...stored.settling,
        outcome: { ...stored.settling.outcome, finishedAt: 201 },
      };
      const conflicting = {
        ...stored,
        state: { ...stored.state, finishedAt: 201 },
        settling: {
          ...competingIntent,
          expectedSettlementDigest: delegationTranscriptSettlementDigest(
            v3SettlementRequest({
              target: stored.readMetadata.current.target,
              registration: {
                chatId: 'chat',
                delegationId: id,
                ...stored.registration,
              },
              intent: competingIntent,
              settleAnswer: captureSettlementAnswer('fenced body').settleAnswer,
            }),
          ),
        },
      };
      // A valid competing record reaches the identity fence; corrupt JSON is
      // a retryable canonical-read failure, not proof of a fence conflict.
      decodeStoredDelegationV3(JSON.parse(JSON.stringify(conflicting)));
      storage.records.set(id, conflicting);
      const load = jest.spyOn(storage, 'loadOne');
      await jest.advanceTimersByTimeAsync(31_000);
      await flushBroker();
      expect(f.broker['settlementOutbox'].size).toBe(0);
      expect(f.broker['receiptQuarantine'].isQuarantined(id)).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      expect(notified).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Settlement outbox identity conflicts with canonical record',
        }),
      );
      expect(
        await port.resultByGeneration({
          chatId: 'chat',
          delegationId: id,
          runGeneration: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(f.runner.starts).toHaveLength(1);
    } finally {
      await f.broker.close();
    }
  });
});
