import { createHash, randomUUID } from 'node:crypto';
import { routeFixture } from './fixtures';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  fitDelegationReceiptAck,
  projectDelegationCommandReplay,
  completeDelegationCommandReceipt,
  fitDelegationReceiptFinal,
  fitDelegationStopReceipt,
  fitDelegationStopOutcomeReceipt,
  type DelegationReceiptAckInput,
  type DelegationReceiptFinalInput,
} from '../receipt-reply';
import { delegationReceiptAckToResult } from '../broker-settlement';
import type { DelegationTranscriptPortErrorCode } from '../transcript-port';
import type { AgentDelegationBrokerOptions } from '../broker';
import {
  decodeStoredDelegationV3,
  delegationStopRequestHash,
  type V3CommandReceiptEntry,
} from '../record-v3';
import {
  type BrokerHarness,
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
  flushBroker,
} from './broker-harness';

function keyFor(call: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        rootParent.harnessId,
        rootParent.projectId,
        rootParent.worktreeId,
        rootParent.chatId,
        rootParent.turnId,
        call,
        rootParent.parentDelegationId,
        rootParent.parentRunGeneration,
      ]),
    )
    .digest('hex');
}

const hashFor = (input: unknown): string =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

interface Fixture extends BrokerHarness {
  readonly port: InMemoryDelegationTranscriptPort;
  readonly storage: MemoryDelegationStorage;
  readonly id: string;
  readonly options: Partial<AgentDelegationBrokerOptions>;
}

function restartFixture(current: Fixture): Fixture {
  return {
    ...current,
    ...createBrokerHarness(current.options, current.storage),
    storage: current.storage,
  };
}

async function fixture(
  overrides: Partial<AgentDelegationBrokerOptions> = {},
): Promise<Fixture> {
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
  const storage = new MemoryDelegationStorage();
  const errors: unknown[] = [];
  const options = {
    testOnlyStreamGeneration: true,
    transcriptPort: port,
    ...overrides,
    onError: (error: unknown): void => {
      errors.push(error);
    },
  };
  const harness = createBrokerHarness(options, storage);
  await harness.broker.initialize();
  const spawned = await harness.broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected stream child');
  try {
    await waitForLaunch(harness.runner, spawned.value.delegationId);
  } catch {
    throw new Error(
      errors
        .map((error) => (error instanceof Error ? error.stack : String(error)))
        .join('\n'),
    );
  }
  return { ...harness, port, storage, options, id: spawned.value.delegationId };
}

function userKey(operationId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'managed-delegation-user-message',
        rootParent.projectId,
        rootParent.worktreeId,
        rootParent.chatId,
        operationId,
      ]),
    )
    .digest('hex');
}

function commandEntry(
  id: string,
  key: string,
  hash: string,
  scenario: string,
): V3CommandReceiptEntry {
  const operationId = randomUUID();
  const ack: DelegationReceiptAckInput =
    scenario === 'terminal error'
      ? {
          ok: false,
          error: {
            code: 'policy_blocked',
            message: 'immutable first failure',
            retryable: false,
          },
        }
      : {
          ok: true,
          outcome: scenario.startsWith('accepted') ? 'accepted' : 'completed',
          snapshot: {
            delegationId: id,
            status: 'running',
            outputTruncated: false,
            ...(scenario === 'minimal'
              ? {}
              : {
                  control: {
                    operationId,
                    operation: 'steer',
                    status: scenario.startsWith('accepted')
                      ? 'accepted'
                      : 'completed',
                  },
                }),
          },
        };
  let fitted = fitDelegationReceiptAck(
    {
      chatId: rootParent.chatId,
      delegationId: id,
      receiptKind: 'command',
      key,
      requestHash: hash,
      operationId,
      operation: 'steer',
      runGeneration: 1,
      admittedAt: 1,
    },
    ack,
  );
  if (!fitted.ok) throw new Error('Could not fit command fixture');
  if (scenario.startsWith('accepted')) {
    const resolved: DelegationReceiptFinalInput =
      scenario === 'accepted completed'
        ? { status: 'completed' as const }
        : {
            status: 'failed' as const,
            error: {
              code:
                scenario === 'accepted apply_failed'
                  ? ('apply_failed' as const)
                  : ('runtime_error' as const),
              message: 'resolved failure',
              retryable: false,
              ...(scenario === 'accepted apply_failed'
                ? {
                    apply: {
                      reason: 'conflict',
                      guidance: 'resolve the conflict',
                      issues: [],
                      omittedIssues: 3,
                    },
                  }
                : {}),
            },
          };
    fitted = completeDelegationCommandReceipt(
      fitted.entry,
      fitDelegationReceiptFinal(resolved),
    );
  }
  if (
    !fitted.ok ||
    fitted.entry.receiptKind !== 'command' ||
    fitted.entry.reply.kind !== 'command'
  )
    throw new Error('Invalid command fixture');
  return { ...fitted.entry, receiptKind: 'command', reply: fitted.entry.reply };
}

