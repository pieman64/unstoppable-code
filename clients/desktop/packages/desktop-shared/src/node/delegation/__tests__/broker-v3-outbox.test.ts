import type { StoredDelegationV3 } from '../record-v3';
import { canonicalDelegationJson } from '../settlement-identity';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { materializeCardDraft } from '../card-publication';
import { captureSettlementAnswer } from '../broker-settlement-contract';
import type {
  AgentDelegationBroker,
  AgentDelegationBrokerOptions,
} from '../broker';
import { routeFixture, type FakeRunner } from './fixtures';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';

async function fixture(
  options: Partial<AgentDelegationBrokerOptions> = {},
): Promise<{
  broker: AgentDelegationBroker;
  runner: FakeRunner;
  storage: MemoryDelegationStorage;
  port: InMemoryDelegationTranscriptPort;
  id: string;
}> {
  const storage = new MemoryDelegationStorage();
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
  const harness = createBrokerHarness(
    {
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
      ...options,
    },
    storage,
  );
  await harness.broker.initialize();
  const spawned = await harness.broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected spawn');
  const id = spawned.value.delegationId;
  await waitForLaunch(harness.runner, id);
  await harness.runner.sink?.({
    delegationId: id,
    runGeneration: 1,
    sequence: 1,
    occurredAt: 100,
    event: { type: 'started', nativeSessionId: 'native-outbox' },
  });
  return { ...harness, storage, port, id };
}

async function retry(): Promise<void> {
  await jest.advanceTimersByTimeAsync(31_000);
  await flushBroker();
}

function record(
  storage: MemoryDelegationStorage,
  id: string,
): StoredDelegationV3 {
  const value = storage.records.get(id);
  if (value?.version !== 3) throw new Error('Expected v3');
  return value;
}

