import {
  MCP_ACTIVATION_CONTINUATION,
  type McpCapabilityIdentity,
  type McpActivationRecord,
  type McpActivationScope,
} from '@canopy/protocol/mcp-servers';
import {
  McpSessionAvailability,
  type McpSessionBinding,
} from '../mcp/session-availability';
import {
  McpActivationService,
  type McpActivationHost,
} from '../services/mcp-activation-service';
import type { McpActivationStore } from '../services/mcp-activation-store';

type HostMocks = {
  [Operation in keyof McpActivationHost]: jest.MockedFunction<
    (
      this: void,
      ...args: Parameters<McpActivationHost[Operation]>
    ) => ReturnType<McpActivationHost[Operation]>
  >;
};

const identity = {
  kind: 'standalone',
  serverId: 'server',
  configId: 'config',
} as const;
const binding: McpSessionBinding = {
  ownerId: 'owner',
  scope: { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
  sessionId: 'session',
  provider: 'claude',
  generation: 1,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture(
  setupTimeoutMs = 1000,
  resultTimeoutMs = 1000,
): {
  service: McpActivationService;
  availability: McpSessionAvailability;
  host: HostMocks;
  persisted: { record?: McpActivationRecord };
  store: Pick<McpActivationStore, 'read' | 'compareAndSet'>;
} {
  const persisted: { record?: McpActivationRecord } = {};
  const store = {
    read: jest.fn(
      (): Promise<McpActivationRecord | undefined> =>
        Promise.resolve(structuredClone(persisted.record)),
    ),
    compareAndSet: jest.fn(
      (
        _scope: McpActivationScope,
        expected: McpActivationRecord | undefined,
        next: McpActivationRecord,
      ): Promise<boolean> => {
        if (JSON.stringify(persisted.record) !== JSON.stringify(expected))
          return Promise.resolve(false);
        persisted.record = structuredClone(next);
        return Promise.resolve(true);
      },
    ),
  };
  const availability = new McpSessionAvailability();
  availability.begin(binding, [
    {
      identity,
      selected: true,
      enabled: true,
      permitted: true,
      authRequirement: 'unknown',
    },
  ]);
  const host: HostMocks = {
    isCurrent: jest.fn(() => Promise.resolve(true)),
    prepare: jest.fn(() => Promise.resolve(binding)),
    dispatch: jest.fn(() =>
      Promise.resolve<'accepted' | 'not_sent' | 'uncertain'>('accepted'),
    ),
    stop: jest.fn(() => Promise.resolve()),
    reconcile: jest.fn(() =>
      Promise.resolve<'accepted' | 'not_sent' | 'uncertain'>('uncertain'),
    ),
  };
  return {
    service: new McpActivationService(
      store,
      availability,
      host,
      setupTimeoutMs,
      resultTimeoutMs,
    ),
    availability,
    host,
    persisted,
    store,
  };
}

const input = {
  binding,
  originatingMessageId: 'message',
  targets: [identity],
  trigger: 'load' as const,
  toolCallId: 'tool',
};
function ready(availability: McpSessionAvailability): void {
  availability.observe(binding, {
    kind: 'tools',
    identity,
    initialized: true,
    complete: true,
    toolCount: 1,
  });
}

describe('host-owned MCP activation', () => {
  it('correlates delivery to the old generation while preparing the reserved replacement', async () => {
    const f = fixture();
    const replacement = { ...binding, generation: 2, sessionId: 'replacement' };
    f.host.prepare.mockImplementation(() => {
      f.availability.begin(replacement, [
        {
          identity,
          selected: true,
          enabled: true,
          permitted: true,
          authRequirement: 'unknown',
        },
      ]);
      f.availability.observe(replacement, {
        identity,
        kind: 'tools',
        initialized: true,
        complete: true,
        toolCount: 1,
      });
      return Promise.resolve(replacement);
    });
    const receipt = await f.service.activate({
      ...input,
      desiredGeneration: 2,
    });
    expect(receipt.generation).toBe(2);
    expect(
      f.service.deliverResult(replacement, receipt.activationId, 'tool'),
    ).toBe(false);
    expect(f.service.deliverResult(binding, receipt.activationId, 'tool')).toBe(
      true,
    );
    await flush();
    expect(f.persisted.record).toMatchObject({
      phase: 'completed',
      desiredGeneration: 2,
      loadRequest: { generation: 1 },
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });
  it('persists before returning, waits for correlated result and readiness, and emits completed after durable admission', async () => {
    const f = fixture();
    const published: string[] = [];
    f.service.subscribe((_scope, record) => {
      expect(record).toEqual(f.persisted.record);
      published.push(record.phase);
    });
    const receipt = await f.service.activate(input);
    expect(f.persisted.record?.phase).toBe('result_pending');
    expect(f.host.prepare).not.toHaveBeenCalled();
    expect(
      f.service.deliverResult(
        { ...binding, sessionId: 'other' },
        receipt.activationId,
        'tool',
      ),
    ).toBe(false);
    expect(
      f.service.deliverResult(binding, receipt.activationId, 'wrong'),
    ).toBe(false);
    expect(f.service.deliverResult(binding, receipt.activationId, 'tool')).toBe(
      true,
    );
    expect(f.service.deliverResult(binding, receipt.activationId, 'tool')).toBe(
      false,
    );
    await flush();
    expect(f.host.dispatch).not.toHaveBeenCalled();
    ready(f.availability);
    await flush();
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    expect(f.host.dispatch).toHaveBeenCalledWith(
      binding.scope,
      expect.objectContaining({
        originatingMessageId: 'message',
        admission: 'uncertain',
      }),
      MCP_ACTIVATION_CONTINUATION,
      expect.any(AbortSignal),
    );
    expect(f.persisted.record).toMatchObject({
      phase: 'completed',
      admission: 'accepted',
    });
    expect(published.at(-1)).toBe('completed');
    expect(await f.service.activate(input)).toEqual(receipt);
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    const second = await f.service.activate({
      ...input,
      toolCallId: 'second-load',
    });
    f.service.deliverResult(binding, second.activationId, 'second-load');
    await flush();
    expect(await f.service.activate(input)).toEqual(receipt);
    expect(f.host.dispatch).toHaveBeenCalledTimes(2);
  });

  it('allows successive activations in the same logical task', async () => {
    const f = fixture();
    ready(f.availability);
    const first = await f.service.activate({
      ...input,
      trigger: 'selection',
      toolCallId: undefined,
    });
    await flush();
    const second = await f.service.activate({
      ...input,
      trigger: 'selection',
      toolCallId: undefined,
    });
    await flush();
    expect(first.activationId).not.toBe(second.activationId);
    expect(f.host.dispatch).toHaveBeenCalledTimes(2);
  });

  it('returns the same receipt for concurrent identical loads', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.activate(input),
      f.service.activate(input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.persisted.record?.activationId).toBe(results[0].activationId);
    expect(f.host.prepare).not.toHaveBeenCalled();
    await f.service.cancel(binding.scope);
  });

  it.each(['durable-read', 'concurrent-cas'])(
    'waits for run installation before duplicate load delivery through %s',
    async (duplicatePath) => {
      const f = fixture();
      let releaseCommit: (() => void) | undefined;
      const commitAcknowledged = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      jest
        .spyOn(f.store, 'compareAndSet')
        .mockImplementation(async (_scope, expected, next) => {
          if (JSON.stringify(f.persisted.record) !== JSON.stringify(expected))
            return false;
          f.persisted.record = structuredClone(next);
          if (next.phase === 'result_pending') await commitAcknowledged;
          return true;
        });
      ready(f.availability);
      const original = f.service.activate(input);
      if (duplicatePath === 'durable-read') await flush();
      const duplicate = f.service.activate(input);
      const delivered = duplicate.then((receipt) =>
        f.service.deliverResult(binding, receipt.activationId, 'tool'),
      );
      await flush();
      expect(f.persisted.record?.phase).toBe('result_pending');
      expect(f.host.prepare).not.toHaveBeenCalled();
      releaseCommit?.();
      try {
        expect(await duplicate).toEqual(await original);
        expect(await delivered).toBe(true);
        await flush();
        expect(f.persisted.record).toMatchObject({
          phase: 'completed',
          admission: 'accepted',
        });
        expect(f.host.dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await f.service.cancel(binding.scope);
      }
    },
  );

  it.each([
    { trigger: 'load', commitVisible: true },
    { trigger: 'load', commitVisible: false },
    { trigger: 'selection', commitVisible: true },
    { trigger: 'selection', commitVisible: false },
    { trigger: 'auth', commitVisible: true },
    { trigger: 'auth', commitVisible: false },
  ] as const)(
    'cancels an initializing $trigger activation with commitVisible=$commitVisible',
    async ({ trigger, commitVisible }) => {
      const f = fixture();
      const published: string[] = [];
      f.service.subscribe((_scope, record) => published.push(record.phase));
      let releaseCommit: (() => void) | undefined;
      const commitAcknowledged = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let initialWrite = true;
      jest
        .spyOn(f.store, 'compareAndSet')
        .mockImplementation(async (_scope, expected, next) => {
          const held = initialWrite;
          initialWrite = false;
          if (held && !commitVisible) await commitAcknowledged;
          if (JSON.stringify(f.persisted.record) !== JSON.stringify(expected))
            return false;
          f.persisted.record = structuredClone(next);
          if (held && commitVisible) await commitAcknowledged;
          return true;
        });
      const activation = f.service.activate({ ...input, trigger });
      await flush();
      expect(f.persisted.record?.phase).toBe(
        commitVisible
          ? trigger === 'load'
            ? 'result_pending'
            : 'preparing'
          : undefined,
      );
      let cancelled = false;
      const cancellation = f.service.cancel(binding.scope).then(() => {
        cancelled = true;
      });
      const duplicateCancellation = f.service.cancel(binding.scope);
      await flush();
      expect(cancelled).toBe(false);
      await expect(
        f.service.activate({ ...input, toolCallId: 'during-cancel' }),
      ).rejects.toThrow('pending');
      releaseCommit?.();
      try {
        const original = await activation;
        await Promise.all([cancellation, duplicateCancellation]);
        await flush();
        expect(f.persisted.record).toMatchObject({
          phase: 'cancelled',
          cancelled: true,
          admission: 'not_sent',
        });
        expect(published.at(-1)).toBe('cancelled');
        expect(f.host.prepare).not.toHaveBeenCalled();
        expect(f.host.dispatch).not.toHaveBeenCalled();
        expect(
          f.service.deliverResult(binding, original.activationId, 'tool'),
        ).toBe(false);
        const next = await f.service.activate({
          ...input,
          toolCallId: 'after-cancel',
        });
        expect(next.activationId).not.toBe(original.activationId);
      } finally {
        releaseCommit?.();
        await Promise.allSettled([activation, cancellation]);
        await f.service.cancel(binding.scope);
      }
    },
  );

  it.each([
    { operation: 'retry', commitVisible: true },
    { operation: 'retry', commitVisible: false },
    { operation: 'auth-resume', commitVisible: true },
    { operation: 'auth-resume', commitVisible: false },
  ] as const)(
    'cancels an installing $operation with commitVisible=$commitVisible',
    async ({ operation, commitVisible }) => {
      const f = fixture();
      if (operation === 'retry') {
        ready(f.availability);
        f.host.dispatch.mockResolvedValue('not_sent');
      } else {
        f.availability.observe(binding, { kind: 'auth_required', identity });
      }
      const original = await f.service.activate({
        ...input,
        trigger: 'selection',
      });
      await flush();
      expect(f.persisted.record?.phase).toBe(
        operation === 'retry' ? 'failed' : 'awaiting_auth',
      );
      f.host.prepare.mockClear();
      f.host.dispatch.mockClear();
      const published: string[] = [];
      f.service.subscribe((_scope, record) => published.push(record.phase));
      let releaseCommit: (() => void) | undefined;
      const commitAcknowledged = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let initialWrite = true;
      jest
        .spyOn(f.store, 'compareAndSet')
        .mockImplementation(async (_scope, expected, next) => {
          const held = initialWrite;
          initialWrite = false;
          if (held && !commitVisible) await commitAcknowledged;
          if (JSON.stringify(f.persisted.record) !== JSON.stringify(expected))
            return false;
          f.persisted.record = structuredClone(next);
          if (held && commitVisible) await commitAcknowledged;
          return true;
        });
      const installing =
        operation === 'retry'
          ? f.service.retry('owner', {
              scope: binding.scope,
              activationId: original.activationId,
              expectedGeneration: 1,
              idempotencyKey: 'cancelled-retry',
            })
          : f.service.resumeAfterAuth(
              'owner',
              binding.scope,
              original.activationId,
              {
                binding,
                attemptId: original.attemptId,
                identity,
              },
            );
      // Preserve any expected stale-write rejection until cancellation settles.
      const settled = installing.then(
        () => undefined,
        () => undefined,
      );
      await flush();
      const cancellation = f.service.cancel(binding.scope);
      await flush();
      releaseCommit?.();
      try {
        await settled;
        await cancellation;
        await flush();
        expect(f.persisted.record).toMatchObject({
          phase: 'cancelled',
          cancelled: true,
          admission: 'not_sent',
        });
        expect(published.at(-1)).toBe('cancelled');
        expect(f.host.prepare).not.toHaveBeenCalled();
        expect(f.host.dispatch).not.toHaveBeenCalled();
        await expect(
          f.service.activate({ ...input, toolCallId: 'after-cancel' }),
        ).resolves.toMatchObject({ generation: 1 });
      } finally {
        releaseCommit?.();
        await Promise.allSettled([settled, cancellation]);
        await f.service.cancel(binding.scope);
      }
    },
  );

  it('does not overwrite an active transition with a different overlapping load', async () => {
    const f = fixture();
    const original = await f.service.activate(input);
    await expect(
      f.service.activate({ ...input, toolCallId: 'another-load' }),
    ).rejects.toThrow('pending');
    expect(f.persisted.record?.activationId).toBe(original.activationId);
    await f.service.cancel(binding.scope);
  });

  it('terminates a stale readiness wait so the next activation is not stranded', async () => {
    const f = fixture();
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    expect(f.persisted.record?.phase).toBe('connecting');
    f.availability.begin({ ...binding, generation: 2 }, [
      {
        identity,
        selected: true,
        enabled: true,
        permitted: true,
        authRequirement: 'unknown',
      },
    ]);
    await flush();
    expect(f.persisted.record).toMatchObject({
      phase: 'failed',
      failureCode: 'stale_task',
      retryEligible: false,
      admission: 'not_sent',
    });
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });

  it('records uncertain admission after a lost provider reply and refuses blind retry', async () => {
    const f = fixture();
    ready(f.availability);
    f.host.dispatch.mockRejectedValue(
      new Error('provider accepted then disconnected'),
    );
    const receipt = await f.service.activate({
      ...input,
      trigger: 'selection',
    });
    await flush();
    expect(f.persisted.record).toMatchObject({
      phase: 'failed',
      admission: 'uncertain',
      retryEligible: false,
      failureCode: 'admission_uncertain',
    });
    await expect(
      f.service.retry('owner', {
        scope: binding.scope,
        activationId: receipt.activationId,
        expectedGeneration: 1,
        idempotencyKey: 'retry',
      }),
    ).rejects.toThrow('cannot be retried');
    await f.service.recover(binding.scope);
    expect(f.host.reconcile).toHaveBeenCalledTimes(1);
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it('reconciles accepted admission after a crash before commit without dispatching again', async () => {
    const f = fixture();
    await f.service.activate(input);
    const record = structuredClone(f.persisted.record);
    if (!record) throw new Error('Expected recovery record');
    await f.service.cancel(binding.scope);
    f.persisted.record = {
      ...record,
      phase: 'resuming',
      admission: 'uncertain',
    };
    f.host.reconcile.mockResolvedValue('accepted');
    await f.service.recover(binding.scope);
    expect(f.persisted.record).toMatchObject({
      phase: 'completed',
      admission: 'accepted',
    });
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent desktop/Portal retries and retains old receipts across later retries', async () => {
    const f = fixture();
    ready(f.availability);
    f.host.dispatch.mockResolvedValue('not_sent');
    const original = await f.service.activate({
      ...input,
      trigger: 'selection',
    });
    await flush();
    const request = {
      scope: binding.scope,
      activationId: original.activationId,
      expectedGeneration: 1,
      idempotencyKey: 'retry-1',
    };
    const [first, duplicate] = await Promise.all([
      f.service.retry('owner', request),
      f.service.retry('owner', request),
    ]);
    expect(duplicate).toEqual(first);
    await flush();
    await f.service.retry('owner', { ...request, idempotencyKey: 'retry-2' });
    await flush();
    expect(await f.service.retry('owner', request)).toEqual(first);
    expect(f.host.dispatch).toHaveBeenCalledTimes(3);
    // Clients render Retry from this flag, so it must agree with retry().
    expect(f.persisted.record).toMatchObject({
      phase: 'failed',
      failureCode: 'resume_failed',
      attemptNumber: 3,
      retryEligible: false,
    });
    await expect(
      f.service.retry('owner', { ...request, idempotencyKey: 'retry-3' }),
    ).rejects.toThrow('cannot be retried');
    await expect(f.service.retry('other-owner', request)).rejects.toThrow(
      'Stale',
    );
  });

  it('claims task-owned auth once and rejects late OAuth after Stop', async () => {
    const f = fixture();
    f.availability.observe(binding, { kind: 'auth_required', identity });
    const receipt = await f.service.activate({ ...input, trigger: 'auth' });
    await flush();
    expect(f.persisted.record?.phase).toBe('awaiting_auth');
    expect(f.host.dispatch).not.toHaveBeenCalled();
    ready(f.availability);
    const claim = { binding, attemptId: receipt.attemptId, identity };
    expect(
      await f.service.resumeAfterAuth(
        'owner',
        binding.scope,
        receipt.activationId,
      ),
    ).toBe(false);
    for (const stale of [
      { ...claim, identity: { ...identity, configId: 'wrong-config' } },
      { ...claim, attemptId: 'other-attempt' },
      { ...claim, binding: { ...binding, generation: 0 } },
      { ...claim, binding: { ...binding, ownerId: 'other-owner' } },
      { ...claim, binding: { ...binding, provider: 'codex' as const } },
      { ...claim, binding: { ...binding, sessionId: 'other-session' } },
      {
        ...claim,
        binding: {
          ...binding,
          scope: { ...binding.scope, chatId: 'other-chat' },
        },
      },
    ]) {
      expect(
        await f.service.resumeAfterAuth(
          'owner',
          binding.scope,
          receipt.activationId,
          stale,
        ),
      ).toBe(false);
      expect(f.persisted.record?.phase).toBe('awaiting_auth');
    }
    expect(
      await Promise.all([
        f.service.resumeAfterAuth(
          'owner',
          binding.scope,
          receipt.activationId,
          claim,
        ),
        f.service.resumeAfterAuth(
          'owner',
          binding.scope,
          receipt.activationId,
          claim,
        ),
      ]),
    ).toEqual([true, false]);
    await flush();
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    await f.service.cancel(binding.scope);
    expect(
      await f.service.resumeAfterAuth(
        'owner',
        binding.scope,
        receipt.activationId,
        claim,
      ),
    ).toBe(false);
  });

  it('adopts the committed credential generation without accepting stale auth claims', async () => {
    const f = fixture();
    f.availability.observe(binding, { kind: 'auth_required', identity });
    const receipt = await f.service.activate({ ...input, trigger: 'auth' });
    await flush();
    const refreshedBinding = { ...binding, generation: 2 };
    f.availability.begin(refreshedBinding, [
      {
        identity,
        selected: true,
        enabled: true,
        permitted: true,
        authRequirement: 'required',
      },
    ]);
    f.availability.observe(refreshedBinding, {
      kind: 'tools',
      identity,
      initialized: true,
      complete: true,
      toolCount: 1,
    });
    f.host.prepare.mockResolvedValue(refreshedBinding);
    f.host.isCurrent.mockImplementation((_scope, record) =>
      Promise.resolve(record.desiredGeneration === 2),
    );
    const claim = {
      binding,
      attemptId: receipt.attemptId,
      identity,
      refreshedBinding,
    };
    for (const stale of [
      { ...claim, binding: refreshedBinding },
      {
        ...claim,
        refreshedBinding: { ...refreshedBinding, sessionId: 'other' },
      },
      { ...claim, refreshedBinding: { ...refreshedBinding, ownerId: 'other' } },
      { ...claim, refreshedBinding: { ...refreshedBinding, generation: 0 } },
      { ...claim, refreshedBinding: { ...refreshedBinding, generation: 3 } },
    ]) {
      expect(
        await f.service.resumeAfterAuth(
          'owner',
          binding.scope,
          receipt.activationId,
          stale,
        ),
      ).toBe(false);
      expect(f.persisted.record?.phase).toBe('awaiting_auth');
      expect(f.persisted.record?.desiredGeneration).toBe(1);
    }
    expect(
      await Promise.all([
        f.service.resumeAfterAuth(
          'owner',
          binding.scope,
          receipt.activationId,
          claim,
        ),
        f.service.resumeAfterAuth(
          'owner',
          binding.scope,
          receipt.activationId,
          claim,
        ),
      ]),
    ).toEqual([true, false]);
    await flush();
    expect(f.persisted.record).toMatchObject({
      phase: 'completed',
      desiredGeneration: 2,
      admission: 'accepted',
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each<McpCapabilityIdentity>([
    {
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName: 'plugin',
      serverName: 'calendar',
    },
    { kind: 'account', connectionId: 'account', configId: 'calendar' },
  ])('binds auth recovery to the full $kind identity', async (target) => {
    const f = fixture();
    f.availability.clear(binding);
    f.availability.begin(binding, [
      {
        identity: target,
        selected: true,
        enabled: true,
        permitted: true,
        authRequirement: 'required',
      },
    ]);
    f.availability.observe(binding, {
      kind: 'auth_required',
      identity: target,
    });
    const original = await f.service.activate({
      ...input,
      trigger: 'auth',
      targets: [target],
    });
    await flush();
    const wrong: McpCapabilityIdentity =
      target.kind === 'plugin'
        ? { ...target, marketplaceId: 'other-market' }
        : {
            kind: 'account',
            connectionId: 'other-account',
            configId: 'calendar',
          };
    expect(
      await f.service.resumeAfterAuth(
        'owner',
        binding.scope,
        original.activationId,
        {
          binding,
          attemptId: original.attemptId,
          identity: wrong,
        },
      ),
    ).toBe(false);
    expect(f.persisted.record?.phase).toBe('awaiting_auth');
    f.availability.observe(binding, {
      kind: 'tools',
      identity: target,
      initialized: true,
      complete: true,
      toolCount: 1,
    });
    expect(
      await f.service.resumeAfterAuth(
        'owner',
        binding.scope,
        original.activationId,
        {
          binding,
          attemptId: original.attemptId,
          identity: target,
        },
      ),
    ).toBe(true);
    await flush();
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it('Stop during preparation invalidates late setup without dispatch', async () => {
    const f = fixture();
    let release: ((binding: McpSessionBinding) => void) | undefined;
    f.host.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    ready(f.availability);
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    await f.service.cancel(binding.scope);
    release?.(binding);
    await flush();
    expect(f.persisted.record?.phase).toBe('cancelled');
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });

  it('Stop after dispatch cancels the provider and never reports completion for its late reply', async () => {
    const f = fixture();
    let accept: (() => void) | undefined;
    f.host.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = (): void => resolve('accepted');
        }),
    );
    ready(f.availability);
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    await f.service.cancel(binding.scope);
    accept?.();
    await flush();
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(f.persisted.record).toMatchObject({
      phase: 'cancelled',
      admission: 'uncertain',
    });
  });

  it.each(['accepted', 'not_sent', 'uncertain'] as const)(
    'reconciles cancelled admission as %s without replaying the cancelled task',
    async (admission) => {
      const f = fixture();
      let accept: (() => void) | undefined;
      f.host.dispatch.mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = (): void => resolve('accepted');
          }),
      );
      ready(f.availability);
      await f.service.activate({ ...input, trigger: 'selection' });
      await flush();
      await f.service.cancel(binding.scope);
      accept?.();
      await flush();
      expect(f.host.stop).toHaveBeenCalledTimes(1);
      f.host.reconcile.mockResolvedValue(admission);
      const restarted = new McpActivationService(
        f.store,
        f.availability,
        f.host,
      );
      await restarted.recover(binding.scope);
      expect(f.host.reconcile).toHaveBeenCalledTimes(1);
      expect(f.persisted.record).toMatchObject({
        phase: 'cancelled',
        cancelled: true,
        admission,
        retryEligible: false,
      });
      expect(f.host.dispatch).toHaveBeenCalledTimes(1);
      const next = {
        ...input,
        originatingMessageId: 'next-message',
        toolCallId: 'next-tool',
      };
      if (admission === 'uncertain') {
        await expect(restarted.activate(next)).rejects.toThrow(
          'Activation recovery is pending',
        );
      } else {
        const nextReceipt = await restarted.activate(next);
        expect(typeof nextReceipt.activationId).toBe('string');
        expect(nextReceipt.generation).toBe(1);
        await restarted.cancel(binding.scope);
      }
    },
  );

  it('persists cancellation before a failing provider Stop and ignores late admission', async () => {
    const f = fixture();
    let accept: (() => void) | undefined;
    f.host.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = (): void => resolve('accepted');
        }),
    );
    f.host.stop.mockImplementation(() => {
      expect(f.persisted.record).toMatchObject({
        phase: 'cancelled',
        cancelled: true,
      });
      return Promise.reject(new Error('Provider stop failed'));
    });
    ready(f.availability);
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    await expect(f.service.cancel(binding.scope)).rejects.toThrow(
      'Provider stop failed',
    );
    accept?.();
    await flush();
    expect(f.persisted.record).toMatchObject({
      phase: 'cancelled',
      admission: 'uncertain',
      retryEligible: false,
    });
  });

  it('retries a failed provider Stop and shares completion until it succeeds', async () => {
    const f = fixture();
    let accept: (() => void) | undefined;
    let finishStop: (() => void) | undefined;
    f.host.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = (): void => resolve('accepted');
        }),
    );
    f.host.stop
      .mockRejectedValueOnce(new Error('Provider stop failed'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      );
    ready(f.availability);
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    await expect(f.service.cancel(binding.scope)).rejects.toThrow(
      'Provider stop failed',
    );
    let settled = 0;
    const retry = f.service.cancel(binding.scope).then(() => {
      settled++;
    });
    const concurrent = f.service.cancel(binding.scope).then(() => {
      settled++;
    });
    try {
      await flush();
      expect(f.host.stop).toHaveBeenCalledTimes(2);
      expect(settled).toBe(0);
    } finally {
      finishStop?.();
      await Promise.all([retry, concurrent]);
      accept?.();
      await flush();
    }
    expect(settled).toBe(2);
    expect(f.persisted.record).toMatchObject({
      phase: 'cancelled',
      admission: 'uncertain',
      retryEligible: false,
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    await f.service.cancel(binding.scope);
    expect(f.host.stop).toHaveBeenCalledTimes(2);
  });

  it('blocks a new activation until a failed provider Stop succeeds after reconciliation', async () => {
    const f = fixture();
    let accept: (() => void) | undefined;
    f.host.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = (): void => resolve('accepted');
        }),
    );
    f.host.stop.mockRejectedValueOnce(new Error('Provider stop failed'));
    ready(f.availability);
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    await expect(f.service.cancel(binding.scope)).rejects.toThrow(
      'Provider stop failed',
    );
    f.host.reconcile.mockResolvedValue('accepted');
    await f.service.recover(binding.scope);
    const next = {
      ...input,
      originatingMessageId: 'next-message',
      toolCallId: 'next-tool',
    };
    try {
      await expect(f.service.activate(next)).rejects.toThrow(
        'Activation cancellation is pending',
      );
      expect(f.host.dispatch).toHaveBeenCalledTimes(1);
      await f.service.cancel(binding.scope);
      expect(f.host.stop).toHaveBeenCalledTimes(2);
      const receipt = await f.service.activate(next);
      expect(typeof receipt.activationId).toBe('string');
    } finally {
      await f.service.cancel(binding.scope);
      accept?.();
      await flush();
    }
  });

  it.each(['accepted', 'not_sent'] as const)(
    'retains failed Stop after expiry when reconciliation reports %s',
    async (admission) => {
      const f = fixture(2000);
      const timers = jest.spyOn(global, 'setTimeout');
      let accept: (() => void) | undefined;
      f.host.dispatch.mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = (): void => resolve('accepted');
          }),
      );
      f.host.stop.mockRejectedValueOnce(new Error('Provider stop failed'));
      ready(f.availability);
      try {
        await f.service.activate({ ...input, trigger: 'selection' });
        await flush();
        const timeout = timers.mock.calls.find(
          ([, delay]) => delay === 2000,
        )?.[0];
        if (typeof timeout !== 'function')
          throw new Error('missing activation expiry');
        timeout();
        await flush();
        expect(f.host.stop).toHaveBeenCalledTimes(1);
        expect(f.persisted.record).toMatchObject({
          phase: 'failed',
          admission: 'uncertain',
          failureCode: 'admission_uncertain',
          retryEligible: false,
        });
        accept?.();
        await flush();
        expect(f.persisted.record?.admission).toBe('uncertain');
        f.host.reconcile.mockResolvedValue(admission);
        await f.service.recover(binding.scope);
        const next = {
          ...input,
          originatingMessageId: 'next-message',
          toolCallId: 'next-tool',
        };
        await expect(f.service.activate(next)).rejects.toThrow(
          'Activation cancellation is pending',
        );
        expect(f.host.dispatch).toHaveBeenCalledTimes(1);
        await f.service.cancel(binding.scope);
        expect(f.host.stop).toHaveBeenCalledTimes(2);
        await f.service.cancel(binding.scope);
        expect(f.host.stop).toHaveBeenCalledTimes(2);
        const receipt = await f.service.activate(next);
        expect(typeof receipt.activationId).toBe('string');
      } finally {
        await f.service.cancel(binding.scope);
        accept?.();
        jest.restoreAllMocks();
      }
    },
  );

  it('joins an in-flight Stop after expiry before cancellation settles', async () => {
    const f = fixture(2000);
    const timers = jest.spyOn(global, 'setTimeout');
    let accept: (() => void) | undefined;
    let finishStop: (() => void) | undefined;
    f.host.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = (): void => resolve('accepted');
        }),
    );
    f.host.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    ready(f.availability);
    try {
      await f.service.activate({ ...input, trigger: 'selection' });
      await flush();
      const timeout = timers.mock.calls.find(
        ([, delay]) => delay === 2000,
      )?.[0];
      if (typeof timeout !== 'function')
        throw new Error('missing activation expiry');
      timeout();
      await flush();
      expect(f.host.stop).toHaveBeenCalledTimes(1);
      f.host.reconcile.mockResolvedValue('accepted');
      await f.service.recover(binding.scope);
      let cancelled = false;
      const cancellation = f.service.cancel(binding.scope).then(() => {
        cancelled = true;
      });
      await flush();
      expect(cancelled).toBe(false);
      expect(f.host.stop).toHaveBeenCalledTimes(1);
      await expect(
        f.service.activate({
          ...input,
          originatingMessageId: 'next-message',
          toolCallId: 'next-tool',
        }),
      ).rejects.toThrow('Activation cancellation is pending');
      finishStop?.();
      await cancellation;
      expect(cancelled).toBe(true);
      expect(f.host.stop).toHaveBeenCalledTimes(1);
      expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      finishStop?.();
      accept?.();
      await f.service.cancel(binding.scope);
      jest.restoreAllMocks();
    }
  });

  it('bounds missing result delivery and never uses retry to bypass its gate', async () => {
    const f = fixture(1000, 5);
    const receipt = await f.service.activate(input);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.persisted.record).toMatchObject({
      phase: 'failed',
      failureCode: 'result_delivery_failed',
      retryEligible: false,
    });
    expect(f.service.deliverResult(binding, receipt.activationId, 'tool')).toBe(
      false,
    );
    expect(f.host.prepare).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'connecting'],
    [2, 'connecting'],
    [1, 'awaiting_auth'],
    [2, 'resuming'],
  ] as const)(
    'ignores an expiry read from the replaced auth run at generation %s in %s',
    async (generation, phase) => {
      const f = fixture(2000);
      const timers = jest.spyOn(global, 'setTimeout');
      let releaseRead: (() => void) | undefined;
      let readStarted: (() => void) | undefined;
      const pendingRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      try {
        const original = await f.service.activate({
          ...input,
          trigger: 'auth',
        });
        await flush();
        expect(f.persisted.record?.phase).toBe('connecting');
        const timeout = timers.mock.calls.find(
          ([, delay]) => delay === 2000,
        )?.[0];
        if (typeof timeout !== 'function')
          throw new Error('missing activation expiry');
        jest.spyOn(f.store, 'read').mockImplementationOnce(async () => {
          readStarted?.();
          await pendingRead;
          return structuredClone(f.persisted.record);
        });
        timeout();
        await reading;
        const refreshedBinding = { ...binding, generation };
        f.availability.begin(refreshedBinding, [
          {
            identity,
            selected: true,
            enabled: true,
            permitted: true,
            authRequirement: 'required',
          },
        ]);
        if (phase === 'awaiting_auth')
          f.availability.observe(refreshedBinding, {
            kind: 'auth_required',
            identity,
          });
        if (phase === 'resuming') {
          f.availability.observe(refreshedBinding, {
            kind: 'tools',
            identity,
            initialized: true,
            complete: true,
            toolCount: 1,
          });
          f.host.dispatch.mockImplementation(
            (_scope, _record, _instruction, signal) =>
              new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve('uncertain'), {
                  once: true,
                });
              }),
          );
        }
        f.host.prepare.mockResolvedValue(refreshedBinding);
        expect(
          await f.service.resumeAfterAuth(
            'owner',
            binding.scope,
            original.activationId,
            {
              binding,
              attemptId: original.attemptId,
              identity,
              refreshedBinding,
            },
          ),
        ).toBe(true);
        await flush();
        expect(f.persisted.record).toMatchObject({
          phase,
          desiredGeneration: generation,
        });
        releaseRead?.();
        await flush();
        expect(f.persisted.record).toMatchObject({
          phase,
          desiredGeneration: generation,
        });
        expect(f.host.stop).not.toHaveBeenCalled();
      } finally {
        releaseRead?.();
        await f.service.cancel(binding.scope);
        jest.restoreAllMocks();
      }
    },
  );

  it('terminalizes a timed-out attempt after an in-flight phase commit settles', async () => {
    const f = fixture(20);
    let releaseWrite: (() => void) | undefined;
    const writeSettled = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    jest
      .spyOn(f.store, 'compareAndSet')
      .mockImplementation(async (_scope, expected, next) => {
        if (JSON.stringify(f.persisted.record) !== JSON.stringify(expected))
          return false;
        f.persisted.record = structuredClone(next);
        if (next.phase === 'connecting') await writeSettled;
        return true;
      });
    ready(f.availability);
    await f.service.activate({ ...input, trigger: 'selection' });
    await flush();
    expect(f.persisted.record?.phase).toBe('connecting');
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseWrite?.();
    await flush();
    expect(f.persisted.record).toMatchObject({
      phase: 'failed',
      failureCode: 'timeout',
      admission: 'not_sent',
      retryEligible: true,
    });
    expect(f.host.dispatch).not.toHaveBeenCalled();
    await f.service.activate({ ...input, toolCallId: 'next-load' });
    await f.service.cancel(binding.scope);
  });
});