describe('v3 chat-wide receipt lookup admission', () => {
  afterEach(() => jest.restoreAllMocks());

  const errors: DelegationTranscriptPortErrorCode[] = [
    'unauthorized',
    'corruption',
    'storage_failure',
    'conflict',
  ];
  it.each(
    ([...errors, 'throw'] as const).flatMap((code) =>
      [false, true].map((restart) => ({ code, restart })),
    ),
  )(
    'does not admit a registry $code and permits a healthy retry (restart=$restart)',
    async ({ code, restart }) => {
      let f = await fixture();
      if (restart) {
        await f.broker.close();
        f = restartFixture(f);
        await f.broker.initialize();
      }
      try {
        const input = { delegationId: f.id, operation: 'apply' };
        const parent = { ...rootParent, toolCallId: `lookup-${code}` };
        const commit = jest.spyOn(f.storage, 'commit');
        const lookup = jest.spyOn(f.port, 'receipt');
        if (code === 'throw')
          lookup.mockRejectedValueOnce(new Error('offline'));
        else
          lookup.mockResolvedValueOnce({
            ok: false,
            error: { code, message: 'lookup refused', retryable: true },
          });
        const before = JSON.stringify(f.storage.records.get(f.id));
        const result = await f.broker.manage(parent, input);
        expect(result).toMatchObject({ ok: false, error: { retryable: true } });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(JSON.stringify(f.storage.records.get(f.id))).toBe(before);
        expect(f.runner.steeringRequests).toHaveLength(0);
        expect(f.runner.stopped).toHaveLength(0);
        await f.broker.manage(parent, input);
        expect(lookup).toHaveBeenCalledTimes(2);
        const record = f.storage.records.get(f.id);
        if (record?.version !== 3) throw new Error('Expected stream record');
        expect(record.receipts.commandReceipts).toHaveLength(1);
      } finally {
        await f.broker.close();
      }
    },
  );

  it.each([false, true])(
    'never reads the registry for an unauthorized foreign target (restart=%s)',
    async (restart) => {
      let f = await fixture();
      if (restart) {
        await f.broker.close();
        f = restartFixture(f);
        await f.broker.initialize();
      }
      try {
        const lookup = jest.spyOn(f.port, 'receipt');
        const commit = jest.spyOn(f.storage, 'commit');
        const result = await f.broker.manage(
          { ...rootParent, chatId: 'foreign' },
          { delegationId: f.id, operation: 'apply' },
        );
        expect(result.ok).toBe(false);
        expect(lookup).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
      } finally {
        await f.broker.close();
      }
    },
  );

  it.each([false, true])(
    'replays a seeded registry command with B2 (restart=%s)',
    async (restart) => {
      const f = await fixture();
      let active = f;
      try {
        const input = { delegationId: f.id, operation: 'apply' };
        const call = 'seeded-agent';
        const fitted = fitDelegationReceiptAck(
          {
            chatId: rootParent.chatId,
            delegationId: f.id,
            receiptKind: 'command',
            key: keyFor(call),
            requestHash: hashFor(input),
            operationId: randomUUID(),
            operation: 'apply',
            runGeneration: 1,
            admittedAt: 1,
          },
          {
            ok: false,
            error: {
              code: 'policy_blocked',
              message: 'first failure',
              retryable: false,
            },
          },
        );
        if (!fitted.ok || fitted.entry.reply.kind !== 'command')
          throw new Error('Expected fitted receipt');
        expect((await f.port.appendReceipt(fitted.entry)).ok).toBe(true);
        if (restart) {
          await f.broker.close();
          active = restartFixture(f);
          await active.broker.initialize();
        }
        const commit = jest.spyOn(f.storage, 'commit');
        const replay = await active.broker.manage(
          { ...rootParent, toolCallId: call },
          input,
        );
        expect(replay).toEqual(
          delegationReceiptAckToResult(
            projectDelegationCommandReplay(fitted.entry.reply, 'agent'),
          ),
        );
        expect(commit).not.toHaveBeenCalled();
        const mismatch = await active.broker.manage(
          { ...rootParent, toolCallId: call },
          { ...input, message: 'changed' },
        );
        expect(mismatch).toMatchObject({
          ok: false,
          error: { code: 'invalid_request' },
        });
        expect(commit).not.toHaveBeenCalled();
      } finally {
        await active.broker.close();
      }
    },
  );
  const scenarios = [
    'terminal error',
    'terminal success',
    'accepted completed',
    'accepted apply_failed',
    'accepted generic failure',
    'minimal',
  ];
  const matrix = scenarios.flatMap((scenario) =>
    ['user', 'agent'].flatMap((origin) =>
      ['window', 'registry'].flatMap((tier) =>
        [false, true].map((restart) => ({ scenario, origin, tier, restart })),
      ),
    ),
  );
  it.each(matrix)(
    'B2 $scenario, $origin, $tier, restart=$restart',
    async ({ scenario, origin, tier, restart }) => {
      const f = await fixture();
      let active = f;
      try {
        const operationId = randomUUID();
        const parent = {
          ...rootParent,
          toolCallId: operationId,
          ...(origin === 'user' ? { controlAuthor: 'user' as const } : {}),
        };
        const input = {
          delegationId: f.id,
          operation: 'steer',
          message: 'original',
        };
        const key =
          origin === 'user' ? userKey(operationId) : keyFor(operationId);
        const entry = commandEntry(f.id, key, hashFor(input), scenario);
        if (tier === 'registry')
          expect((await f.port.appendReceipt(entry)).ok).toBe(true);
        else
          await f.broker['update'](f.id, (record) => {
            if (record.version !== 3) throw new Error('Expected stream');
            return {
              ...record,
              receipts: { ...record.receipts, commandReceipts: [entry] },
            };
          });
        if (restart) {
          await f.broker.close();
          active = restartFixture(f);
          await active.broker.initialize();
        }
        const commit = jest.spyOn(f.storage, 'commit');
        const append = jest.spyOn(f.port, 'appendReceipt');
        const lookup = jest.spyOn(f.port, 'receipt');
        const before = JSON.stringify(entry);
        const result = await active.broker.message(
          parent,
          input,
          origin === 'user' ? operationId : undefined,
        );
        expect(result).toEqual(
          delegationReceiptAckToResult(
            projectDelegationCommandReplay(
              entry.reply,
              origin === 'user' ? 'user' : 'agent',
            ),
          ),
        );
        expect(JSON.stringify(entry)).toBe(before);
        expect(commit).not.toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
        expect(active.runner.steeringRequests).toHaveLength(0);
        expect(active.runner.stopped).toHaveLength(0);
        expect(lookup).toHaveBeenCalledTimes(tier === 'window' ? 0 : 1);
        const changed = await active.broker.message(
          parent,
          { ...input, message: 'changed' },
          origin === 'user' ? operationId : undefined,
        );
        expect(changed).toMatchObject({
          ok: false,
          error: { code: 'invalid_request' },
        });
        const other = await active.broker.spawn(
          { ...rootParent, toolCallId: randomUUID() },
          baseTask,
        );
        if (!other.ok) throw new Error('Expected another accessible child');
        await waitForLaunch(active.runner, other.value.delegationId);
        const changedTarget = await active.broker.message(
          parent,
          { ...input, delegationId: other.value.delegationId },
          origin === 'user' ? operationId : undefined,
        );
        expect(changedTarget).toMatchObject({
          ok: false,
          error: { code: 'invalid_request' },
        });
      } finally {
        await active.broker.close();
      }
    },
  );

  it.each([false, true])(
    'preserves success and failure mixed-prefix semantics without a registry read (restart=%s)',
    async (restart) => {
      const f = await fixture();
      let active = f;
      try {
        const successId = randomUUID();
        const failureId = randomUUID();
        const input = {
          delegationId: f.id,
          operation: 'steer',
          message: 'legacy',
        };
        const record = f.broker['records'].get(f.id);
        if (record?.version !== 3) throw new Error('Expected stream');
        const error = {
          code: 'policy_blocked' as const,
          message: 'frozen failure',
          retryable: false,
        };
        const firstOutcome = {
          delegationId: f.id,
          status: 'completed' as const,
          finalText: 'frozen answer',
          outputTruncated: false,
        };
        const mixed = {
          ...record,
          legacyPrefix: {
            controls: [
              {
                operationId: successId,
                key: userKey(successId),
                requestHash: hashFor(input),
                operation: 'steer' as const,
                status: 'completed' as const,
                firstOutcome,
              },
              {
                operationId: failureId,
                key: userKey(failureId),
                requestHash: hashFor(input),
                operation: 'steer' as const,
                status: 'failed' as const,
                firstError: error,
              },
            ],
          },
        };
        const decodedMixed = decodeStoredDelegationV3(
          JSON.parse(JSON.stringify(mixed)),
        );
        f.broker['records'].set(f.id, decodedMixed);
        await f.storage.commit(decodedMixed);
        if (restart) {
          await f.broker.close();
          active = restartFixture(f);
          await active.broker.initialize();
        }
        const other = await active.broker.spawn(
          { ...rootParent, toolCallId: 'prefix-other' },
          baseTask,
        );
        if (!other.ok) throw new Error('Expected accessible second target');
        await waitForLaunch(active.runner, other.value.delegationId);
        const lookup = jest.spyOn(f.port, 'receipt');
        const commit = jest.spyOn(f.storage, 'commit');
        const before = JSON.stringify(f.storage.records.get(f.id));
        const user = { ...rootParent, controlAuthor: 'user' as const };
        expect(await active.broker.message(user, input, successId)).toEqual({
          ok: true,
          value: firstOutcome,
        });
        expect(await active.broker.message(user, input, failureId)).toEqual({
          ok: false,
          error,
        });
        expect(
          await active.broker.message(
            user,
            { ...input, message: 'changed' },
            successId,
          ),
        ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
        expect(
          await active.broker.message(
            user,
            { ...input, delegationId: other.value.delegationId },
            successId,
          ),
        ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
        expect(lookup).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(JSON.stringify(f.storage.records.get(f.id))).toBe(before);
      } finally {
        await active.broker.close();
      }
    },
  );

  it('rejects a registry response whose chat-wide identity conflicts without fitting a receipt', async () => {
    const f = await fixture();
    try {
      const input = {
        delegationId: f.id,
        operation: 'steer',
        message: 'original',
      };
      const entry = commandEntry(
        f.id,
        'a'.repeat(64),
        hashFor(input),
        'terminal success',
      );
      jest
        .spyOn(f.port, 'receipt')
        .mockResolvedValueOnce({ ok: true, value: entry });
      const commit = jest.spyOn(f.storage, 'commit');
      expect(
        await f.broker.manage(
          { ...rootParent, toolCallId: 'identity-conflict' },
          input,
        ),
      ).toMatchObject({ ok: false, error: { retryable: true } });
      expect(commit).not.toHaveBeenCalled();
      expect(f.runner.steeringRequests).toHaveLength(0);
    } finally {
      await f.broker.close();
    }
  });
  it.each(['direct', 'materialized', 'coalesced'])(
    'looks up host %s delivery before accepting, and replays its receipt through the agent branch',
    async (path) => {
      const f = await fixture({
        capacity: 1,
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({
              capabilities: ['read', 'progress', 'resume'],
            }),
          }),
      });
      try {
        if (path !== 'direct') {
          await f.runner.sink?.({
            delegationId: f.id,
            runGeneration: 1,
            sequence: 1,
            occurredAt: 1,
            event: { type: 'started', nativeSessionId: 'native' },
          });
          await f.runner.sink?.({
            delegationId: f.id,
            runGeneration: 1,
            sequence: 2,
            occurredAt: 2,
            event: { type: 'terminal', status: 'completed' },
          });
          for (let index = 0; index < 5; index++) await flushBroker();
        }
        if (path === 'coalesced') {
          const blocker = await f.broker.spawn(
            { ...rootParent, toolCallId: 'blocker' },
            baseTask,
          );
          if (!blocker.ok) throw new Error('Expected blocker');
          await waitForLaunch(f.runner, blocker.value.delegationId);
          expect(
            (
              await f.broker.deliverHostMessage(
                f.id,
                'queued first',
                randomUUID(),
              )
            ).ok,
          ).toBe(true);
        }
        const attemptId = randomUUID();
        const commit = jest.spyOn(f.storage, 'commit');
        const lookup = jest.spyOn(f.port, 'receipt').mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'unavailable',
            retryable: true,
          },
        });
        const before = JSON.stringify(f.storage.records.get(f.id));
        const runs = f.runner.starts.length;
        const steers = f.runner.steeringRequests.length;
        expect(
          await f.broker.deliverHostMessage(f.id, 'host message', attemptId),
        ).toMatchObject({ ok: false, error: { retryable: true } });
        expect(commit).not.toHaveBeenCalled();
        expect(JSON.stringify(f.storage.records.get(f.id))).toBe(before);
        expect(f.runner.starts).toHaveLength(runs);
        expect(f.runner.steeringRequests).toHaveLength(steers);
        expect(
          (await f.broker.deliverHostMessage(f.id, 'host message', attemptId))
            .ok,
        ).toBe(true);
        for (let index = 0; index < 10; index++) await flushBroker();
        const record = f.storage.records.get(f.id);
        if (record?.version !== 3) throw new Error('Expected stream');
        const key = createHash('sha256')
          .update(`host:request-steering:${attemptId}`)
          .digest('hex');
        const entry = record.receipts.commandReceipts.find(
          (entry) => entry.key === key,
        );
        if (!entry) throw new Error('Expected host receipt');
        const immutable = JSON.stringify(entry);
        commit.mockClear();
        lookup.mockClear();
        const replay = await f.broker.deliverHostMessage(
          f.id,
          'host message',
          attemptId,
        );
        expect(replay).toEqual(
          delegationReceiptAckToResult(
            projectDelegationCommandReplay(entry.reply, 'agent'),
          ),
        );
        expect(lookup).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(JSON.stringify(entry)).toBe(immutable);
        expect(
          await f.broker.deliverHostMessage(f.id, 'changed', attemptId),
        ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      } finally {
        await f.broker.close();
      }
    },
  );

  it('does not read the registry for an unavailable owning host session', async () => {
    const f = await fixture({ resolveHostParent: () => undefined });
    try {
      const lookup = jest.spyOn(f.port, 'receipt');
      const commit = jest.spyOn(f.storage, 'commit');
      expect(
        await f.broker.deliverHostMessage(f.id, 'probe', randomUUID()),
      ).toMatchObject({ ok: false, error: { code: 'parent_unavailable' } });
      expect(lookup).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    } finally {
      await f.broker.close();
    }
  });

  it.each(
    ([...errors, 'throw'] as const).flatMap((code) =>
      [false, true].map((restart) => ({ code, restart })),
    ),
  )(
    'does not accept a stop after registry $code (restart=$restart)',
    async ({ code, restart }) => {
      let f = await fixture();
      if (restart) {
        await f.broker.close();
        f = restartFixture(f);
        await f.broker.initialize();
      }
      try {
        const parent = { ...rootParent, toolCallId: `stop-lookup-${code}` };
        const lookup = jest.spyOn(f.port, 'receipt');
        if (code === 'throw')
          lookup.mockRejectedValueOnce(new Error('offline'));
        else
          lookup.mockResolvedValueOnce({
            ok: false,
            error: { code, message: 'refused', retryable: true },
          });
        const commit = jest.spyOn(f.storage, 'commit');
        expect(await f.broker.requestStop(parent, f.id)).toMatchObject({
          ok: false,
          error: { retryable: true },
        });
        expect(commit).not.toHaveBeenCalled();
        expect(f.runner.stopped).toHaveLength(0);
        expect((await f.broker.requestStop(parent, f.id)).ok).toBe(true);
      } finally {
        await f.broker.close();
      }
    },
  );

  it.each([false, true])(
    'replays a registry stop through D1, not a new native stop (restart=%s)',
    async (restart) => {
      const f = await fixture();
      let active = f;
      try {
        const call = 'archived-stop';
        const operationId = randomUUID();
        const common = {
          chatId: rootParent.chatId,
          delegationId: f.id,
          operation: 'stop' as const,
          operationId,
          runGeneration: 1,
          admittedAt: 1,
        };
        const alias = fitDelegationStopReceipt(
          {
            ...common,
            receiptKind: 'stop',
            key: keyFor(call),
            requestHash: delegationStopRequestHash(f.id),
          },
          'accepted',
        );
        const outcome = fitDelegationStopOutcomeReceipt(
          {
            ...common,
            receiptKind: 'stop_outcome',
            key: operationId,
            requestHash: null,
          },
          { status: 'failed', finishedAt: 2 },
        );
        if (!alias.ok || !outcome.ok) throw new Error('Expected stop fixtures');
        expect((await f.port.appendReceipt(alias.entry)).ok).toBe(true);
        expect((await f.port.appendReceipt(outcome.entry)).ok).toBe(true);
        if (restart) {
          await f.broker.close();
          active = restartFixture(f);
          await active.broker.initialize();
        }
        const commit = jest.spyOn(f.storage, 'commit');
        const result = await active.broker.requestStop(
          { ...rootParent, toolCallId: call },
          f.id,
        );
        expect(result).toMatchObject({
          ok: true,
          value: { stopRequested: { operationId, status: 'failed' } },
        });
        expect(active.runner.stopped).toHaveLength(0);
        expect(commit).not.toHaveBeenCalled();
      } finally {
        await active.broker.close();
      }
    },
  );

  it.each(
    scenarios.flatMap((scenario) =>
      [false, true].map((restart) => ({ scenario, restart })),
    ),
  )(
    'replays host registry $scenario through the agent branch (restart=$restart)',
    async ({ scenario, restart }) => {
      let f = await fixture();
      try {
        const attemptId = randomUUID();
        const key = createHash('sha256')
          .update(`host:request-steering:${attemptId}`)
          .digest('hex');
        const message = 'host registry message';
        const entry = commandEntry(
          f.id,
          key,
          createHash('sha256').update(message).digest('hex'),
          scenario,
        );
        expect((await f.port.appendReceipt(entry)).ok).toBe(true);
        if (restart) {
          await f.broker.close();
          f = restartFixture(f);
          await f.broker.initialize();
        }
        const commit = jest.spyOn(f.storage, 'commit');
        expect(
          await f.broker.deliverHostMessage(f.id, message, attemptId),
        ).toEqual(
          delegationReceiptAckToResult(
            projectDelegationCommandReplay(entry.reply, 'agent'),
          ),
        );
        expect(commit).not.toHaveBeenCalled();
        expect(f.runner.steeringRequests).toHaveLength(0);
        expect(f.runner.starts).toHaveLength(restart ? 0 : 1);
      } finally {
        await f.broker.close();
      }
    },
  );
  it.each(['prefix', 'window'])(
    'replays historical coalesced host keys from the $s without registry I/O',
    async (tier) => {
      const f = await fixture();
      try {
        const attemptId = randomUUID();
        const message = 'historical coalesced message';
        const key = createHash('sha256')
          .update(`host:coalesce:${attemptId}`)
          .digest('hex');
        const hash = createHash('sha256').update(message).digest('hex');
        const entry = commandEntry(f.id, key, hash, 'terminal success');
        if (tier === 'window')
          await f.broker['update'](f.id, (record) => {
            if (record.version !== 3) throw new Error('Expected stream');
            return {
              ...record,
              receipts: { ...record.receipts, commandReceipts: [entry] },
            };
          });
        else {
          const record = f.broker['records'].get(f.id);
          if (record?.version !== 3) throw new Error('Expected stream');
          const mixed = {
            ...record,
            legacyPrefix: {
              controls: [
                {
                  operationId: attemptId,
                  key,
                  requestHash: hash,
                  operation: 'steer' as const,
                  status: 'completed' as const,
                },
              ],
            },
          };
          decodeStoredDelegationV3(JSON.parse(JSON.stringify(mixed)));
          f.broker['records'].set(f.id, mixed);
          await f.storage.commit(mixed);
        }
        const lookup = jest.spyOn(f.port, 'receipt');
        const commit = jest.spyOn(f.storage, 'commit');
        expect(
          await f.broker.deliverHostMessage(f.id, message, attemptId),
        ).toEqual(
          tier === 'prefix'
            ? { ok: true, value: { attemptId, status: 'accepted' } }
            : delegationReceiptAckToResult(
                projectDelegationCommandReplay(entry.reply, 'agent'),
              ),
        );
        expect(lookup).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(f.runner.steeringRequests).toHaveLength(0);
      } finally {
        await f.broker.close();
      }
    },
  );

  it('probes the unified host key, then the historical coalesced key, for a fresh host attempt', async () => {
    const f = await fixture();
    try {
      const lookup = jest.spyOn(f.port, 'receipt');
      const attemptId = randomUUID();
      expect(
        (await f.broker.deliverHostMessage(f.id, 'new host message', attemptId))
          .ok,
      ).toBe(true);
      expect(lookup.mock.calls).toEqual(
        ['host:request-steering', 'host:coalesce'].map((domain) => [
          {
            chatId: rootParent.chatId,
            receiptKind: 'command',
            key: createHash('sha256')
              .update(`${domain}:${attemptId}`)
              .digest('hex'),
          },
        ]),
      );
    } finally {
      await f.broker.close();
    }
  });

  it('does not execute a direct host attempt again after the target becomes coalescible', async () => {
    const f = await fixture({
      capacity: 1,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    });
    try {
      const attemptId = randomUUID();
      expect(
        (await f.broker.deliverHostMessage(f.id, 'once', attemptId)).ok,
      ).toBe(true);
      for (let index = 0; index < 10; index++) await flushBroker();
      expect(f.runner.steeringRequests).toHaveLength(1);
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 1,
        event: { type: 'started', nativeSessionId: 'native' },
      });
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 2,
        event: { type: 'terminal', status: 'completed' },
      });
      for (let index = 0; index < 10; index++) await flushBroker();
      const blocker = await f.broker.spawn(
        { ...rootParent, toolCallId: 'path-change-blocker' },
        baseTask,
      );
      if (!blocker.ok) throw new Error('Expected blocker');
      await waitForLaunch(f.runner, blocker.value.delegationId);
      expect(
        (
          await f.broker.deliverHostMessage(
            f.id,
            'queued second attempt',
            randomUUID(),
          )
        ).ok,
      ).toBe(true);
      const record = f.storage.records.get(f.id);
      if (record?.version !== 3 || record.state.runGeneration !== 2)
        throw new Error('Expected queued continuation');
      const before = JSON.stringify(record);
      const commit = jest.spyOn(f.storage, 'commit');
      const lookup = jest.spyOn(f.port, 'receipt');
      expect(
        (await f.broker.deliverHostMessage(f.id, 'once', attemptId)).ok,
      ).toBe(true);
      expect(commit).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      expect(JSON.stringify(f.storage.records.get(f.id))).toBe(before);
      expect(f.runner.steeringRequests).toHaveLength(1);
    } finally {
      await f.broker.close();
    }
  });
});
