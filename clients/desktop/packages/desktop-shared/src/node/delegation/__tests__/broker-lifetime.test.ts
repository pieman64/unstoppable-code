import { normalizeManagedDelegationLifetimeLimit } from '@canopy/protocol/delegation/discovery';
import { randomUUID } from 'node:crypto';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import type { AgentDelegationBrokerOptions } from '../broker';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
} from './broker-harness';
import { routeFixture } from './fixtures';

jest.setTimeout(60_000);

// Inject invalid runtime results without weakening the production policy type.
function policyOptions(
  policy: () => unknown,
): Partial<AgentDelegationBrokerOptions> {
  const options: Partial<AgentDelegationBrokerOptions> = {};
  Object.defineProperty(options, 'lifetimePolicy', {
    value: policy,
    enumerable: true,
  });
  return options;
}
const cappedMessage =
  'This worktree has reached its lifetime subagent limit. This is the most this build allows.';
const possibleMessage =
  'This worktree has reached its lifetime subagent limit. You can extend it in Settings.';
const unreadableMessage =
  'This worktree’s subagent limit record cannot be read. New subagents are unavailable.';
const uncertainMessage =
  'This worktree’s subagent limit record is being confirmed. New subagents are unavailable.';

function admissionSnapshot(
  broker: ReturnType<typeof createBrokerHarness>['broker'],
): unknown {
  const read = Reflect.get(broker, 'lifetimeSnapshot');
  return typeof read === 'function'
    ? read.call(broker)
    : {
        occupied: broker.retainedCount(),
        retained: broker.retainedCount(),
        atLimit: broker.retainedCount() >= 512,
      };
}

describe('lifetime status observation', () => {
  it('counts a held new reservation and publishes its failed preparation release', async () => {
    const storage = await retainedStorage(511);
    const held = gate();
    const observations: unknown[] = [];
    const { broker } = createBrokerHarness(
      {
        preflight: async () => {
          await held.promise;
          return {
            ok: false,
            error: {
              code: 'policy_blocked',
              message: 'Denied',
              retryable: false,
            },
          };
        },
        onActivity: () => observations.push(admissionSnapshot(broker)),
      },
      storage,
    );
    await broker.initialize();
    try {
      const pending = broker.spawn(rootParent, baseTask);
      expect(admissionSnapshot(broker)).toMatchObject({
        occupied: 512,
        retained: 511,
        atLimit: true,
      });
      held.release();
      await pending;
      expect(admissionSnapshot(broker)).toMatchObject({
        occupied: 511,
        retained: 511,
        atLimit: false,
      });
      expect(observations[observations.length - 1]).toMatchObject({
        occupied: 511,
        atLimit: false,
      });
    } finally {
      held.release();
      await broker.close();
    }
  });

  it.each(['capacity', 'policy_unavailable'] as const)(
    'reports the typed %s refusal synchronously with its caller',
    async (reason) => {
      const refusals: unknown[] = [];
      const options = policyOptions(() =>
        reason === 'capacity'
          ? { kind: 'available', limit: 0, extension: 'none' }
          : { kind: 'unavailable', reason: 'uncertain' },
      );
      Object.defineProperty(options, 'onLifetimeRefusal', {
        value: (parent: unknown, kind: unknown) =>
          refusals.push({ parent, reason: kind }),
        enumerable: true,
      });
      const { broker } = createBrokerHarness(options);
      await broker.initialize();
      try {
        const pending = broker.spawn(rootParent, baseTask);
        expect(refusals).toEqual([{ parent: rootParent, reason }]);
        expect((await pending).ok).toBe(false);
      } finally {
        await broker.close();
      }
    },
  );
});