describe('v3 same-process settlement outbox', () => {
  afterEach(() => jest.useRealTimers());

  it.each([undefined, '', 'exact answer \u{1f333}'.repeat(400)])(
    'retains exact answer case %# through failed settle without an event',
    async (text) => {
      const notified = jest.fn(() => Promise.resolve());
      const f = await fixture({ onSettled: notified });
      try {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const settle = jest.spyOn(f.port, 'settle');
        settle.mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'artifact unavailable',
            retryable: true,
          },
        });
        await f.runner
          .sink?.({
            delegationId: f.id,
            runGeneration: 1,
            sequence: 2,
            occurredAt: 200,
            event: {
              type: 'terminal',
              status: 'completed',
              ...(text === undefined ? {} : { finalText: text }),
            },
          })
          .catch(() => undefined);
        expect(record(f.storage, f.id).settling).toBeDefined();
        await retry();
        expect(record(f.storage, f.id).latestResult).toMatchObject({
          runGeneration: 1,
          resultIndex: 1,
          status: 'completed',
          notified: true,
        });
        expect(settle.mock.calls[1]?.[0].answer).toEqual(
          captureSettlementAnswer(text).settleAnswer,
        );
        const result = await f.port.result({
          chatId: 'chat',
          delegationId: f.id,
          resultIndex: 1,
        });
        expect(result).toMatchObject({
          ok: true,
          value: {
            outcome: { status: 'completed', finishedAt: 200 },
            answer:
              text === undefined
                ? { kind: 'none' }
                : text === ''
                  ? { kind: 'empty', role: 'final' }
                  : { kind: 'body', role: 'final' },
          },
        });
        if (text) {
          const body = await f.port.resultAnswerRange({
            chatId: 'chat',
            delegationId: f.id,
            resultIndex: 1,
            offset: 0,
            limit: 16_384,
          });
          expect(body).toMatchObject({ ok: true, value: { text } });
        }
        await f.broker.flushCardPublication({
          kind: 'delegation',
          chatId: 'chat',
          delegationId: f.id,
          runGeneration: 1,
        });
        const descriptor = await f.port.generation({
          chatId: 'chat',
          delegationId: f.id,
          runGeneration: 1,
        });
        expect(descriptor).toMatchObject({
          ok: true,
          value: {
            stream: {
              cardState: {
                ...materializeCardDraft(record(f.storage, f.id)),
                cardRevision: record(f.storage, f.id).cardPublication
                  ?.cardRevision,
              },
            },
          },
        });
        expect(notified).toHaveBeenCalledTimes(1);
        expect(f.runner.starts).toHaveLength(1);
      } finally {
        await f.broker.close();
      }
    },
  );

  it('retries notify from the durable locator without another settle or runner', async () => {
    const notified = jest
      .fn<
        ReturnType<NonNullable<AgentDelegationBrokerOptions['onSettled']>>,
        Parameters<NonNullable<AgentDelegationBrokerOptions['onSettled']>>
      >()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(undefined);
    const f = await fixture({ onSettled: notified });
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const settle = jest.spyOn(f.port, 'settle');
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'notify body',
        },
      });
      expect(record(f.storage, f.id).latestResult?.notified).not.toBe(true);
      await retry();
      expect(notified).toHaveBeenCalledTimes(2);
      expect(notified.mock.calls[1]?.[2]).toMatchObject({
        runGeneration: 1,
        resultIndex: 1,
        status: 'completed',
        settledAt: 200,
      });
      expect(record(f.storage, f.id).latestResult?.notified).toBe(true);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(f.runner.starts).toHaveLength(1);
    } finally {
      await f.broker.close();
    }
  });
  it('keeps an unnotified generation current across a refused continuation and restart', async () => {
    const notified = jest.fn(() =>
      Promise.reject(new Error('held notification')),
    );
    const f = await fixture({ onSettled: notified });
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'generation one',
        },
      });
      await flushBroker();
      const continuation = f.broker.manage(
        { ...rootParent, toolCallId: 'next' },
        {
          delegationId: f.id,
          operation: 'follow_up',
          message: 'generation two',
        },
      );
      await flushBroker();
      await jest.advanceTimersByTimeAsync(31_000);
      const reply = await continuation;
      expect(reply.ok).toBe(true);
      expect(record(f.storage, f.id).control).toMatchObject({
        status: 'failed',
      });
      expect(record(f.storage, f.id)).toMatchObject({
        state: { runGeneration: 1 },
        latestResult: { runGeneration: 1, resultIndex: 1 },
      });
      await f.broker.close();
      const recoveredNotify = jest.fn(() => Promise.resolve());
      reopened = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: f.port,
          onSettled: recoveredNotify,
        },
        f.storage,
      );
      await reopened.broker.initialize();
      expect(recoveredNotify).toHaveBeenCalledWith(
        expect.anything(),
        f.id,
        expect.objectContaining({
          runGeneration: 1,
          resultIndex: 1,
          status: 'completed',
        }),
      );
      expect(reopened.runner.starts).toHaveLength(0);
    } finally {
      await f.broker.close();
      await reopened?.broker.close();
    }
  });

  it('turns failed startup re-notification into a notify-only retry', async () => {
    const f = await fixture({
      onSettled: () => Promise.reject(new Error('offline')),
    });
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'startup body',
        },
      });
      await f.broker.close();
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const notified = jest
        .fn()
        .mockRejectedValueOnce(new Error('startup host failure'))
        .mockResolvedValue(undefined);
      reopened = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: f.port,
          onSettled: notified,
        },
        f.storage,
      );
      const settle = jest.spyOn(f.port, 'settle');
      await reopened.broker.initialize().catch(() => undefined);
      await retry();
      expect(record(f.storage, f.id).latestResult?.notified).toBe(true);
      expect(notified).toHaveBeenCalledTimes(2);
      expect(settle).not.toHaveBeenCalled();
      expect(
        await f.port.resultAnswerRange({
          chatId: 'chat',
          delegationId: f.id,
          resultIndex: 1,
          offset: 0,
          limit: 100,
        }),
      ).toMatchObject({ ok: true, value: { text: 'startup body' } });
      expect(reopened.runner.starts).toHaveLength(0);
    } finally {
      await f.broker.close();
      await reopened?.broker.close();
    }
  });

  it('rechecks the latest pair inside admission after a barrier-to-admission advance', async () => {
    const f = await fixture();
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'race body',
        },
      });
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: f.id,
        runGeneration: 1,
      };
      await f.broker.flushCardPublication(target);
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const flush = f.broker['cardPublications'].flush.bind(
        f.broker['cardPublications'],
      );
      let advanced = false;
      jest
        .spyOn(f.broker['cardPublications'], 'flush')
        .mockImplementation(async (target, revision) => {
          await flush(target, revision);
          if (!advanced) {
            advanced = true;
            jest.spyOn(f.port, 'updateCardState').mockResolvedValue({
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'paused publication',
                retryable: true,
              },
            });
            await f.broker['update'](f.id, (current) => ({
              ...current,
              workspaceDiscarded: true,
            }));
          }
        });
      const managed = f.broker.manage(
        { ...rootParent, toolCallId: 'racing-continuation' },
        { delegationId: f.id, operation: 'follow_up', message: 'next race' },
      );
      await flushBroker();
      await jest.advanceTimersByTimeAsync(31_000);
      await managed;
      expect(record(f.storage, f.id)).toMatchObject({
        state: { runGeneration: 1 },
        cardPublication: { draft: { workspaceDiscarded: true } },
      });
      const pair = record(f.storage, f.id).cardPublication;
      await f.broker.close();
      jest.restoreAllMocks();
      reopened = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: f.port },
        f.storage,
      );
      await reopened.broker.initialize();
      await reopened.broker.flushCardPublication(target);
      expect(await f.port.generation(target)).toMatchObject({
        ok: true,
        value: {
          stream: {
            cardState: {
              cardRevision: pair?.cardRevision,
              workspaceDiscarded: true,
              canonical: { status: 'completed' },
            },
          },
        },
      });
      expect(
        await f.port.resultAnswerRange({
          chatId: 'chat',
          delegationId: f.id,
          resultIndex: 1,
          offset: 0,
          limit: 100,
        }),
      ).toMatchObject({ ok: true, value: { text: 'race body' } });
      expect(reopened.runner.starts).toHaveLength(0);
    } finally {
      jest.restoreAllMocks();
      await f.broker.close();
      await reopened?.broker.close();
    }
  });
  it('lets a stop win between v3 acceptance and post-lease materialization without changing its receipt', async () => {
    const f = await fixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let managed: ReturnType<typeof f.broker.manage> | undefined;
    try {
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'stop window body',
        },
      });
      await flushBroker();
      const flush = f.broker['cardPublications'].flush.bind(
        f.broker['cardPublications'],
      );
      jest
        .spyOn(f.broker['cardPublications'], 'flush')
        .mockImplementation(async (target, revision) => {
          await gate;
          await flush(target, revision);
        });
      managed = f.broker.manage(
        { ...rootParent, toolCallId: 'window-followup' },
        {
          delegationId: f.id,
          operation: 'follow_up',
          message: 'must not launch',
        },
      );
      await flushBroker();
      const accepted = record(f.storage, f.id).receipts.commandReceipts.find(
        (entry) => entry.operation === 'follow_up',
      );
      if (!accepted) throw new Error('Expected accepted acknowledgement');
      expect(accepted.reply.final).toBeNull();
      const bytes = canonicalDelegationJson(accepted.reply.ack);
      expect(record(f.storage, f.id).control?.status).toBe('accepted');
      const stop = await f.broker.requestStop(
        { ...rootParent, toolCallId: 'window-stop' },
        f.id,
      );
      expect(stop.ok).toBe(true);
      release();
      const reply = await managed;
      expect(reply.ok).toBe(true);
      expect(record(f.storage, f.id)).toMatchObject({
        state: { runGeneration: 1 },
        control: { status: 'failed' },
      });
      const completed = record(f.storage, f.id).receipts.commandReceipts.find(
        (entry) => entry.key === accepted.key,
      );
      if (!completed) throw new Error('Expected completed receipt');
      expect(canonicalDelegationJson(completed.reply.ack)).toBe(bytes);
      expect(completed.reply.final).toMatchObject({
        status: 'failed',
        error: { code: 'runtime_error', retryable: false },
      });
      expect(f.runner.starts).toHaveLength(1);
      expect(
        await f.port.resultAnswerRange({
          chatId: 'chat',
          delegationId: f.id,
          resultIndex: 1,
          offset: 0,
          limit: 100,
        }),
      ).toMatchObject({ ok: true, value: { text: 'stop window body' } });
    } finally {
      release();
      await managed;
      jest.restoreAllMocks();
      await f.broker.close();
    }
  });
});