async function retainedStorage(
  count: number,
): Promise<MemoryDelegationStorage> {
  const storage = new MemoryDelegationStorage();
  const { broker } = createBrokerHarness({}, storage);
  await broker.initialize();
  await broker.spawn(rootParent, baseTask);
  await broker.close();
  const record = Array.from(storage.records.values())[0];
  if (!record) throw new Error('Expected seed record');
  storage.records.clear();
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    storage.records.set(id, {
      ...structuredClone(record),
      callKey: `retained-${index}`,
      state: { ...record.state, delegationId: id },
    });
  }
  return storage;
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('distinct lifetime identities', () => {
  it.each([
    ['possible', possibleMessage],
    ['at_cap', cappedMessage],
    ['none', cappedMessage],
  ])(
    'uses one available %s policy snapshot and persists no lifetime refusal',
    async (extension, message) => {
      const policy = jest.fn(() => ({
        kind: 'available',
        limit: 0,
        extension,
      }));
      const storage = new MemoryDelegationStorage();
      const { broker } = createBrokerHarness(policyOptions(policy), storage);
      await broker.initialize();
      try {
        expect(await broker.spawn(rootParent, baseTask)).toEqual({
          ok: false,
          error: {
            code: 'lifetime_limit_reached',
            message,
            retryable: false,
          },
        });
        expect(policy).toHaveBeenCalledTimes(1);
        expect(storage.records.size).toBe(0);
        expect(broker.retainedCount()).toBe(0);
        expect(Reflect.get(broker, 'calls')).toEqual(new Map());
        expect(Reflect.get(broker, 'pending')).toEqual(new Map());
        expect(Reflect.get(broker, 'newIdentityReservations')).toEqual(
          new Set(),
        );
        expect(broker.list(rootParent)).toEqual([]);
        // Same call can be admitted after policy changes: no refused call cache remains.
        policy.mockReturnValue({ kind: 'available', limit: 1, extension });
        expect((await broker.spawn(rootParent, baseTask)).ok).toBe(true);
      } finally {
        await broker.close();
      }
    },
  );

  it.each([
    ['unreadable', unreadableMessage],
    ['uncertain', uncertainMessage],
  ])('fences an unavailable %s snapshot', async (reason, message) => {
    const { broker } = createBrokerHarness(
      policyOptions(() => ({ kind: 'unavailable', reason })),
    );
    await broker.initialize();
    try {
      expect(await broker.spawn(rootParent, baseTask)).toEqual({
        ok: false,
        error: {
          code: 'lifetime_limit_reached',
          message,
          retryable: false,
        },
      });
    } finally {
      await broker.close();
    }
  });

  it.each([
    null,
    {},
    { kind: 'available', limit: -1, extension: 'none' },
    { kind: 'available', limit: 1.5, extension: 'none' },
    {
      kind: 'available',
      limit: Number.MAX_SAFE_INTEGER + 1,
      extension: 'none',
    },
    { kind: 'available', limit: 2, extension: 'invented' },
    { kind: 'unavailable', reason: 'invented' },
  ])('fails closed for an invalid callback result %j', async (value) => {
    const { broker } = createBrokerHarness(policyOptions(() => value));
    await broker.initialize();
    try {
      expect(await broker.spawn(rootParent, baseTask)).toEqual({
        ok: false,
        error: {
          code: 'lifetime_limit_reached',
          message: unreadableMessage,
          retryable: false,
        },
      });
    } finally {
      await broker.close();
    }
  });

  it('turns a throwing callback into a typed non-retryable refusal', async () => {
    const { broker } = createBrokerHarness(
      policyOptions(() => {
        throw new Error('private details');
      }),
    );
    await broker.initialize();
    try {
      expect(await broker.spawn(rootParent, baseTask)).toEqual({
        ok: false,
        error: {
          code: 'lifetime_limit_reached',
          message: unreadableMessage,
          retryable: false,
        },
      });
    } finally {
      await broker.close();
    }
  });

  it.each([false, true])(
    'accepts identity 513 with no saved setting under cap 1024 (async=%s), then refuses 1025',
    async (asyncAdmission) => {
      const storage = await retainedStorage(512);
      const { broker, runner } = createBrokerHarness(
        {
          ...policyOptions(() => ({
            kind: 'available',
            limit: normalizeManagedDelegationLifetimeLimit(undefined, 1024),
            extension: 'at_cap',
          })),
          asyncAdmission,
        },
        storage,
      );
      await broker.initialize();
      try {
        for (let index = 512; index < 1024; index++) {
          const result = await broker.spawn(
            { ...rootParent, toolCallId: `new-${index}` },
            baseTask,
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            await flushBroker();
            const sink = runner.sinks.get(result.value.delegationId);
            if (!sink) throw new Error('Expected launch sink');
            await sink({
              delegationId: result.value.delegationId,
              runGeneration: 1,
              sequence: 1,
              occurredAt: 1,
              event: { type: 'terminal', status: 'completed' },
            });
            await flushBroker();
          }
        }
        expect(
          await broker.spawn(
            { ...rootParent, toolCallId: 'overflow' },
            baseTask,
          ),
        ).toEqual({
          ok: false,
          error: {
            code: 'lifetime_limit_reached',
            message: cappedMessage,
            retryable: false,
          },
        });
      } finally {
        await broker.close();
      }
    },
  );

  it('keeps the absent-option fallback at 512 with a distinct refusal', async () => {
    const storage = await retainedStorage(512);
    const { broker } = createBrokerHarness({}, storage);
    await broker.initialize();
    try {
      expect(await broker.spawn(rootParent, baseTask)).toEqual({
        ok: false,
        error: {
          code: 'lifetime_limit_reached',
          message: cappedMessage,
          retryable: false,
        },
      });
      expect(storage.records.size).toBe(512);
    } finally {
      await broker.close();
    }
  });

  it('loads retained identities above the product bound', async () => {
    const storage = await retainedStorage(513);
    const { broker } = createBrokerHarness({}, storage);
    try {
      await expect(broker.initialize()).resolves.toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it.each([false, true])(
    'reserves synchronously while preparation is held (async=%s)',
    async (asyncAdmission) => {
      const held = gate();
      const policy = jest.fn(() => ({
        kind: 'available',
        limit: 2,
        extension: 'none',
      }));
      const { broker } = createBrokerHarness({
        ...policyOptions(policy),
        asyncAdmission,
        resolveRoute: async () => {
          await held.promise;
          return { ok: true, value: routeFixture() };
        },
      });
      await broker.initialize();
      const first = broker.spawn(rootParent, baseTask);
      const second = broker.spawn(
        { ...rootParent, toolCallId: 'last' },
        baseTask,
      );
      try {
        let raced: AgentDelegationResult<AgentDelegationSnapshot> | undefined;
        const racing = broker
          .spawn({ ...rootParent, toolCallId: 'race' }, baseTask)
          .then((result) => {
            raced = result;
          });
        await flushBroker();
        try {
          expect(raced).toMatchObject({
            ok: false,
            error: { code: 'lifetime_limit_reached' },
          });
        } finally {
          held.release();
          await racing;
        }
        expect(policy).toHaveBeenCalledTimes(3);
        expect(broker.retainedCount()).toBe(asyncAdmission ? 2 : 0);
      } finally {
        held.release();
        expect((await first).ok).toBe(true);
        expect((await second).ok).toBe(true);
        await broker.close();
      }
    },
  );

  it('does not double-charge a durably queued identity while preparation waits', async () => {
    const storage = await retainedStorage(510);
    const held = gate();
    const { broker } = createBrokerHarness(
      {
        asyncAdmission: true,
        capacity: 1,
        resolveRoute: async () => {
          await held.promise;
          return { ok: true, value: routeFixture() };
        },
      },
      storage,
    );
    await broker.initialize();
    try {
      expect((await broker.spawn(rootParent, baseTask)).ok).toBe(true);
      expect(
        (await broker.spawn({ ...rootParent, toolCallId: 'last' }, baseTask))
          .ok,
      ).toBe(true);
      expect(
        (
          await broker.spawn(
            { ...rootParent, toolCallId: 'overflow' },
            baseTask,
          )
        ).ok,
      ).toBe(false);
    } finally {
      held.release();
      await broker.close();
    }
  });

  it.each([false, true])(
    'does not charge a retained continuation (v3=%s)',
    async (v3) => {
      let policyReads = 0;
      const held = gate();
      let holdRoute = false;
      const port = new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
        ownsChat: (): boolean => true,
      });
      const storage = await retainedStorage(510);
      const { broker, runner } = createBrokerHarness(
        {
          ...policyOptions(() => {
            policyReads++;
            return { kind: 'available', limit: 512, extension: 'none' };
          }),
          ...(v3
            ? { testOnlyStreamGeneration: true, transcriptPort: port }
            : {}),
          asyncAdmission: true,
          resolveRoute: async () => {
            if (holdRoute) await held.promise;
            return {
              ok: true,
              value: routeFixture({
                capabilities: ['read', 'progress', 'resume'],
              }),
            };
          },
        },
        storage,
      );
      await broker.initialize();
      try {
        const first = await broker.spawn(rootParent, baseTask);
        if (!first.ok) throw new Error('Expected first admission');
        await flushBroker();
        const sink = runner.sinks.get(first.value.delegationId);
        if (!sink) throw new Error('Expected launch sink');
        await sink({
          delegationId: first.value.delegationId,
          runGeneration: 1,
          sequence: 1,
          occurredAt: 1,
          event: { type: 'started', nativeSessionId: 'native-1' },
        });
        await sink({
          delegationId: first.value.delegationId,
          runGeneration: 1,
          sequence: 2,
          occurredAt: 2,
          event: { type: 'terminal', status: 'completed' },
        });
        await flushBroker();
        holdRoute = true;
        expect(
          (
            await broker.message(
              { ...rootParent, toolCallId: 'follow' },
              {
                delegationId: first.value.delegationId,
                operation: 'follow_up',
                message: 'Continue.',
              },
            )
          ).ok,
        ).toBe(true);
        expect(
          (await broker.spawn({ ...rootParent, toolCallId: 'last' }, baseTask))
            .ok,
        ).toBe(true);
        expect(policyReads).toBe(2);
        expect(
          (
            await broker.spawn(
              { ...rootParent, toolCallId: 'overflow' },
              baseTask,
            )
          ).ok,
        ).toBe(false);
      } finally {
        held.release();
        await broker.close();
      }
    },
  );

  it('releases a failed preflight reservation and leaves the slot usable', async () => {
    let accepted = false;
    const { broker } = createBrokerHarness({
      ...policyOptions(() => ({
        kind: 'available',
        limit: 1,
        extension: 'none',
      })),
      preflight: () =>
        Promise.resolve(
          accepted
            ? { ok: true, value: undefined }
            : {
                ok: false,
                error: {
                  code: 'policy_blocked',
                  message: 'Denied',
                  retryable: false,
                },
              },
        ),
    });
    await broker.initialize();
    try {
      expect((await broker.spawn(rootParent, baseTask)).ok).toBe(false);
      accepted = true;
      expect(
        (await broker.spawn({ ...rootParent, toolCallId: 'retry' }, baseTask))
          .ok,
      ).toBe(true);
      expect(
        (
          await broker.spawn(
            { ...rootParent, toolCallId: 'overflow' },
            baseTask,
          )
        ).ok,
      ).toBe(false);
    } finally {
      await broker.close();
    }
  });
});

describe('lifetime reservation release', () => {
  it('keeps a concurrency refusal transient and releases its new-identity reservation', async () => {
    const { broker } = createBrokerHarness({
      ...policyOptions(() => ({
        kind: 'available',
        limit: 2,
        extension: 'none',
      })),
      capacity: 1,
      asyncAdmission: true,
    });
    await broker.initialize();
    try {
      expect((await broker.spawn(rootParent, baseTask)).ok).toBe(true);
      await flushBroker();
      expect(
        await broker.spawn(
          { ...rootParent, toolCallId: 'busy' },
          { ...baseTask, ifBusy: 'reject' },
        ),
      ).toEqual({
        ok: false,
        error: {
          code: 'capacity_exceeded',
          message: 'The delegation limit was reached.',
          retryable: false,
        },
      });
      expect(
        (await broker.spawn({ ...rootParent, toolCallId: 'last' }, baseTask))
          .ok,
      ).toBe(true);
      expect(
        await broker.spawn({ ...rootParent, toolCallId: 'overflow' }, baseTask),
      ).toEqual({
        ok: false,
        error: {
          code: 'lifetime_limit_reached',
          message: cappedMessage,
          retryable: false,
        },
      });
    } finally {
      await broker.close();
    }
  });

  it('releases a failed durable admission reservation', async () => {
    const storage = new MemoryDelegationStorage();
    const commit = jest.spyOn(storage, 'commit');
    commit.mockRejectedValueOnce(new Error('disk full'));
    const { broker } = createBrokerHarness(
      {
        ...policyOptions(() => ({
          kind: 'available',
          limit: 1,
          extension: 'none',
        })),
        asyncAdmission: true,
      },
      storage,
    );
    await broker.initialize();
    try {
      expect((await broker.spawn(rootParent, baseTask)).ok).toBe(false);
      expect(storage.records.size).toBe(0);
      expect(
        (await broker.spawn({ ...rootParent, toolCallId: 'retry' }, baseTask))
          .ok,
      ).toBe(true);
      expect(
        (
          await broker.spawn(
            { ...rootParent, toolCallId: 'overflow' },
            baseTask,
          )
        ).ok,
      ).toBe(false);
    } finally {
      await broker.close();
    }
  });
});

describe('queue-full admission stays transient', () => {
  it('preserves capacity_exceeded and queue-full copy without leaking a lifetime reservation', async () => {
    const { broker } = createBrokerHarness({
      ...policyOptions(() => ({
        kind: 'available',
        limit: 130,
        extension: 'none',
      })),
      capacity: 1,
      asyncAdmission: true,
    });
    await broker.initialize();
    try {
      let queuedId: string | undefined;
      for (let index = 0; index < 129; index++) {
        const result = await broker.spawn(
          { ...rootParent, toolCallId: `fill-${index}` },
          baseTask,
        );
        expect(result.ok).toBe(true);
        if (index === 1 && result.ok) queuedId = result.value.delegationId;
      }
      expect(
        await broker.spawn(
          { ...rootParent, toolCallId: 'queue-full' },
          baseTask,
        ),
      ).toEqual({
        ok: false,
        error: {
          code: 'capacity_exceeded',
          message: 'The Default queue is full.',
          retryable: false,
        },
      });
      if (!queuedId) throw new Error('Expected queued identity');
      await broker.stop(rootParent, queuedId);
      expect(
        (await broker.spawn({ ...rootParent, toolCallId: 'last' }, baseTask))
          .ok,
      ).toBe(true);
      expect(
        await broker.spawn({ ...rootParent, toolCallId: 'overflow' }, baseTask),
      ).toEqual({
        ok: false,
        error: {
          code: 'lifetime_limit_reached',
          message: cappedMessage,
          retryable: false,
        },
      });
    } finally {
      await broker.close();
    }
  });
});

describe('defensive broker initialization bound', () => {
  it('still refuses more than 65,536 supplied records before identity decoding', async () => {
    const storage = await retainedStorage(1);
    const record = Array.from(storage.records.values())[0];
    if (!record) throw new Error('Expected seed record');
    jest
      .spyOn(storage, 'load')
      .mockResolvedValue(Array.from({ length: 65_537 }, () => record));
    const { broker } = createBrokerHarness({}, storage);
    try {
      await expect(broker.initialize()).rejects.toThrow(
        'Delegation registry exceeds its bound',
      );
    } finally {
      await broker.close();
    }
  });
});
